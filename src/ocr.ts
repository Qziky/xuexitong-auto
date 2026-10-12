import { createWorker, PSM, type Worker } from 'tesseract.js';
import {
  DEFAULT_RECOGNITION,
  type PageSnapshot,
  type ProviderConfig,
  type RecognitionAttempt,
  type RecognitionSettings,
  type RecognitionTrace,
} from './domain';
import { hashText, safePageUrl } from './security';
import {
  comparableText,
  recognitionEngines,
  validateRecognitionMarkers,
  type RecognitionMarkerContext,
} from './recognition-settings';
import { transcribeSegments, resetVisionCapability } from './vision';
import type { VisionScope } from './vision';
import { ProviderError } from './provider';
import type { ProgressSink } from './progress';
import { placeholdersPreserved, stripImageResources } from './image-content';
import { restoreQuestionImages } from './image-recognition';

import { ResourcePool, type ResourceLease, boundedMap } from './resource-pool';
import {
  recognitionCache,
  contentDigest,
  loadRecognitionCache,
  flushRecognitionCache,
} from './recognition-cache';
import { PlatformAccessError, platformBlockFor } from './platform-access';

let workerPool: ResourcePool<Worker> | undefined;
function pool(assetBase: string): ResourcePool<Worker> {
  return (workerPool ??= new ResourcePool(
    (navigator.hardwareConcurrency || 4) <= 2 ? 1 : 2,
    () =>
      createWorker(['chi_sim', 'eng'], 1, {
        workerPath: assetBase + '/worker.min.js',
        corePath: assetBase + '/core',
        langPath: assetBase + '/lang',
        workerBlobURL: false,
        gzip: true,
      }),
    (worker) => worker.terminate(),
  ));
}
export async function warmOcr(
  assetBase: string,
  signal?: AbortSignal,
): Promise<void> {
  const lease = await pool(assetBase).acquire(signal);
  lease.release();
}
async function withOcrWorker<T>(
  assetBase: string,
  signal: AbortSignal | undefined,
  pulse: ProgressSink | undefined,
  work: (worker: Worker) => Promise<T>,
): Promise<T> {
  checkCancelled(signal);
  pulse?.('等待本地 OCR 工作槽', { code: 'ocr-queued', waiting: 'model-lane' });
  let lease: ResourceLease<Worker> | undefined;
  try {
    lease = await pool(assetBase).acquire(signal);
    checkCancelled(signal);
    return await waitAbortable(work(lease.value), signal, () =>
      lease?.invalidate(),
    );
  } finally {
    lease?.release();
  }
}
export function fontSource(css: string, base: string): string {
  const face = css.match(
    /@font-face\s*\{[^}]*font-family\s*:\s*['"]?font-cxsecret['"]?[^}]*\}/i,
  )?.[0];
  const src = face?.match(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/i)?.[1];
  if (!src) throw new Error('页面未提供混淆字体资源');
  if (
    /^data:(?:application\/(?:font-ttf|x-font-ttf|octet-stream)|font\/(?:ttf|woff2?|otf));/i.test(
      src,
    ) &&
    src.length < 4000000
  )
    return src;
  const url = safePageUrl(src, base);
  if (!url) throw new Error('字体资源地址无法验证');
  return url;
}
const wrappedLineCache = new Map<string, string[]>();
function wrapLines(text: string, family: string, size: number): string[] {
  const key = `${family}:${size}:${text}`;
  const cached = wrappedLineCache.get(key);
  if (cached) return cached;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) throw new Error('无法创建文字画布');
  ctx.font = `${size}px "${family}", Arial, sans-serif`;
  const lines: string[] = [];
  let line = '';
  const chunks = (text.match(/_+|[a-z0-9]+|[\s\S]/gi) ?? []).flatMap((token) =>
    ctx.measureText(token).width > 1150 ? [...token] : [token],
  );
  for (const char of chunks) {
    if (char === '\n' || (line && ctx.measureText(line + char).width > 1150)) {
      lines.push(line);
      line = char === '\n' ? '' : char;
    } else line += char;
  }
  lines.push(line);
  if (wrappedLineCache.size >= 512)
    wrappedLineCache.delete(wrappedLineCache.keys().next().value!);
  wrappedLineCache.set(key, lines);
  return lines;
}
export function renderText(
  text: string,
  family: string,
  size: number,
  lines = wrapLines(text, family, size),
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建文字画布');
  ctx.font = `${size}px "${family}", Arial, sans-serif`;
  canvas.width = Math.max(
    100,
    Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width), 0)) + 60,
  );
  canvas.height = lines.length * Math.ceil(size * 1.6) + 50;
  canvas.dataset.lines = String(lines.length);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${size}px "${family}", Arial, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#000';
  lines.forEach((line, i) =>
    ctx.fillText(line, 30, 25 + i * Math.ceil(size * 1.6)),
  );
  return canvas;
}
function renderPair(
  text: string,
  family: string,
): [HTMLCanvasElement, HTMLCanvasElement] {
  // Use the larger size to choose one set of line breaks for both images.
  const lines = wrapLines(text, family, 54);
  return [
    renderText(text, family, 42, lines),
    renderText(text, family, 54, lines),
  ];
}
function sameRendering(
  left: HTMLCanvasElement,
  right: HTMLCanvasElement,
): boolean {
  if (left.width !== right.width || left.height !== right.height) return false;
  try {
    const a = left
      .getContext('2d')
      ?.getImageData(0, 0, left.width, left.height).data;
    const b = right
      .getContext('2d')
      ?.getImageData(0, 0, right.width, right.height).data;
    if (!a?.length || !b || a.length !== b.length) return false;
    let ink = false;
    for (let i = 0; i < a.length; i += 4) {
      if (
        a[i] !== b[i] ||
        a[i + 1] !== b[i + 1] ||
        a[i + 2] !== b[i + 2] ||
        a[i + 3] !== b[i + 3]
      )
        return false;
      if (a[i + 3] === 255 && a[i]! < 128 && a[i + 1]! < 128 && a[i + 2]! < 128)
        ink = true;
    }
    return ink;
  } catch {
    return false;
  }
}
function unchanged(text: string, family: string): boolean {
  if (!text.trim() || text.length > 6000) return false;
  const [small, large] = renderPair(text, family);
  const [plainSmall, plainLarge] = renderPair(text, 'Arial');
  try {
    return sameRendering(small, plainSmall) && sameRendering(large, plainLarge);
  } finally {
    for (const canvas of [small, large, plainSmall, plainLarge])
      canvas.width = canvas.height = 0;
  }
}
function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderError('文字识别已取消', 'cancelled');
}
async function waitAbortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  cancel?: () => void,
): Promise<T> {
  checkCancelled(signal);
  let abort!: () => void;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => {
        cancel?.();
        reject(new ProviderError('文字识别已取消', 'cancelled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject);
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
interface RecognizedText {
  text: string;
  confidence: number;
  reliable: boolean;
  reviewReason?: string;
  engine: 'web' | 'ocr';
  readings: { text: string; confidence: number }[];
}
export async function recognizeText(
  text: string,
  family: string,
  assetBase: string,
  pulse?: ProgressSink,
  validate = true,
  signal?: AbortSignal,
  webCheckComplete = false,
  markerContext?: RecognitionMarkerContext,
): Promise<RecognizedText> {
  checkCancelled(signal);
  if (!text.trim() || text.length > 6000) throw new Error('混淆文字为空或过长');
  if (!webCheckComplete && unchanged(text, family))
    return {
      text,
      confidence: 100,
      reliable: true,
      engine: 'web',
      readings: [],
    };
  return withOcrWorker(assetBase, signal, pulse, async (worker) => {
    const canvases = renderPair(text, family);
    const readings: RecognizedText['readings'] = [];
    try {
      for (const [index, canvas] of (validate
        ? canvases
        : canvases.slice(0, 1)
      ).entries()) {
        checkCancelled(signal);
        const started = Date.now();
        pulse?.(
          'OCR 第 ' + (index + 1) + '/' + (validate ? 2 : 1) + ' 次识别',
          {
            code: 'ocr-attempt',
            attempt: index + 1,
            waiting: undefined,
          },
        );
        await worker.setParameters({
          tessedit_pageseg_mode:
            canvas.dataset.lines === '1' ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK,
        });
        const data = (await worker.recognize(canvas)).data;
        readings.push({ text: data.text.trim(), confidence: data.confidence });
        pulse?.('OCR 完成，置信度 ' + Math.round(data.confidence), {
          code: 'ocr-reading',
          confidence: data.confidence,
          attempt: index + 1,
          durationMs: Date.now() - started,
        });
      }
      checkCancelled(signal);
      const first = readings[0]!;
      const confidence = Math.min(...readings.map((r) => r.confidence));
      const markerFailure = validate
        ? readings
            .map((r) => validateRecognitionMarkers(text, r.text, markerContext))
            .find((r) => !r.valid)
        : undefined;
      const corroborated =
        validate &&
        /^[\x20-\x7e\r\n\t]+$/.test(text) &&
        confidence >= 85 &&
        readings.every(
          (r) =>
            comparableText(r.text, markerContext) ===
            comparableText(text, markerContext),
        );
      const reason = readings.some((r) => !r.text)
        ? '未识别到文字'
        : markerFailure?.reason
          ? markerFailure.reason
          : validate &&
              comparableText(first.text, markerContext) !==
                comparableText(readings[1]!.text, markerContext)
            ? '两次识别结果不同'
            : validate && !Number.isFinite(confidence)
              ? '置信度无法确认'
              : validate && confidence < 90 && !corroborated
                ? '置信度 ' + Math.round(confidence) + '，低于 90'
                : undefined;
      return {
        text: (corroborated ? text : first.text).replace(
          /([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g,
          '$1',
        ),
        confidence,
        reliable: !reason,
        reviewReason: reason,
        engine: 'ocr',
        readings,
      };
    } finally {
      for (const canvas of canvases) canvas.width = canvas.height = 0;
    }
  });
}
interface Segment {
  id: string;
  text: string;
  label: string;
  questionNumber: number;
  part: string;
  markerContext: RecognitionMarkerContext;
  trace: RecognitionTrace;
  set(text: string): void;
  issue(reason: string): void;
}
async function restoreTextSnapshot(
  raw: PageSnapshot,
  assetBase: string,
  signal?: AbortSignal,
  pulse?: ProgressSink,
  settings: RecognitionSettings = DEFAULT_RECOGNITION,
  visionProvider?: ProviderConfig,
  scope?: VisionScope,
): Promise<PageSnapshot> {
  const page = structuredClone(raw);
  const segments: Segment[] = [];
  for (const question of page.questions) {
    const web = (): RecognitionTrace => ({
      source: 'web',
      attempts: [{ engine: 'web', success: true }],
    });
    question.recognition = {
      stem: web(),
      options: Object.fromEntries(question.options.map((o) => [o.id, web()])),
    };
    if (question.obfuscated) {
      const trace: RecognitionTrace = { attempts: [] };
      question.recognition.stem = trace;
      segments.push({
        id: `f${segments.length + 1}`,
        text: question.stem,
        label: `第 ${question.number} 题题干`,
        questionNumber: question.number,
        part: '题干',
        markerContext: {
          questionType: question.type,
          part: 'stem',
          blankCount: question.blanks.length,
        },
        trace,
        set: (text) => {
          question.stem = text;
        },
        issue: (reason) =>
          question.issues.push(`题干文字识别需检查（${reason}）`),
      });
    }
    for (const option of question.options.filter((o) => o.obfuscated)) {
      const trace: RecognitionTrace = { attempts: [] };
      question.recognition.options[option.id] = trace;
      segments.push({
        id: `f${segments.length + 1}`,
        text: option.text,
        label: `第 ${question.number} 题选项 ${option.label}`,
        questionNumber: question.number,
        part: `选项 ${option.label}`,
        markerContext: { questionType: question.type, part: 'option' },
        trace,
        set: (text) => {
          option.text = text;
        },
        issue: (reason) =>
          question.issues.push(
            `选项 ${option.label} 文字识别需检查（${reason}）`,
          ),
      });
    }
  }
  let face: FontFace | undefined;
  try {
    checkCancelled(signal);
    if (!segments.length) {
      pulse?.('题目为网页明文，无需文字还原', {
        code: 'plain-text',
        done: 0,
        total: 0,
      });
      return page;
    }
    pulse?.(`发现 ${segments.length} 个可能混淆的文字片段`, {
      code: 'recognition-start',
      done: 0,
      total: segments.length,
    });
    let family: string;
    try {
      const src = fontSource(page.fontCss ?? '', page.url);
      let source: string | ArrayBuffer = src;
      let fingerprint = src;
      if (!src.startsWith('data:')) {
        const response = await fetch(src, {
          signal,
          credentials: 'include',
          cache: 'force-cache',
          redirect: 'error',
        });
        if (response.status === 429)
          throw new PlatformAccessError(platformBlockFor(src, 'rate-limit'));
        if (
          !response.ok ||
          Number(response.headers.get('Content-Length')) > 4000000
        )
          throw new Error('字体资源读取失败或过大');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 4000000) throw new Error('字体资源过大');
        source = bytes;
        fingerprint = await contentDigest(bytes);
      }
      family = 'cx-' + (await contentDigest(fingerprint));
      face = new FontFace(
        family,
        typeof source === 'string'
          ? 'url(' + JSON.stringify(source) + ')'
          : source,
      );
      await waitAbortable(face.load(), signal);
      checkCancelled(signal);
      document.fonts.add(face);
      await waitAbortable(document.fonts.ready, signal);
      if (!document.fonts.check(`42px "${family}"`))
        throw new Error('字体未加载');
    } catch (error) {
      if (error instanceof PlatformAccessError) throw error;
      checkCancelled(signal);
      for (const question of page.questions.filter(
        (q) => q.obfuscated || q.options.some((o) => o.obfuscated),
      ))
        question.issues.push('混淆字体加载失败，需人工检查');
      for (const segment of segments)
        segment.trace.attempts.push({
          engine: 'web',
          success: false,
          reason: '混淆字体加载失败，无法可靠渲染文字图片',
        });
      return page;
    }
    for (const segment of segments)
      if (unchanged(segment.text, family)) {
        segment.trace.source = 'web';
        segment.trace.attempts.push({ engine: 'web', success: true });
        pulse?.(`${segment.label}已验证为网页原文`, {
          code: 'web-confirmed',
          engine: 'web',
          questionNumber: segment.questionNumber,
          part: segment.part,
        });
      }
    let confirmedSegments = segments.filter((s) => s.trace.source).length;
    let completed = confirmedSegments;
    let active = 0;
    let visionBlocked: string | undefined;
    const engines = recognitionEngines(settings);
    const providerKey = await contentDigest(
      JSON.stringify(visionProvider ?? {}),
    );
    await loadRecognitionCache();
    const pending = segments.filter((s) => !s.trace.source);
    await boundedMap(
      pending,
      Math.min(130, (settings.visionConcurrency || 5) + 2),
      async (segment) => {
        checkCancelled(signal);
        active++;
        const tag =
          (page.accountId ?? '') +
          ':' +
          page.taskKey +
          ':' +
          segment.questionNumber;
        const key = await contentDigest(
          JSON.stringify({
            tag,
            part: segment.part,
            text: segment.text,
            font: family,
            marker: segment.markerContext,
            validate: settings.validateOcr,
            strategy: settings.strategy,
            version: 5,
          }),
        );
        const emit: ProgressSink = (note, detail = {}) =>
          pulse?.(note, {
            ...detail,
            questionNumber: segment.questionNumber,
            part: segment.part,
            done: completed,
            total: segments.length,
            success: confirmedSegments,
            review: completed - confirmedSegments,
            active,
            queued: Math.max(0, segments.length - completed - active),
          });
        try {
          const cachedResult = engines
            .map((engine) => ({
              engine,
              result: recognitionCache.get(
                key +
                  ':' +
                  engine +
                  (engine === 'vision' ? ':' + providerKey : ''),
              ),
            }))
            .find(({ result }) => result);
          if (cachedResult?.result) {
            segment.set(cachedResult.result.text);
            Object.assign(segment.trace, cachedResult.result.trace);
            emit(segment.label + '复用已确认文字', {
              code: 'recognition-cache',
              engine: cachedResult.engine,
            });
            return;
          }
          for (const engine of engines) {
            checkCancelled(signal);
            const cacheKey =
              key +
              ':' +
              engine +
              (engine === 'vision' ? ':' + providerKey : '');
            const cached = recognitionCache.get(cacheKey);
            if (cached) {
              segment.set(cached.text);
              Object.assign(segment.trace, cached.trace);
              emit(segment.label + '复用已确认文字', {
                code: 'recognition-cache',
                engine,
              });
              break;
            }
            let attempt: RecognitionAttempt;
            if (engine === 'ocr') {
              try {
                emit('OCR 识别' + segment.label, {
                  code: 'segment-start',
                  engine,
                });
                const result = await recognizeText(
                  segment.text,
                  family,
                  assetBase,
                  emit,
                  settings.validateOcr,
                  signal,
                  true,
                  segment.markerContext,
                );
                attempt = {
                  engine: result.engine,
                  success: result.reliable,
                  text: result.text,
                  readings: result.readings,
                  reason: result.reviewReason,
                };
              } catch {
                checkCancelled(signal);
                attempt = {
                  engine: 'ocr',
                  success: false,
                  reason: 'OCR 识别异常',
                };
              }
            } else {
              if (!visionProvider?.apiKey.trim())
                visionBlocked = '视觉服务未配置 API Key，请在设置中配置';
              if (visionBlocked)
                attempt = {
                  engine: 'vision',
                  success: false,
                  reason: visionBlocked,
                };
              else {
                try {
                  const results = await transcribeSegments(
                    visionProvider!,
                    [
                      {
                        id: segment.id,
                        questionNumber: segment.questionNumber,
                        part: segment.part,
                        render: () => {
                          const canvas = renderText(segment.text, family, 54);
                          try {
                            return canvas.toDataURL('image/png');
                          } finally {
                            canvas.width = canvas.height = 0;
                          }
                        },
                      },
                    ],
                    signal,
                    emit,
                    settings.visionConcurrency,
                    scope,
                  );
                  if (results.blocked) visionBlocked = results.blocked.message;
                  attempt = results.get(segment.id) ?? {
                    engine: 'vision',
                    success: false,
                    reason: visionBlocked ?? '未返回识别结果',
                  };
                } catch (error) {
                  if (error instanceof PlatformAccessError) throw error;
                  checkCancelled(signal);
                  if (
                    error instanceof ProviderError &&
                    [
                      'auth',
                      'rate',
                      'timeout',
                      'network',
                      'image-unsupported',
                    ].includes(error.code)
                  )
                    visionBlocked = error.message;
                  attempt = {
                    engine: 'vision',
                    success: false,
                    reason:
                      error instanceof Error ? error.message : '视觉识别失败',
                  };
                }
              }
              const validation = attempt.text
                ? validateRecognitionMarkers(
                    segment.text,
                    attempt.text,
                    segment.markerContext,
                  )
                : { valid: false, reason: '视觉识别未返回文字' };
              if (attempt.success && !validation.valid) {
                attempt.success = false;
                attempt.reason =
                  validation.reason === '括号或填空标记与网页不一致'
                    ? '视觉识别的括号或填空标记与网页不一致'
                    : '视觉识别' + (validation.reason ?? '标记与网页不一致');
              }
            }
            if (
              attempt.success &&
              !placeholdersPreserved(segment.text, attempt.text ?? '')
            ) {
              attempt.success = false;
              attempt.reason = '文字转录改变了图片片段的位置或顺序';
            }
            segment.trace.attempts.push(attempt);
            emit(
              attempt.success
                ? segment.label + '已确认'
                : segment.label + '需复核或兜底：' + attempt.reason,
              {
                code: attempt.success
                  ? 'segment-confirmed'
                  : 'recognition-fallback',
                engine,
              },
            );
            if (attempt.success) {
              segment.set(attempt.text!);
              segment.trace.source = attempt.engine;
              recognitionCache.set(cacheKey, attempt.text!, segment.trace, tag);
              break;
            }
          }
          if (segment.trace.source) confirmedSegments++;
        } finally {
          completed++;
          active--;
          emit('文字片段已处理', {
            code: 'segment-complete',
            waiting: undefined,
          });
        }
      },
      signal,
    );
    for (const segment of segments.filter((s) => !s.trace.source))
      segment.issue(
        segment.trace.attempts
          .filter((a) => !a.success)
          .map((a) => a.reason)
          .join('；') || '未确认文字',
      );
    checkCancelled(signal);
    pulse?.('文字识别结束，正在汇总复核结果', {
      code: 'recognition-end',
      done: segments.length,
      total: segments.length,
      success: confirmedSegments,
      review: segments.length - confirmedSegments,
      waiting: undefined,
    });
    return page;
  } finally {
    delete page.fontCss;
    if (face) document.fonts.delete?.(face);
  }
}
export async function recognizeRaster(
  canvas: HTMLCanvasElement,
  assetBase: string,
  validate: boolean,
  signal?: AbortSignal,
  pulse?: ProgressSink,
): Promise<RecognitionAttempt> {
  return withOcrWorker(assetBase, signal, pulse, async (worker) => {
    let alternate: HTMLCanvasElement | undefined;
    const canvases = [canvas];
    if (validate) {
      alternate = document.createElement('canvas');
      alternate.width = Math.max(1, Math.floor(canvas.width * 0.8));
      alternate.height = Math.max(1, Math.floor(canvas.height * 0.8));
      alternate
        .getContext('2d')
        ?.drawImage(canvas, 0, 0, alternate.width, alternate.height);
      canvases.push(alternate);
    }
    try {
      const readings: { text: string; confidence: number }[] = [];
      for (const [i, image] of canvases.entries()) {
        checkCancelled(signal);
        pulse?.('图片 OCR 第 ' + (i + 1) + '/' + canvases.length + ' 次识别', {
          code: 'ocr-attempt',
          attempt: i + 1,
          waiting: undefined,
        });
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
        const { data } = await worker.recognize(image);
        readings.push({ text: data.text.trim(), confidence: data.confidence });
        pulse?.('图片 OCR 完成，置信度 ' + Math.round(data.confidence), {
          code: 'ocr-reading',
          attempt: i + 1,
          confidence: data.confidence,
        });
      }
      checkCancelled(signal);
      const first = readings[0]!;
      const confidence = Math.min(...readings.map((r) => r.confidence));
      const reason = readings.some((r) => !r.text || r.text.length > 12000)
        ? '图片 OCR 结果为空或过长'
        : validate &&
            readings.some(
              (r) => comparableText(r.text) !== comparableText(first.text),
            )
          ? '图片 OCR 两次识别结果不同'
          : validate && (!Number.isFinite(confidence) || confidence < 90)
            ? '图片 OCR 置信度不足（' + Math.round(confidence) + '）'
            : undefined;
      return {
        engine: 'ocr',
        success: !reason,
        text: first.text,
        readings,
        ...(reason ? { reason } : {}),
      };
    } finally {
      if (alternate) alternate.width = alternate.height = 0;
    }
  });
}

export async function restoreSnapshot(
  raw: PageSnapshot,
  assetBase: string,
  signal?: AbortSignal,
  pulse?: ProgressSink,
  settings: RecognitionSettings = DEFAULT_RECOGNITION,
  visionProvider?: ProviderConfig,
  forceQuestionIds?: string[],
): Promise<PageSnapshot> {
  await loadRecognitionCache();
  for (const q of raw.questions)
    if (forceQuestionIds?.includes(q.id))
      recognitionCache.invalidate(
        (raw.accountId ?? '') + ':' + raw.taskKey + ':' + q.number,
      );
  const scope: VisionScope = {};
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const totals = [
    raw.questions.reduce(
      (n, q) =>
        n +
        Number(Boolean(q.obfuscated)) +
        q.options.filter((o) => o.obfuscated).length,
      0,
    ),
    raw.questions.reduce((n, q) => n + (q.images?.length ?? 0), 0),
  ];
  const meters = [
    { done: 0, success: 0, active: 0, queued: totals[0]! },
    { done: 0, success: 0, active: 0, queued: totals[1]! },
  ];
  const report =
    (group: number): ProgressSink =>
    (note, detail = {}) => {
      const meter = meters[group]!;
      for (const key of ['done', 'success', 'active', 'queued'] as const)
        if (detail[key] !== undefined) meter[key] = detail[key]!;
      pulse?.(note, {
        ...detail,
        done: meters.reduce((n, m) => n + m.done, 0),
        total: totals[0]! + totals[1]!,
        success: meters.reduce((n, m) => n + m.success, 0),
        review: meters.reduce((n, m) => n + Math.max(0, m.done - m.success), 0),
        active: meters.reduce((n, m) => n + m.active, 0),
        queued: meters.reduce((n, m) => n + m.queued, 0),
      });
    };
  try {
    const textJob = restoreTextSnapshot(
      raw,
      assetBase,
      controller.signal,
      report(0),
      settings,
      visionProvider,
      scope,
    );
    const imageJob = restoreQuestionImages(
      structuredClone(raw),
      settings,
      visionProvider,
      (canvas, cancel, progress) =>
        recognizeRaster(
          canvas,
          assetBase,
          settings.validateOcr,
          cancel,
          progress,
        ),
      controller.signal,
      report(1),
      scope,
    );
    const guarded = [textJob, imageJob].map((p) =>
      p.catch((error) => {
        cancel();
        throw error;
      }),
    );
    const results = await Promise.allSettled(guarded);
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    checkCancelled(signal);
    const page = (results[0] as PromiseFulfilledResult<PageSnapshot>).value;
    const images = (results[1] as PromiseFulfilledResult<PageSnapshot>).value;
    for (const q of page.questions) {
      if (!q.images?.length) continue;
      const imageQuestion = images.questions.find(
        (candidate) => candidate.id === q.id,
      )!;
      q.recognition!.images = imageQuestion.recognition?.images ?? {};
      q.issues = q.issues.filter(
        (issue) => issue !== '题目文字识别需检查（图片待识别）',
      );
      for (const optionId of [undefined, ...q.options.map((o) => o.id)]) {
        const parts = q.images.filter((image) => image.optionId === optionId);
        if (!parts.length) continue;
        const trace =
          optionId === undefined
            ? q.recognition!.stem
            : q.recognition!.options[optionId]!;
        const original =
          optionId === undefined
            ? q.stem
            : q.options.find((o) => o.id === optionId)!.text;
        let text = original;
        let good = Boolean(trace.source);
        for (const image of parts) {
          const evidence = q.recognition!.images![image.id]!;
          const reading = evidence.attempts.findLast((a) => a.success);
          if (!evidence.source || !reading?.text) {
            good = false;
            const reason =
              evidence.attempts
                .filter((a) => !a.success)
                .map((a) => a.reason)
                .join('；') || '需人工确认';
            q.issues.push(
              (optionId === undefined ? '题干' : '选项') +
                '文字识别需检查（' +
                reason +
                '）',
            );
            if (evidence.attempts.some((a) => a.contentKind === 'unsupported'))
              q.issues.push('图片不是可完整转录的文字或公式，需人工处理');
          } else text = text.replace(image.placeholder, reading.text);
        }
        const engine = parts.some(
          (image) => q.recognition!.images![image.id]?.source === 'vision',
        )
          ? 'vision'
          : 'ocr';
        trace.attempts.push({
          engine,
          success: good,
          text,
          ...(good ? {} : { reason: '文字或图片尚未确认' }),
        });
        trace.source = good ? engine : undefined;
        if (optionId === undefined) q.stem = text;
        else q.options.find((o) => o.id === optionId)!.text = text;
      }
      q.issues = [...new Set(q.issues)];
    }
    stripImageResources(page);
    return page;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await flushRecognitionCache();
  }
}
export async function testVision(
  config: ProviderConfig,
  signal?: AbortSignal,
  pulse?: (text: string) => void,
  concurrency = 5,
): Promise<{ elapsedMs: number }> {
  const expected = '文字测试 2048 ABC';
  const image = renderText(expected, 'Arial', 54).toDataURL('image/png');
  resetVisionCapability(config);
  const start = performance.now();
  const results = await transcribeSegments(
    config,
    [{ id: 'test', image }],
    signal,
    pulse,
    concurrency,
  );
  if (results.blocked) throw results.blocked;
  const attempt = results.get('test');
  if (
    !attempt?.success ||
    attempt.text?.replace(/\s/g, '') !== expected.replace(/\s/g, '')
  )
    throw new Error(
      '视觉接口返回的文字与内置测试图片不一致，请确认模型支持图片',
    );
  return { elapsedMs: Math.round(performance.now() - start) };
}
