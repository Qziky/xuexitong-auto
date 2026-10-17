import type { PageSnapshot } from './domain';
import { answerImages } from './image-content';
import { imageMaterials, type ImageMaterialStore } from './image-materials';
import { reusableQuestionText } from './preparation';
import { boundedMap } from './resource-pool';

/** Session results are reusable only while their referenced local bytes exist. */
export async function reusableQuestionIds(
  page: PageSnapshot,
  signal?: AbortSignal,
  materials: Pick<ImageMaterialStore, 'read'> = imageMaterials,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const cancelled = () => {
    if (signal?.aborted) throw new DOMException('缓存检查已取消', 'AbortError');
  };
  cancelled();
  await boundedMap(
    page.questions.filter(reusableQuestionText),
    4,
    async (question) => {
      for (const image of answerImages(question)) {
        cancelled();
        const ref = image.material!;
        if (
          ref.accountId !== (page.accountId ?? '') ||
          ref.taskKey !== page.taskKey ||
          ref.fingerprint !== page.fingerprint ||
          ref.imageId !== image.id
        )
          return;
        try {
          await materials.read(ref);
        } catch {
          cancelled();
          return;
        }
      }
      cancelled();
      ids.add(question.id);
    },
    signal,
  );
  cancelled();
  return ids;
}
