import type { QuestionImage } from './domain';
import { isPublicQuestionImageUrl, safeQuestionImageUrl } from './security';
import {
  detectVerification,
  platformBlockFor,
  PlatformAccessError,
  retryAfterTime,
} from './platform-access';

export type ImageSourceReader = (
  image: QuestionImage,
  signal?: AbortSignal,
) => Promise<Blob>;

export function imageNeedsPageReferrer(image: QuestionImage): boolean {
  const src = image.src && safeQuestionImageUrl(image.src);
  return Boolean(
    src &&
    isPublicQuestionImageUrl(src) &&
    new URL(src).origin === 'https://p.cldisk.com',
  );
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('图片读取已取消', 'AbortError');
}

const MAX_BYTES = 6000000;
function rasterContentType(bytes: Uint8Array): string | undefined {
  const startsWith = (signature: number[]) =>
    signature.every((value, i) => bytes[i] === value);
  if (startsWith([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (startsWith([255, 216, 255])) return 'image/jpeg';
  if (
    startsWith([82, 73, 70, 70]) &&
    [87, 69, 66, 80].every((value, i) => bytes[i + 8] === value)
  )
    return 'image/webp';
  return undefined;
}
export async function loadImageBlob(
  image: QuestionImage,
  base: string,
  signal?: AbortSignal,
): Promise<Blob> {
  cancelled(signal);
  const src =
    image.src &&
    (safeQuestionImageUrl(image.src, base) ??
      (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(image.src)
        ? image.src
        : undefined));
  if (!src) throw new Error('图片地址缺失或不属于受支持的课程资源');
  // Public formula images redirect from star3/origin/* to star4/*/origin.*.
  // Their wildcard CORS response must be read without login credentials.
  const publicCdn = isPublicQuestionImageUrl(src);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15000);
  try {
    const response = await fetch(src, {
      signal: controller.signal,
      credentials: publicCdn ? 'omit' : 'include',
      cache: 'force-cache',
      redirect: publicCdn ? 'follow' : 'error',
    });
    cancelled(signal);
    if (
      publicCdn &&
      response.url &&
      (!isPublicQuestionImageUrl(response.url) ||
        new URL(response.url).origin !== new URL(src, base).origin)
    ) {
      await response.body?.cancel();
      throw new Error('图片跳转地址不属于原课程图片来源');
    }
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
    const blob = new Blob(chunks);
    // The platform's /ananas/latex/p/* endpoint can label a PNG with a
    // malformed "application/octet-stream, image/jpeg" Content-Type.
    const type = rasterContentType(
      new Uint8Array(await blob.slice(0, 12).arrayBuffer()),
    );
    if (!type) {
      const block = detectVerification(
        src,
        new DOMParser().parseFromString(await blob.text(), 'text/html'),
      );
      if (block) throw new PlatformAccessError(block);
      throw new Error('资源不是受支持的 PNG、JPEG 或 WebP 图片');
    }
    return blob.slice(0, blob.size, type);
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
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function imageBlobDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 32768)
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
  return `data:${blob.type};base64,${btoa(chunks.join(''))}`;
}
