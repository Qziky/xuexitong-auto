import type { LearningQueue, CompletionState } from './domain';

/** A failed discovery placeholder is not a platform task and must never add
 * to the completed count. Call only after validating a freshly read directory. */
export function reconcileCompletedDiscoveryFailures(
  queue: LearningQueue,
  courseId: string,
  chapters: {
    id: string;
    complete: boolean;
    completionState?: CompletionState;
  }[],
): number {
  const complete = new Set(
    chapters
      .filter(
        (c) =>
          c.complete &&
          (!c.completionState || c.completionState === 'confirmed'),
      )
      .map((c) => c.id),
  );
  let removed = 0,
    beforeCurrent = 0;
  queue.items = queue.items.filter((item, index) => {
    if (
      item.courseId !== courseId ||
      !complete.has(item.chapterId) ||
      item.type !== 'unknown' ||
      item.phase !== 'failed' ||
      item.jobId ||
      item.objectId ||
      item.task ||
      item.card
    )
      return true;
    removed++;
    if (index < queue.index) beforeCurrent++;
    return false;
  });
  queue.index = Math.max(0, queue.index - beforeCurrent);
  return removed;
}

/** Mark retry placeholders resolved after that chapter's card list was read. */
export function markRetriedDiscoveryPlaceholders(
  queue: LearningQueue,
  courseId: string,
  chapterId: string,
): number {
  let resolved = 0;
  for (const item of queue.items) {
    if (
      item.courseId !== courseId ||
      item.chapterId !== chapterId ||
      item.type !== 'unknown' ||
      item.phase !== 'failed' ||
      !item.discoveryRetryAttempted ||
      item.jobId ||
      item.objectId ||
      item.task ||
      item.card
    )
      continue;
    item.phase = 'done';
    item.errorCode = undefined;
    item.note = '已由最新目录重读恢复';
    resolved++;
  }
  return resolved;
}

/** Remove resolved retry markers after all chapter discovery has finished. */
export function removeResolvedDiscoveryPlaceholders(
  queue: LearningQueue,
): number {
  let removed = 0,
    beforeCurrent = 0;
  queue.items = queue.items.filter((item, index) => {
    if (
      item.type !== 'unknown' ||
      item.phase !== 'done' ||
      !item.discoveryRetryAttempted ||
      item.jobId ||
      item.objectId ||
      item.task ||
      item.card
    )
      return true;
    removed++;
    if (index < queue.index) beforeCurrent++;
    return false;
  });
  queue.index = Math.max(0, queue.index - beforeCurrent);
  return removed;
}
