import type { PageSnapshot, QuestionImage } from './domain';
import type { Binding } from './messages';
import {
  imageBlobDataUrl,
  imageNeedsPageReferrer,
  loadImageBlob,
} from './image-loader';

/** Resolve only an image actually present in the bound task's current DOM. */
export function boundPageImage(
  page: PageSnapshot | undefined,
  binding: Binding,
  imageId: string,
  resourceKey: string,
): QuestionImage {
  if (
    !page ||
    page.taskKey !== binding.taskKey ||
    page.fingerprint !== binding.fingerprint ||
    page.accountId !== binding.accountId
  )
    throw new Error('题目或账号已变化，原图读取已停止');
  const image = page.questions
    .flatMap((question) => question.images ?? [])
    .find(
      (candidate) =>
        candidate.id === imageId && candidate.resourceKey === resourceKey,
    );
  if (!image || !imageNeedsPageReferrer(image))
    throw new Error('原图不属于当前题目或不需要课程页面读取');
  return image;
}

/** Run in the course content script so the browser supplies its normal referrer. */
export async function readPageImageResource(
  page: PageSnapshot | undefined,
  binding: Binding,
  imageId: string,
  resourceKey: string,
): Promise<string> {
  const image = boundPageImage(page, binding, imageId, resourceKey);
  return imageBlobDataUrl(await loadImageBlob(image, page!.url));
}
