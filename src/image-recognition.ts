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
import {
  imageNeedsPageReferrer,
  loadImageBlob,
  type ImageSourceReader,
} from './image-loader';
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
import { PlatformAccessError } from './platform-access';
import type { ProgressSink } from './progress';
import { formulaImageContext, formulaText } from './formula-content';
import { imageMaterials } from './image-materials';
import { confirmedInlineSymbol, isInlineGlyph } from './inline-symbol';

type LoadedRaster = { blob: Blob; width: number; height: number };

type RasterReader = (
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
  pulse?: ProgressSink,
) => Promise<RecognitionAttempt>;
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderError('图片识别已取消', 'cancelled');
}

/** Load only a resource actually present in the selected question. No page traversal. */
export async function loadImageCanvas(
  image: QuestionImage,
  base: string,
  signal?: AbortSignal,
  onLoaded?: (source: LoadedRaster) => void,
  readSource?: ImageSourceReader,
): Promise<HTMLCanvasElement> {
  cancelled(signal);
  let bitmap: ImageBitmap | undefined;
  try {
    const blob =
      readSource && imageNeedsPageReferrer(image)
        ? await readSource(image, signal)
        : await loadImageBlob(image, base, signal);
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
    onLoaded?.({
      blob,
      width: bitmap.width,
      height: bitmap.height,
    });
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
    canvas.dataset.inlineGlyph = String(isInlineGlyph(canvas, bitmap));
    canvas.dataset.contentDigest = await contentDigest(
      await blob.arrayBuffer(),
    );
    return canvas;
  } catch (error) {
    if (error instanceof PlatformAccessError) throw error;
    cancelled(signal);
    throw new Error(
      error instanceof Error && !/fetch|network|https?:/i.test(error.message)
        ? error.message
        : '图片加载失败，请确认页面图片可见后重新解密',
    );
  } finally {
    bitmap?.close();
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
  readSource?: ImageSourceReader,
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
        let source: LoadedRaster | undefined;
        let loadAttempted = false;
        let inlineGlyph = false;
        const load = (cancel?: AbortSignal) => {
          loadAttempted = true;
          return loadImageCanvas(
            image,
            page.url,
            cancel,
            (loaded) => {
              source = loaded;
            },
            readSource,
          ).then((canvas) => {
            inlineGlyph = canvas.dataset.inlineGlyph === 'true';
            return canvas;
          });
        };
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
          if (image.latex) {
            trace.source = 'web';
            trace.attempts.push({
              engine: 'web',
              success: true,
              contentKind: 'formula',
              text: formulaText(image.latex),
              reason: '网页公式组件提供原始 LaTeX',
            });
            progress('已读取网页原始公式', {
              code: 'engine-confirmed',
              engine: 'web',
            });
            return;
          }
          for (const engine of engines) {
            cancelled(signal);
            if (
              trace.source ||
              (trace.attempts.some((a) => a.contentKind === 'unsupported') &&
                !(engine === 'ocr' && inlineGlyph))
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
                          context: formulaImageContext(question, image),
                          questionNumber: question.number,
                          part: image.optionId
                            ? '选项图片 ' + image.optionId
                            : '题干图片',
                          render: async (renderSignal) => {
                            progress('正在读取题目图片', {
                              code: 'image-loading',
                              engine,
                            });
                            const canvas = await load(renderSignal ?? signal);
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
                                  context: formulaImageContext(question, image),
                                  version: 7,
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
                  canvas = await load(signal);
                  attempt = await raster(canvas, signal, progress);
                  const symbol = confirmedInlineSymbol(
                    attempt,
                    inlineGlyph,
                    trace.attempts,
                  );
                  if (symbol)
                    attempt = {
                      ...attempt,
                      text: formulaText(symbol),
                      contentKind: 'formula',
                      reason: '独立行内字符经两次高置信度 OCR 一致确认',
                    };
                  else if (
                    attempt.success &&
                    (!knownText ||
                      (inlineGlyph &&
                        /^[a-z0-9]$/i.test(attempt.text?.trim() ?? '')))
                  )
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
          if (!trace.source && strategy !== 'manual') {
            try {
              if (!loadAttempted) {
                const canvas = await load(signal);
                canvas.width = canvas.height = 0;
              }
              cancelled(signal);
              if (source) {
                image.material = await imageMaterials.save(
                  source.blob,
                  page,
                  image,
                  source,
                );
                cancelled(signal);
                trace.source = 'image';
                trace.attempts.push({
                  engine: 'image',
                  success: true,
                  contentKind: 'image',
                  text: image.placeholder,
                  reason: '原图已保存在本机，生成参考时结合文字和原图作答',
                });
                progress('原图材料已保存，可结合文字作答', {
                  code: 'image-material-saved',
                  engine: 'image',
                });
              }
            } catch (error) {
              if (error instanceof PlatformAccessError) throw error;
              cancelled(signal);
              trace.attempts.push({
                engine: 'image',
                success: false,
                reason:
                  error instanceof Error ? error.message : '保存原图材料失败',
              });
            }
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
            !imageTrace.source &&
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
        const imageSource = images.some(
          (image) => traces.get(image.id)!.source === 'image',
        )
          ? 'image'
          : images.some((image) => traces.get(image.id)!.source === 'vision')
            ? 'vision'
            : images.every((image) => traces.get(image.id)!.source === 'web')
              ? 'web'
              : 'ocr';
        trace.attempts.push({
          engine: confirmed ? imageSource : lastEngine,
          success: confirmed,
          text: confirmed ? merged : preview,
          ...(confirmed ? {} : { reason }),
        });
        trace.source = confirmed ? imageSource : undefined;
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
