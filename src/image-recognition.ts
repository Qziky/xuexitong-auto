import type {
  PageSnapshot,
  ProviderConfig,
  QuestionImage,
  RecognitionAttempt,
  RecognitionSettings,
  RecognitionTrace,
} from './domain';
import { DEFAULT_RECOGNITION } from './domain';
import {
  imagesForPart,
  placeholdersPreserved,
  stripImageResources,
} from './image-content';
import { safePageUrl } from './security';
import { recognitionEngines } from './recognition-settings';
import { transcribeSegments, type VisionScope } from './vision';
import { boundedMap } from './resource-pool';
import {
  recognitionCache,
  contentDigest,
  loadRecognitionCache,
  RecognitionCacheHit,
} from './recognition-cache';
import { ProviderError } from './provider';
import {
  detectVerification,
  platformBlockFor,
  PlatformAccessError,
  retryAfterTime,
} from './platform-access';
import type { ProgressSink } from './progress';

type RasterReader = (
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
  pulse?: ProgressSink,
) => Promise<RecognitionAttempt>;
const MAX_BYTES = 6000000;
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderError('图片识别已取消', 'cancelled');
}

/** Load only a resource actually present in the selected question. No page traversal. */
export async function loadImageCanvas(
  image: QuestionImage,
  base: string,
  signal?: AbortSignal,
): Promise<HTMLCanvasElement> {
  cancelled(signal);
  const src = image.src;
  if (
    !src ||
    !(
      safePageUrl(src, base) ||
      /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(src)
    )
  )
    throw new Error('图片地址缺失或不属于受支持的课程资源');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15000);
  let bitmap: ImageBitmap | undefined;
  try {
    const response = await fetch(src, {
      signal: controller.signal,
      credentials: 'include',
      cache: 'force-cache',
      redirect: 'error',
    });
    cancelled(signal);
    if (response.status === 429)
      throw new PlatformAccessError(
        platformBlockFor(
          src,
          'rate-limit',
          retryAfterTime(response.headers.get('Retry-After')),
        ),
      );
    if (!response.ok) throw new Error('图片资源读取失败，请确认页面图片已加载');
    if (Number(response.headers.get('Content-Length')) > MAX_BYTES)
      throw new Error('图片超过 6 MB 大小限制');
    const type =
      response.headers.get('Content-Type')?.split(';')[0]?.trim() ?? '';
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          cancelled(signal);
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BYTES) {
            await reader.cancel();
            throw new Error('图片超过 6 MB 大小限制');
          }
          chunks.push(new Uint8Array(value));
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_BYTES) throw new Error('图片超过 6 MB 大小限制');
      chunks.push(bytes);
    }
    const blob = new Blob(chunks, { type });
    if (!/^image\/(?:png|jpeg|webp)$/.test(type)) {
      if (/html|text/.test(type)) {
        const block = detectVerification(
          src,
          new DOMParser().parseFromString(await blob.text(), 'text/html'),
        );
        if (block) throw new PlatformAccessError(block);
      }
      throw new Error('资源不是受支持的 PNG、JPEG 或 WebP 图片');
    }
    bitmap = await createImageBitmap(blob);
    cancelled(signal);
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width > 8192 ||
      bitmap.height > 8192 ||
      bitmap.width * bitmap.height > 16000000
    )
      throw new Error('图片尺寸为空或超过 1600 万像素限制');
    // Keep the complete source with padding. Enlarging tiny formula PNGs aids
    // inspection without inventing symbols or cropping superscripts/subscripts.
    const scale = Math.min(
      4,
      Math.max(1, 128 / Math.min(bitmap.width, bitmap.height)),
      8168 / Math.max(bitmap.width, bitmap.height),
      Math.sqrt(15000000 / (bitmap.width * bitmap.height)),
    );
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(bitmap.width * scale) + 24;
    canvas.height = Math.ceil(bitmap.height * scale) + 24;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建图片识别画布');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 12, 12, canvas.width - 24, canvas.height - 24);
    canvas.dataset.contentDigest = await contentDigest(
      await blob.arrayBuffer(),
    );
    return canvas;
  } catch (error) {
    if (error instanceof PlatformAccessError) throw error;
    cancelled(signal);
    if (controller.signal.aborted) throw new Error('图片加载超时（15 秒）');
    throw new Error(
      error instanceof Error && !/fetch|network|https?:/i.test(error.message)
        ? error.message
        : '图片加载失败，请确认页面图片可见后重新解密',
    );
  } finally {
    bitmap?.close();
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function restoreQuestionImages(
  page: PageSnapshot,
  settings: RecognitionSettings,
  provider: ProviderConfig | undefined,
  raster: RasterReader,
  signal?: AbortSignal,
  pulse?: ProgressSink,
  scope?: VisionScope,
): Promise<PageSnapshot> {
  const entries = page.questions.flatMap((question) =>
    (question.images ?? []).map((image) => ({ question, image })),
  );
  if (!entries.length) return page;
  const traces = new Map<string, RecognitionTrace>();
  for (const { question, image } of entries) {
    question.recognition ??= {
      stem: { source: 'web', attempts: [] },
      options: Object.fromEntries(
        question.options.map((o) => [o.id, { source: 'web', attempts: [] }]),
      ),
    };
    const trace: RecognitionTrace = { attempts: [] };
    (question.recognition.images ??= {})[image.id] = trace;
    traces.set(image.id, trace);
  }
  const strategy =
    settings.imageStrategy ??
    DEFAULT_RECOGNITION.imageStrategy ??
    'vision-first';
  const engines =
    strategy === 'manual' ? [] : recognitionEngines({ ...settings, strategy });
  pulse?.(`发现 ${entries.length} 个题目图片片段`, {
    code: 'image-recognition-start',
    total: entries.length,
    done: 0,
  });
  try {
    await loadRecognitionCache();
    let completed = 0;
    let success = 0;
    let active = 0;
    const providerKey = await contentDigest(JSON.stringify(provider ?? {}));
    await boundedMap(
      entries,
      Math.min(130, (settings.visionConcurrency || 5) + 2),
      async ({ question, image }) => {
        cancelled(signal);
        active++;
        const trace = traces.get(image.id)!;
        const progress: ProgressSink = (note, detail = {}) =>
          pulse?.(note, {
            ...detail,
            questionNumber: question.number,
            part: image.part,
            done: completed,
            total: entries.length,
            success,
            review: completed - success,
            active,
            queued: Math.max(0, entries.length - completed - active),
          });
        try {
          for (const engine of engines) {
            cancelled(signal);
            if (
              trace.source ||
              trace.attempts.some((a) => a.contentKind === 'unsupported')
            )
              break;
            let attempt: RecognitionAttempt;
            try {
              if (engine === 'vision') {
                let cacheKey: string | undefined;
                const results = provider?.apiKey.trim()
                  ? await transcribeSegments(
                      provider,
                      [
                        {
                          id: image.id,
                          originalImage: true,
                          questionNumber: question.number,
                          part: image.optionId
                            ? '选项图片 ' + image.optionId
                            : '题干图片',
                          render: async (renderSignal) => {
                            progress('正在读取题目图片', {
                              code: 'image-loading',
                              engine,
                            });
                            const canvas = await loadImageCanvas(
                              image,
                              page.url,
                              renderSignal ?? signal,
                            );
                            try {
                              const tag =
                                (page.accountId ?? '') +
                                ':' +
                                page.taskKey +
                                ':' +
                                question.number;
                              cacheKey = await contentDigest(
                                JSON.stringify({
                                  tag,
                                  part: image.id,
                                  content: canvas.dataset.contentDigest,
                                  provider: providerKey,
                                  strategy,
                                  validate: settings.validateOcr,
                                  version: 5,
                                }),
                              );
                              const cached = recognitionCache.get(cacheKey);
                              if (cached)
                                throw new RecognitionCacheHit(
                                  cached.trace.attempts.findLast(
                                    (a) => a.success,
                                  )!,
                                );
                              return canvas.toDataURL('image/png');
                            } finally {
                              canvas.width = canvas.height = 0;
                            }
                          },
                          onResult: (result) => {
                            if (result.success && cacheKey)
                              recognitionCache.set(
                                cacheKey,
                                result.text!,
                                { source: 'vision', attempts: [result] },
                                (page.accountId ?? '') +
                                  ':' +
                                  page.taskKey +
                                  ':' +
                                  question.number,
                              );
                          },
                        },
                      ],
                      signal,
                      progress,
                      settings.visionConcurrency,
                      scope,
                    )
                  : new Map<string, RecognitionAttempt>();
                attempt = results.get(image.id) ?? {
                  engine: 'vision',
                  success: false,
                  reason: '视觉服务未配置 API Key，请在设置中配置',
                };
              } else {
                const knownText = trace.attempts.some(
                  (a) => a.contentKind === 'text',
                );
                let canvas: HTMLCanvasElement | undefined;
                try {
                  canvas = await loadImageCanvas(image, page.url, signal);
                  attempt = await raster(canvas, signal, progress);
                  if (attempt.success && !knownText)
                    attempt = {
                      ...attempt,
                      success: false,
                      reason:
                        '图片 OCR 仅提供转录预览；请人工确认文字及数学结构',
                    };
                } finally {
                  if (canvas) canvas.width = canvas.height = 0;
                }
              }
            } catch (error) {
              if (error instanceof PlatformAccessError) throw error;
              cancelled(signal);
              attempt = {
                engine,
                success: false,
                reason: error instanceof Error ? error.message : '识别异常',
              };
            }
            trace.attempts.push(attempt);
            if (attempt.success) trace.source = engine;
            progress(
              attempt.success ? '图片转录已确认' : '图片转录需复核或兜底',
              {
                code: attempt.success ? 'engine-confirmed' : 'image-fallback',
                engine,
              },
            );
          }
        } catch (error) {
          if (error instanceof PlatformAccessError) throw error;
          cancelled(signal);
          trace.attempts.push({
            engine: engines.at(-1) ?? 'web',
            success: false,
            reason: error instanceof Error ? error.message : '图片识别失败',
          });
        } finally {
          completed++;
          active--;
          if (trace.source) success++;
          progress('图片片段已处理', {
            code: trace.source ? 'image-confirmed' : 'segment-complete',
            waiting: undefined,
          });
        }
      },
      signal,
    );
    cancelled(signal);
    for (const question of page.questions.filter((q) => q.images?.length)) {
      question.issues = question.issues.filter(
        (issue) => issue !== '题目文字识别需检查（图片待识别）',
      );
      for (const optionId of [
        undefined,
        ...question.options.map((option) => option.id),
      ]) {
        const images = imagesForPart(question, optionId);
        if (!images.length) continue;
        const trace =
          optionId === undefined
            ? question.recognition!.stem
            : question.recognition!.options[optionId]!;
        const original =
          optionId === undefined
            ? question.stem
            : question.options.find((o) => o.id === optionId)!.text;
        const textConfirmed = Boolean(trace.source);
        let confirmed =
          textConfirmed &&
          images.every((image) => traces.get(image.id)!.source);
        let merged = original;
        let preview = original;
        for (const image of images) {
          const imageTrace = traces.get(image.id)!;
          const best =
            imageTrace.attempts.findLast((attempt) => attempt.success) ??
            imageTrace.attempts.findLast((attempt) => attempt.text);
          if (imageTrace.source && best?.text)
            merged = merged.replace(image.placeholder, best.text);
          if (best?.text)
            preview = preview.replace(image.placeholder, best.text);
          if (
            imageTrace.attempts.some(
              (attempt) => attempt.contentKind === 'unsupported',
            )
          )
            question.issues.push('图片不是可完整转录的文字或公式，需人工处理');
        }
        if (
          !placeholdersPreserved(
            images.map((image) => image.placeholder).join(''),
            original,
          )
        )
          confirmed = false;
        const reason =
          images
            .filter((image) => !traces.get(image.id)!.source)
            .map((image) => {
              const failures = traces
                .get(image.id)!
                .attempts.filter((attempt) => !attempt.success)
                .map((attempt) => attempt.reason)
                .filter(Boolean)
                .join('；');
              return `${image.placeholder}：${failures || '已选择人工复核'}`;
            })
            .join('；') || '网页文字或图片位置尚未确认';
        const lastEngine =
          images.flatMap((image) => traces.get(image.id)!.attempts).at(-1)
            ?.engine ?? 'web';
        trace.attempts.push({
          engine: confirmed
            ? images.some((image) => traces.get(image.id)!.source === 'vision')
              ? 'vision'
              : 'ocr'
            : lastEngine,
          success: confirmed,
          text: confirmed ? merged : preview,
          ...(confirmed ? {} : { reason }),
        });
        trace.source = confirmed
          ? images.some((image) => traces.get(image.id)!.source === 'vision')
            ? 'vision'
            : 'ocr'
          : undefined;
        if (optionId === undefined) question.stem = merged;
        else question.options.find((o) => o.id === optionId)!.text = merged;
        if (!confirmed)
          question.issues.push(
            `${optionId === undefined ? '题干' : '选项'}文字识别需检查（${reason}）`,
          );
      }
      question.issues = [...new Set(question.issues)];
    }
    const confirmedCount = entries.filter(
      ({ image }) => traces.get(image.id)!.source,
    ).length;
    pulse?.(`图片识别结束：${confirmedCount}/${entries.length} 个片段已确认`, {
      code: 'image-recognition-end',
      done: entries.length,
      total: entries.length,
      success: confirmedCount,
      review: entries.length - confirmedCount,
      queued: 0,
      active: 0,
      waiting: undefined,
    });
    return page;
  } finally {
    stripImageResources(page);
  }
}
