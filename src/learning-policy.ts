import type { LearningItem, LearningQueue, LearningTaskType } from './domain';
export const LEARNING_TYPES = [
  'video',
  'audio',
  'document',
  'image',
  'quiz',
] as const;
export const LEARNING_LABELS: Record<LearningTaskType, string> = {
  video: '视频',
  audio: '音频',
  document: '文档/PPT',
  image: '图片阅读',
  quiz: '章节题',
  unknown: '其他任务',
};
export function selectedLearningTypes(
  queue: Pick<LearningQueue, 'range' | 'selectedTypes'>,
): Exclude<LearningTaskType, 'unknown'>[] {
  return queue.selectedTypes?.length
    ? [
        ...new Set(
          queue.selectedTypes.filter((t) => LEARNING_TYPES.includes(t)),
        ),
      ]
    : queue.range === 'both'
      ? ['video', 'quiz']
      : [queue.range];
}

export function shouldVerifySubmittedQuiz(
  queueStage: string | undefined,
  taskStatus: string | undefined,
): boolean {
  return (
    queueStage === 'submitted' ||
    (queueStage === 'skipped' &&
      (taskStatus === 'submitted' || taskStatus === 'complete'))
  );
}

export function shouldRecheckSubmittedQuizPoint(
  phase: string,
  type: LearningTaskType,
  attempted: boolean | undefined,
  taskStatus: string | undefined,
): boolean {
  return (
    phase === 'review' &&
    type === 'quiz' &&
    !attempted &&
    (taskStatus === 'submitted' || taskStatus === 'complete')
  );
}

export function shouldRetryQuizAtRunEnd(
  item: Pick<
    import('./domain').LearningItem,
    | 'phase'
    | 'type'
    | 'completionVerificationAttempted'
    | 'taskRetryAttempted'
    | 'task'
  >,
  taskStatus: string | undefined,
): boolean {
  if (
    item.phase !== 'review' ||
    item.type !== 'quiz' ||
    item.taskRetryAttempted
  )
    return false;
  if (taskStatus === 'submitted' || taskStatus === 'complete') return true;
  return (
    taskStatus === 'pending' ||
    taskStatus === 'unknown' ||
    (taskStatus === 'review' && item.task?.autoSubmitBestCandidate === true)
  );
}

export function shouldRetryStaleCardCheckpoint(
  item: Pick<
    LearningItem,
    | 'type'
    | 'phase'
    | 'errorCode'
    | 'note'
    | 'discoveryRetryAttempted'
    | 'discoveryRetryCount'
    | 'card'
    | 'task'
    | 'jobId'
    | 'objectId'
  >,
): boolean {
  return (
    isStaleDiscoveryCheckpoint(item) &&
    !item.discoveryRetryAttempted &&
    (item.discoveryRetryCount ?? 0) < 2
  );
}

export function isStaleDiscoveryCheckpoint(
  item: Pick<
    LearningItem,
    | 'type'
    | 'phase'
    | 'errorCode'
    | 'note'
    | 'card'
    | 'task'
    | 'jobId'
    | 'objectId'
  >,
): boolean {
  return (
    item.type === 'unknown' &&
    item.phase === 'failed' &&
    !item.card &&
    !item.task &&
    !item.jobId &&
    !item.objectId &&
    (item.errorCode === 'stale-card-checkpoint' ||
      item.errorCode === 'directory-page-changed' ||
      item.note === '待恢复的卡片标识已不存在，请打开检查' ||
      item.note === '章节目录页面已变化，请打开检查')
  );
}

/** A bounded second pass is allowed after a repaired discovery failure. */
export function shouldRetryExhaustedDiscoveryCheckpoint(
  item: Pick<
    LearningItem,
    | 'type'
    | 'phase'
    | 'errorCode'
    | 'note'
    | 'discoveryRetryAttempted'
    | 'discoveryRetryCount'
    | 'card'
    | 'task'
    | 'jobId'
    | 'objectId'
  >,
): boolean {
  return (
    isStaleDiscoveryCheckpoint(item) &&
    item.discoveryRetryAttempted === true &&
    (item.discoveryRetryCount ?? 1) < 2
  );
}

/** Retry at most once per course chapter, even if several placeholders were recorded. */
export function nextStaleDiscoveryRetryIndex(
  items: readonly LearningItem[],
): number {
  return items.findIndex(
    (item) =>
      shouldRetryStaleCardCheckpoint(item) &&
      !items.some(
        (candidate) =>
          candidate.type === 'unknown' &&
          candidate.courseId === item.courseId &&
          candidate.chapterId === item.chapterId &&
          candidate.discoveryRetryAttempted,
      ),
  );
}

export function canAutoResumeAfterWorkerRestart(
  queue: Pick<LearningQueue, 'phase' | 'note' | 'accountId'>,
  accountId: string | undefined,
  platformBlocked: boolean,
): boolean {
  return (
    queue.phase === 'paused' &&
    (queue.note === '上次学习已中断，请核验后继续' ||
      queue.note === '登录失效或账号已变化' ||
      queue.note === '待重试章节目录检查点' ||
      canAutoResumeMissingAccount(queue, accountId, platformBlocked)) &&
    Boolean(accountId) &&
    queue.accountId === accountId &&
    !platformBlocked
  );
}

/** Only the identity-probe pause is recoverable when live identity returns. */
export function canAutoResumeMissingAccount(
  queue: Pick<LearningQueue, 'phase' | 'note' | 'accountId'>,
  accountId: string | undefined,
  platformBlocked: boolean,
): boolean {
  return (
    queue.phase === 'paused' &&
    (queue.note === '无法确认当前账号，请回到已登录的个人中心' ||
      queue.note ===
        '当前页面尚未提供账号信息，请保持已登录的个人中心打开后继续') &&
    Boolean(accountId) &&
    queue.accountId === accountId &&
    !platformBlocked
  );
}

export function shouldAutoResumeDiscoveryRetry(
  queue: Pick<LearningQueue, 'phase' | 'accountId' | 'items'>,
  accountId: string | undefined,
  platformBlocked: boolean,
): boolean {
  return (
    queue.phase === 'done' &&
    Boolean(accountId) &&
    queue.accountId === accountId &&
    !platformBlocked &&
    queue.items.some(shouldRetryStaleCardCheckpoint)
  );
}
