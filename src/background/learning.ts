import type { LearningItem, LearningQueue, TaskRecord } from '../domain';
import type { VideoBinding, VideoDescription } from '../video-player';
import { state, persist, log } from './store';
import {
  beginOperation,
  updateOperation,
  operationEvent,
  heartbeatOperation,
  finishOperation,
  resumeOperation,
} from './operations';
import { cancelScanAndWait } from './scan-control';
import { cancelWorkflowAndWait, manualRunning } from './workflows';
import { ownedTabs } from './owned-tabs';
import {
  releaseLearningForeground,
  retainLearningForeground,
} from './learning-foreground';
import {
  frameCall,
  offscreen,
  delay,
  frameChangeOrTimeout,
  type FrameRef,
} from './transport';
import {
  discoverFrames,
  discoverAccountFrames,
  waitForFrames,
} from './learning-frame-access';
import { accessPlatform, assertPlatformReady, holdPlatform } from './platform';
import {
  startQueue,
  resumeQueue,
  pauseQueue,
  awaitQueueIdle,
} from './executor';
import { PlatformAccessError } from '../platform-access';
import { mergeTaskRecords } from '../scan-cache';
import {
  discoverNextChapter,
  revalidateLearningDirectory,
  sameLearningItem,
} from './learning-discovery';
import { learningTarget } from './learning-target';
import { loadedLearningCard, cardMatchesItem } from './learning-card-reader';
import {
  isFreshLearningDocumentFrame,
  matchesLearningNavigation,
} from '../learning-navigation';
import type { PlatformRead } from '../platform-reader';
import {
  LEARNING_TYPES,
  selectedLearningTypes,
  nextStaleDiscoveryRetryIndex,
  shouldRecheckSubmittedQuizPoint,
  shouldRetryQuizAtRunEnd,
  shouldRetryStaleCardCheckpoint,
  shouldRetryExhaustedDiscoveryCheckpoint,
  shouldVerifySubmittedQuiz,
} from '../learning-policy';
import { removeResolvedDiscoveryPlaceholders } from '../learning-recovery';
import type { ReaderDescription } from '../learning-adapters';
import type {
  LearningStartupEvent,
  LearningStartupReceipt,
} from '../learning-startup';

let runner: Promise<void> | undefined;
let controller: AbortController | undefined;
let continuation: ReturnType<typeof setTimeout> | undefined;
let monitor: ReturnType<typeof setInterval> | undefined;
let needsContinue = false;
let reloadAfterResume = false;
let directoryAfterResume = false;
function requestContinue(): void {
  if (runner) {
    needsContinue = true;
    return;
  }
  if (continuation) clearTimeout(continuation);
  continuation = setTimeout(() => {
    continuation = undefined;
    continueLearning();
  }, 50);
}
function startMonitor(): void {
  if (monitor) clearInterval(monitor);
  monitor = setInterval(() => {
    const q = state.learning,
      item = q.items[q.index];
    if (q.phase !== 'running') {
      clearInterval(monitor);
      monitor = undefined;
      return;
    }
    heartbeatOperation(q.runId);
    if (!item || !['playing', 'reading'].includes(item.phase)) return;
    const age = Date.now() - (q.lastHeartbeatAt ?? Date.now());
    if (age > 60000) {
      item.errorCode = 'heartbeat-lost';
      item.note = '播放器或阅读器超过 60 秒没有响应';
      requestContinue();
    } else if (age > 30000) {
      q.note = '连接异常：等待任务页面恢复';
      void persist();
    }
  }, 5000);
}
export function interruptLearning(reason: string): void {
  if (!['running', 'paused'].includes(state.learning.phase)) return;
  releaseLearningForeground(state.learning.id);
  state.learning.phase = 'paused';
  state.learning.note = reason;
  state.learning.lease = undefined;
  if (monitor) clearInterval(monitor);
  monitor = undefined;
  controller?.abort();
  if (continuation) clearTimeout(continuation);
  void stopPlayer();
  void persist(true);
}
async function stopPlayer(): Promise<void> {
  if (
    state.learning.tabId !== undefined &&
    state.learning.frameId !== undefined
  )
    await frameCall(
      {
        tabId: state.learning.tabId,
        frameId: state.learning.frameId,
        documentId: state.learning.documentId,
      },
      { op: 'video-pause' },
    ).catch(() => {});
}
function guard(queue: LearningQueue, signal: AbortSignal): void {
  assertPlatformReady();
  if (signal.aborted || state.learning !== queue || queue.phase !== 'running')
    throw new Error('学习已暂停');
  if (queue.accountId !== state.accountId)
    throw new Error('登录账号已变化，自动学习暂停');
}
async function focusLearningTab(
  queue: LearningQueue,
  tabId: number,
  signal: AbortSignal,
): Promise<void> {
  guard(queue, signal);
  await retainLearningForeground(queue.id, tabId);
  guard(queue, signal);
}
async function ensureTab(
  queue: LearningQueue,
  url: string,
  signal: AbortSignal,
  force = false,
): Promise<number> {
  guard(queue, signal);
  const old =
    queue.tabId === undefined
      ? undefined
      : await chrome.tabs.get(queue.tabId).catch(() => undefined);
  if (
    !force &&
    !reloadAfterResume &&
    old?.id !== undefined &&
    old.url &&
    matchesLearningNavigation(old.url, url) &&
    old.status === 'complete' &&
    ownedTabs.has(old.id)
  ) {
    await focusLearningTab(queue, old.id, signal);
    const all = await discoverAccountFrames(old.id, queue.accountId, signal);
    guard(queue, signal);
    if (
      all.some(
        (f) =>
          f.documentId &&
          matchesLearningNavigation(f.url, url) &&
          !f.loginRequired,
      )
    )
      return old.id;
  }
  const previousDocumentId =
    old?.id === undefined
      ? undefined
      : (
          (await chrome.webNavigation
            .getAllFrames({ tabId: old.id })
            .catch(() => null)) ?? []
        ).find((f) => f.frameId === 0)?.documentId;
  const tab = await accessPlatform(
    () =>
      old?.id !== undefined
        ? chrome.tabs.update(old.id, { url, active: true })
        : chrome.tabs.create({ url, active: true }),
    {
      signal,
      runId: queue.runId,
      accountId: queue.accountId,
      check: () => guard(queue, signal),
    },
  );
  if (tab?.id === undefined) throw new Error('无法打开前台学习页');
  queue.tabId = tab.id;
  queue.frameId = undefined;
  queue.documentId = undefined;
  ownedTabs.add(tab.id);
  await focusLearningTab(queue, tab.id, signal);
  reloadAfterResume = false;
  await persist(true);
  // tabs.update resolves before navigation commits. The old directory can
  // still answer describe/menu, then disappear while waiting for admission.
  await waitForFrames(
    tab.id,
    (ref) => {
      if (!isFreshLearningDocumentFrame(ref, url, previousDocumentId))
        return false;
      guard(queue, signal);
      return true;
    },
    signal,
  );
  await discoverAccountFrames(tab.id, queue.accountId, signal);
  guard(queue, signal);
  return tab.id;
}
async function readCards(
  item: LearningItem,
  queue: LearningQueue,
  signal: AbortSignal,
  fresh = false,
  loadedRef?: FrameRef,
): Promise<LearningItem[]> {
  const course = state.courses.find(
    (c) => c.id === item.courseId && c.accountId === queue.accountId,
  );
  if (!course) throw new Error('课程归属已变化');
  if (!cardMatchesItem(item.url, item, course))
    throw new Error('课程归属或章节入口已变化');
  guard(queue, signal);
  const parse = async (read: PlatformRead) => {
    guard(queue, signal);
    if (!cardMatchesItem(read.url, item, course))
      throw new Error('课程归属或章节已变化，读取结果已丢弃');
    const items = await offscreen<LearningItem[]>(
      {
        op: 'learning-cards',
        html: read.html,
        url: read.url,
        course,
        chapterId: item.chapterId,
        fresh: fresh && read.source !== 'page',
        knownReadingTask:
          fresh &&
          item.id !== 'read' &&
          item.jobId &&
          ['document', 'image'].includes(item.type)
            ? { jobId: item.jobId, objectId: item.objectId }
            : undefined,
      },
      signal,
      queue.runId,
    );
    guard(queue, signal);
    return items;
  };
  if (!fresh && loadedRef) {
    const read = await loadedLearningCard(
      loadedRef,
      item,
      course,
      queue.accountId,
      signal,
    );
    guard(queue, signal);
    if (read) {
      const items = await parse(read);
      if (
        item.id === 'read' ||
        items.some((candidate) => sameLearningItem(candidate, item))
      ) {
        updateOperation(queue.runId, '读取已加载卡片', {
          code: 'platform-page',
          readSource: 'page',
          waiting: undefined,
          platformWaitUntil: undefined,
        });
        return items;
      }
    }
    updateOperation(queue.runId, '页面快照失效，重新读取卡片', {
      code: 'platform-page-invalid',
      waiting: 'page',
      platformWaitUntil: undefined,
    });
  }
  const read = await offscreen<PlatformRead>(
    {
      op: 'fetch',
      url: item.url,
      scope: queue.accountId,
      purpose: 'learning',
      fresh: fresh || !!loadedRef,
    },
    signal,
    queue.runId,
  );
  guard(queue, signal);
  return parse(read);
}
function fatalLearningError(error: unknown, queue: LearningQueue): boolean {
  return (
    error instanceof PlatformAccessError ||
    ['account-changed', 'login-required', 'foreground-unavailable'].includes(
      errorCode(error),
    ) ||
    !!state.platformBlock ||
    queue.accountId !== state.accountId ||
    /登录|账号|课程归属|在读状态/.test(
      error instanceof Error ? error.message : '',
    )
  );
}
function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'page-failure';
}
async function recoverItem(
  queue: LearningQueue,
  item: LearningItem,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (
    fatalLearningError(error, queue) ||
    signal.aborted ||
    queue.phase !== 'running'
  )
    throw error;
  const media = ['video', 'audio'].includes(item.type);
  if (
    media &&
    !item.attempts &&
    queue.lease &&
    queue.tabId !== undefined &&
    queue.frameId !== undefined &&
    ![
      'unsupported-source',
      'autoplay-blocked',
      'unsupported-popup',
      'ambiguous-player',
    ].includes(errorCode(error))
  ) {
    item.attempts = 1;
    item.recovering = true;
    try {
      const all = await discoverAccountFrames(
        queue.tabId,
        queue.accountId,
        signal,
      );
      const target = learningTarget(item, all);
      if (
        !target ||
        target.ref.frameId !== queue.frameId ||
        target.ref.documentId !== queue.documentId
      )
        throw Object.assign(new Error('原播放器绑定已失效'), {
          code: 'binding-changed',
        });
      const binding: VideoBinding = {
        learningId: queue.id,
        runId: queue.runId!,
        itemId: item.id,
        accountId: queue.accountId,
        objectId: item.objectId,
        jobId: item.jobId,
        targetId: target.targetId,
        documentId: queue.documentId,
        lease: crypto.randomUUID(),
      };
      queue.lease = binding.lease;
      item.phase = 'preparing';
      item.errorCode = undefined;
      item.note = '原地恢复播放，等待实际播放进展';
      updateOperation(queue.runId, item.note, { attempt: 1, waiting: 'page' });
      await persist(true);
      const receipt = await frameCall<LearningStartupReceipt>(
        target.ref,
        {
          op: 'video-recover',
          binding,
          deferred: true,
          settings: item.settingsSnapshot,
        },
        { signal },
      );
      if (!receipt?.accepted || receipt.lease !== binding.lease)
        throw Object.assign(new Error('播放恢复协议不一致'), {
          code: 'startup-protocol',
        });
      const deadline = Date.now() + 30000;
      const phase = () => item.phase;
      while (
        phase() === 'preparing' &&
        !item.errorCode &&
        Date.now() < deadline
      ) {
        guard(queue, signal);
        await delay(100, signal);
      }
      guard(queue, signal);
      if (phase() !== 'playing' || item.errorCode)
        throw Object.assign(new Error(item.note ?? '播放恢复没有实际进展'), {
          code: item.errorCode ?? 'playback-stalled',
        });
      // The recovery adapter only acknowledges after currentTime advances.
      queue.lastAdvancedAt = Date.now();
      item.note = '播放位置已前进，原地恢复成功';
      await persist(true);
      return;
    } catch (recoveryError) {
      if (
        fatalLearningError(recoveryError, queue) ||
        signal.aborted ||
        queue.phase !== 'running'
      )
        throw recoveryError;
    } finally {
      item.recovering = false;
    }
  }
  await stopPlayer();
  guard(queue, signal);
  queue.lease = undefined;
  const code = errorCode(error),
    message = error instanceof Error ? error.message : '任务处理失败';
  item.errorCode = code;
  item.note = message;
  item.attempts = (item.attempts ?? 0) + 1;
  if (
    item.attempts <= 2 &&
    ![
      'unsupported-reader',
      'reader-inaccessible',
      'unsupported-source',
      'ambiguous-player',
      'autoplay-blocked',
      'unsupported-popup',
    ].includes(code)
  ) {
    item.phase = 'waiting';
    item.errorCode = undefined;
    updateOperation(
      queue.runId,
      '恢复任务（' + item.attempts + '/2）：' + item.title,
      {
        waiting: undefined,
        platformWaitUntil: undefined,
        attempt: item.attempts,
      },
    );
  } else {
    item.phase =
      code === 'page-failure' || code === 'media-network' ? 'failed' : 'review';
    updateOperation(queue.runId, '该项需检查，继续其他任务：' + item.title, {
      review: queue.items.filter((i) => ['failed', 'review'].includes(i.phase))
        .length,
    });
  }
  await persist(true);
}
async function verifyCompletion(
  queue: LearningQueue,
  item: LearningItem,
  signal: AbortSignal,
): Promise<boolean> {
  if (queue.tabId !== undefined)
    await focusLearningTab(queue, queue.tabId, signal);
  item.phase = 'verifying';
  updateOperation(queue.runId, '核验平台任务点：' + item.title, {
    stage: 'verifying',
    waiting: 'page',
    platformWaitUntil: undefined,
  });
  await persist(true);
  for (let attempt = 0; attempt < 3; attempt++) {
    guard(queue, signal);
    const result = (await readCards(item, queue, signal, true)).find((i) =>
      sameLearningItem(i, item),
    );
    guard(queue, signal);
    if (result?.platformComplete) {
      item.platformComplete = true;
      item.completionEvidence = result.completionEvidence;
      item.completionState = 'confirmed';
      item.phase = 'done';
      item.note = '平台确认任务点完成';
      item.errorCode = undefined;
      await stopPlayer();
      guard(queue, signal);
      queue.lease = undefined;
      await persist(true);
      return true;
    }
    if (result) {
      item.completionState = result.completionState;
      item.completionEvidence = result.completionEvidence;
    }
  }
  return false;
}
async function startResource(
  queue: LearningQueue,
  item: LearningItem,
  signal: AbortSignal,
): Promise<void> {
  item.phase = 'preparing';
  item.errorCode = undefined;
  item.note = '检查平台任务状态';
  updateOperation(queue.runId, '检查任务：' + item.title, {
    stage: 'checking',
    waiting: 'page',
    platformWaitUntil: undefined,
  });
  await persist(true);
  const course = state.courses.find(
    (c) => c.id === item.courseId && c.accountId === queue.accountId,
  );
  if (!course) throw new Error('课程归属已变化');
  const existing =
    queue.tabId === undefined ? [] : await discoverFrames(queue.tabId, signal);
  const reusable =
    !item.attempts &&
    !reloadAfterResume &&
    existing.some(
      (f) =>
        f.documentId &&
        cardMatchesItem(f.url, item, course) &&
        (!f.learningCardIdentity || f.learningCardIdentity.ready),
    );
  if (reusable)
    await discoverAccountFrames(queue.tabId!, queue.accountId, signal);
  const tabId = reusable
    ? queue.tabId!
    : await ensureTab(queue, item.url, signal, !!item.attempts);
  await focusLearningTab(queue, tabId, signal);
  const cards = await waitForFrames(
    tabId,
    (f) => cardMatchesItem(f.url, item, course),
    signal,
  );
  await discoverAccountFrames(tabId, queue.accountId, signal);
  let current = (
    await readCards(
      item,
      queue,
      signal,
      false,
      cards.find((f) => cardMatchesItem(f.url, item, course)),
    )
  ).find((i) => sameLearningItem(i, item));
  guard(queue, signal);
  if (current?.completionState === 'conflict') {
    updateOperation(queue.runId, '页面完成证据冲突，读取最新服务器状态', {
      waiting: 'page',
    });
    current = (await readCards(item, queue, signal, true)).find((i) =>
      sameLearningItem(i, item),
    );
    guard(queue, signal);
    if (
      !current ||
      ['conflict', 'unknown'].includes(current.completionState ?? 'unknown')
    ) {
      item.phase = 'review';
      item.note = '完成证据冲突，平台状态待确认';
      item.completionState = current?.completionState ?? 'conflict';
      item.completionEvidence = current?.completionEvidence;
      await persist(true);
      return;
    }
  }
  if (current?.platformComplete) {
    item.phase = 'done';
    item.platformComplete = true;
    item.completionEvidence = current.completionEvidence;
    item.completionState = 'confirmed';
    item.note = '平台已确认完成，跳过该项';
    updateOperation(queue.runId, '平台已完成，继续下一项：' + item.title, {
      code: 'learning-already-complete',
      waiting: undefined,
      platformWaitUntil: undefined,
    });
    await persist(true);
    return;
  }
  item.note =
    item.type === 'video' || item.type === 'audio'
      ? '等待播放器加载（最多 30 秒）'
      : '等待读取阅读器页数（最多 30 秒）';
  updateOperation(queue.runId, item.note, { waiting: 'page' });
  await persist(true);
  const deadline = Date.now() + 30000;
  let completeFrames = await discoverAccountFrames(
    tabId,
    queue.accountId,
    signal,
  );
  let target = learningTarget(item, completeFrames);
  while (!target && Date.now() < deadline) {
    await frameChangeOrTimeout(Math.min(1000, deadline - Date.now()), signal);
    guard(queue, signal);
    completeFrames = await discoverAccountFrames(
      tabId,
      queue.accountId,
      signal,
    );
    target = learningTarget(item, completeFrames);
  }
  if (!target)
    throw Object.assign(new Error('无法定位该任务对应的播放器或阅读器'), {
      code: ['video', 'audio'].includes(item.type)
        ? 'ambiguous-player'
        : 'reader-inaccessible',
    });
  guard(queue, signal);
  queue.frameId = target.ref.frameId;
  queue.documentId = target.ref.documentId;
  if (target.ref.reader) item.totalPages = target.ref.reader.totalPages;
  if (item.type === 'document' || item.type === 'image')
    item.readingSettings ??= { ...state.learningSettings };
  item.settingsSnapshot ??= { ...state.learningSettings };
  item.errorCode = undefined;
  item.completionRequested = false;
  queue.lastHeartbeatAt = queue.lastAdvancedAt = Date.now();
  await persist(true);
  const isMedia = item.type === 'video' || item.type === 'audio';
  updateOperation(
    queue.runId,
    (isMedia ? '启动播放：' : '启动阅读：') + item.title,
    { stage: 'checking', waiting: 'page' },
  );
  const start = async () => {
    guard(queue, signal);
    queue.lease = crypto.randomUUID();
    item.phase = 'preparing';
    item.errorCode = undefined;
    item.note = isMedia ? '等待播放器实际启动' : '等待阅读器实际启动';
    item.resourceStartedAt = undefined;
    item.localReadingFinished = false;
    const binding: VideoBinding = {
      learningId: queue.id,
      runId: queue.runId!,
      itemId: item.id,
      accountId: queue.accountId,
      objectId: item.objectId,
      jobId: item.jobId,
      targetId: target.targetId,
      lease: queue.lease,
      documentId: queue.documentId,
    };
    await persist(true);
    const startedBy = Date.now() + 30000;
    let receipt: LearningStartupReceipt | undefined;
    let communicationError: unknown;
    try {
      receipt = await frameCall<LearningStartupReceipt>(
        target.ref,
        isMedia
          ? {
              op: 'video-play',
              binding,
              deferred: true,
              requireProgress: !!item.attempts,
              settings: item.settingsSnapshot,
            }
          : {
              op: 'reader-start',
              binding,
              completion: item.completion,
              settings: item.readingSettings,
              deferred: true,
            },
        { signal },
      );
    } catch (error) {
      if (!['frame-disconnected', 'frame-timeout'].includes(errorCode(error)))
        throw error;
      communicationError = error;
      updateOperation(queue.runId, '启动回复中断，等待页面确认实际结果', {
        waiting: 'page',
      });
    }
    if (receipt && (!receipt.accepted || receipt.lease !== binding.lease))
      throw Object.assign(
        new Error('页面脚本版本不一致，请刷新学习通页面后重试'),
        { code: 'startup-protocol' },
      );
    // The content-script startup event changes the phase while this call awaits.
    const currentPhase = () => item.phase;
    while (
      currentPhase() === 'preparing' &&
      !item.errorCode &&
      Date.now() < startedBy
    ) {
      guard(queue, signal);
      await delay(100, signal);
    }
    guard(queue, signal);
    if (item.errorCode)
      throw Object.assign(new Error(item.note ?? '资源启动失败'), {
        code: item.errorCode,
      });
    if (currentPhase() !== (isMedia ? 'playing' : 'reading'))
      throw (
        communicationError ??
        Object.assign(
          new Error('页面未在 30 秒内确认实际启动，请打开处理页检查'),
          { code: 'startup-timeout' },
        )
      );
  };
  await start();
  guard(queue, signal);
  updateOperation(
    queue.runId,
    (isMedia ? '正在播放：' : '正在阅读：') + item.title,
    { stage: 'checking', waiting: undefined },
  );
  await persist(true);
}
async function process(
  queue: LearningQueue,
  signal: AbortSignal,
): Promise<void> {
  guard(queue, signal);
  await cancelScanAndWait();
  if (directoryAfterResume) {
    if (queue.items[queue.index])
      await revalidateLearningDirectory(
        queue,
        queue.items[queue.index]!,
        signal,
        {
          guard,
          ensureTab,
          readCards,
          adoptTab: (id) => {
            queue.tabId = id;
            ownedTabs.add(id);
          },
        },
      );
    guard(queue, signal);
    directoryAfterResume = false;
  }
  while (true) {
    guard(queue, signal);
    if (queue.index >= queue.items.length) {
      if (queue.discovered) {
        const staleCheckpointIndex = nextStaleDiscoveryRetryIndex(queue.items);
        if (staleCheckpointIndex >= 0) {
          const item = queue.items[staleCheckpointIndex]!;
          const courseIndex = queue.courseIds.indexOf(item.courseId);
          for (const candidate of queue.items) {
            if (
              shouldRetryStaleCardCheckpoint(candidate) &&
              candidate.courseId === item.courseId &&
              candidate.chapterId === item.chapterId
            ) {
              candidate.discoveryRetryCount =
                (candidate.discoveryRetryCount ?? 0) + 1;
              candidate.discoveryRetryAttempted = true;
            }
          }
          if (courseIndex >= 0) {
            for (const quiz of queue.items) {
              if (
                quiz.courseId === item.courseId &&
                quiz.type === 'quiz' &&
                quiz.phase === 'review'
              ) {
                quiz.taskRetryAttempted = false;
                quiz.completionVerificationAttempted = false;
              }
            }
            item.phase = 'failed';
            item.note = '正在按最新目录重读该章节';
            queue.cursor ??= { course: 0, chapter: 0 };
            queue.cursor.course = courseIndex;
            queue.cursor.chapter = 0;
            queue.cursor.chapters = undefined;
            queue.cursor.nextChapterId = item.chapterId;
            queue.cursor.nextCardId = undefined;
            queue.cursor.cardIds = undefined;
            queue.discovered = false;
            updateOperation(queue.runId, '恢复卡片目录检查点：' + item.title, {
              code: 'stale-card-checkpoint-retry',
              stage: 'checking',
              waiting: 'page',
            });
            await persist(true);
            continue;
          }
          item.errorCode = 'stale-card-checkpoint-course-missing';
        }
        const retryIndex = queue.items.findIndex((item) =>
          shouldRetryQuizAtRunEnd(
            item,
            item.task
              ? state.tasks.find((task) => task.id === item.task?.id)?.status
              : undefined,
          ),
        );
        if (retryIndex >= 0) {
          const item = queue.items[retryIndex]!;
          const status = item.task
            ? state.tasks.find((task) => task.id === item.task?.id)?.status
            : undefined;
          item.taskRetryAttempted = true;
          item.completionVerificationAttempted = false;
          item.phase =
            status === 'submitted' || status === 'complete'
              ? 'verifying'
              : 'waiting';
          queue.index = retryIndex;
          updateOperation(
            queue.runId,
            '自动复核章节题结果与任务点：' + item.title,
            {
              stage: 'checking',
              waiting: 'page',
            },
          );
          await persist(true);
          continue;
        }
        const resolvedPlaceholders = removeResolvedDiscoveryPlaceholders(queue);
        if (resolvedPlaceholders) {
          operationEvent(
            queue.runId,
            `完成章节目录重读后清理 ${resolvedPlaceholders} 条非任务占位`,
            { code: 'chapter-discovery-recovered' },
          );
          await persist(true);
        }
        break;
      }
      try {
        await discoverNextChapter(queue, signal, {
          adoptTab: async (id) => {
            queue.tabId = id;
            ownedTabs.add(id);
            await focusLearningTab(queue, id, signal);
          },
          activateTab: (id) => focusLearningTab(queue, id, signal),
          guard,
          ensureTab,
          readCards,
        });
      } catch (error) {
        if (
          fatalLearningError(error, queue) ||
          signal.aborted ||
          queue.phase !== 'running'
        )
          throw error;
        const cursor = queue.cursor!,
          course = state.courses.find(
            (c) => c.id === queue.courseIds[cursor.course],
          );
        const chapter = cursor.chapters?.[cursor.chapter];
        const message = error instanceof Error ? error.message : '读取失败';
        const retryAttempted = Boolean(
          course?.id &&
          chapter?.id &&
          queue.items.some(
            (item) =>
              item.type === 'unknown' &&
              item.courseId === course.id &&
              item.chapterId === chapter.id &&
              item.discoveryRetryAttempted,
          ),
        );
        const discoveryRetryCount = Math.max(
          0,
          ...queue.items
            .filter(
              (item) =>
                item.type === 'unknown' &&
                item.courseId === course?.id &&
                item.chapterId === chapter?.id,
            )
            .map(
              (item) =>
                item.discoveryRetryCount ??
                (item.discoveryRetryAttempted ? 1 : 0),
            ),
        );
        queue.items.push({
          id: crypto.randomUUID(),
          courseId: course?.id ?? '',
          chapterId: chapter?.id ?? '',
          title: chapter?.title ?? course?.title ?? '任务发现',
          url: course?.url ?? 'https://i.chaoxing.com/',
          type: 'unknown',
          phase: 'failed',
          errorCode:
            message === '待恢复的卡片标识已不存在，请打开检查'
              ? 'stale-card-checkpoint'
              : message === '章节目录页面已变化，请打开检查'
                ? 'directory-page-changed'
                : undefined,
          discoveryRetryAttempted: retryAttempted,
          discoveryRetryCount,
          note: message,
        });
        if (cursor.chapters) {
          const next =
            cursor.nextCardId &&
            cursor.cardIds &&
            cursor.cardIds.includes(cursor.nextCardId)
              ? cursor.cardIds[cursor.cardIds.indexOf(cursor.nextCardId) + 1]
              : undefined;
          cursor.nextCardId = next;
          if (!next) {
            cursor.cardIds = undefined;
            cursor.chapter++;
            cursor.nextChapterId = cursor.chapters[cursor.chapter]?.id;
          }
        } else {
          cursor.course++;
          cursor.chapter = 0;
          cursor.chapters = undefined;
          cursor.nextChapterId = undefined;
        }
        await persist(true);
      }
      continue;
    }
    const item = queue.items[queue.index]!;
    if (
      shouldRecheckSubmittedQuizPoint(
        item.phase,
        item.type,
        item.completionVerificationAttempted,
        item.task
          ? state.tasks.find((task) => task.id === item.task?.id)?.status
          : undefined,
      )
    ) {
      item.phase = 'verifying';
      item.completionVerificationAttempted = true;
    }
    if (['done', 'draft', 'review', 'failed'].includes(item.phase)) {
      queue.index++;
      continue;
    }
    try {
      if (item.embeddedTaskId) {
        if (item.phase === 'executing') {
          if (state.queue.phase === 'running') return;
          if (
            state.queue.phase === 'paused' &&
            queue.resumeChild &&
            state.queue.items[state.queue.index]?.taskId === item.embeddedTaskId
          ) {
            queue.resumeChild = false;
            await resumeQueue();
            return;
          }
          const result = state.queue.items.find(
            (i) => i.taskId === item.embeddedTaskId,
          );
          const taskStatus = state.tasks.find(
            (task) => task.id === item.task?.id,
          )?.status;
          if (shouldVerifySubmittedQuiz(result?.stage, taskStatus)) {
            item.embeddedTaskId = undefined;
            item.phase = 'waiting';
          } else {
            item.phase = 'review';
            item.note =
              '播放中题目未确认提交：' + (result?.note ?? '请人工检查');
          }
          await persist(true);
          continue;
        }
        await stopPlayer();
        guard(queue, signal);
        item.phase = 'executing';
        await persist(true);
        await startQueue(
          [item.embeddedTaskId],
          queue.policy,
          queue.goal,
          undefined,
          { tabId: queue.tabId! },
          queue.id,
        );
        return;
      }
      if (item.type === 'quiz') {
        if (item.phase === 'executing') {
          if (state.queue.phase === 'running') return;
          if (
            state.queue.phase === 'paused' &&
            queue.resumeChild &&
            state.queue.items[state.queue.index]?.taskId === item.task?.id
          ) {
            queue.resumeChild = false;
            await resumeQueue();
            return;
          }
          const result = state.queue.items.find(
            (i) => i.taskId === item.task?.id,
          );
          const taskStatus = state.tasks.find(
            (task) => task.id === item.task?.id,
          )?.status;
          if (shouldVerifySubmittedQuiz(result?.stage, taskStatus)) {
            item.completionVerificationAttempted = true;
            if (!(await verifyCompletion(queue, item, signal))) {
              item.phase = 'review';
              item.note = '章节题已提交，任务点完成待确认';
            }
          } else {
            item.phase = result?.stage === 'draft-saved' ? 'draft' : 'review';
            item.note = result?.note ?? '章节题执行结果待检查';
          }
          await persist(true);
          continue;
        }
        if (item.phase === 'verifying') {
          item.completionVerificationAttempted = true;
          if (!(await verifyCompletion(queue, item, signal))) {
            item.phase = 'review';
            item.note = '章节题已提交，最新任务点仍未确认';
          }
          await persist(true);
          continue;
        }
        if (manualRunning()) {
          updateOperation(queue.runId, '等待当前页参考处理结束', {
            waiting: 'model-lane',
          });
          continuation = setTimeout(() => continueLearning(), 1000);
          return;
        }
        await stopPlayer();
        if (!item.task) throw new Error('章节题入口无法确认');
        state.tasks = mergeTaskRecords(state.tasks, [item.task]);
        item.phase = 'executing';
        queue.frameId = undefined;
        queue.lease = undefined;
        updateOperation(queue.runId, '处理章节题：' + item.title, {
          stage: 'checking',
        });
        await persist(true);
        await startQueue(
          [item.task.id],
          queue.policy,
          queue.goal,
          undefined,
          undefined,
          queue.id,
        );
        return;
      }
      if (!['video', 'audio', 'document', 'image'].includes(item.type)) {
        item.phase = 'review';
        item.note = '该任务类型需人工处理';
        continue;
      }
      if (
        item.errorCode &&
        ['document', 'image'].includes(item.type) &&
        [
          'heartbeat-lost',
          'reader-document-replaced',
          'reader-communication-timeout',
        ].includes(item.errorCode)
      ) {
        const failedCode = item.errorCode,
          failedNote = item.note;
        updateOperation(
          queue.runId,
          '阅读连接已变化，先核验平台任务点：' + item.title,
          {
            code: 'reader-reconnect-check',
            waiting: 'page',
          },
        );
        if (await verifyCompletion(queue, item, signal)) continue;
        // A native callback may finish just before its iframe is replaced.
        // Unknown server state is not completion; retain the bounded recovery.
        item.errorCode = failedCode;
        item.note = failedNote;
      }
      if (item.errorCode)
        throw Object.assign(new Error(item.note ?? '资源运行失败'), {
          code: item.errorCode,
        });
      if (item.completionRequested || item.phase === 'verifying') {
        if (await verifyCompletion(queue, item, signal)) continue;
        item.completionRequested = false;
        if (
          item.completionFromMarker &&
          !item.localReadingFinished &&
          ['document', 'image'].includes(item.type) &&
          queue.lease
        ) {
          item.completionFromMarker = false;
          item.phase = 'reading';
          item.note = '平台尚未确认，继续阅读';
          await persist(true);
          return;
        }
        if (
          !item.mediaEnded &&
          queue.lease &&
          (item.type === 'video' || item.type === 'audio')
        ) {
          item.thresholdChecked = true;
          item.phase = 'playing';
          item.note = '平台尚未确认，继续按实际倍速播放';
          await persist(true);
          return;
        }
        if (
          !item.mediaEnded &&
          !queue.lease &&
          ['video', 'audio'].includes(item.type)
        ) {
          item.phase = 'waiting';
          await persist(true);
          continue;
        }
        await stopPlayer();
        guard(queue, signal);
        item.phase = 'review';
        item.note = '阅读或播放结束，平台完成待确认';
        queue.lease = undefined;
        await persist(true);
        continue;
      }
      if (item.popupDetected) {
        item.popupDetected = false;
        for (const ref of await discoverFrames(queue.tabId))
          observeLearningQuestion(ref);
        if (item.embeddedTaskId) continue;
        throw Object.assign(
          new Error('播放中题目结构暂不支持，请打开处理页检查'),
          { code: 'unsupported-popup' },
        );
      }
      if (['playing', 'reading'].includes(item.phase)) return;
      await startResource(queue, item, signal);
      // A completed card has no new player events to wake this runner.
      // Advance it here; only an actively started resource waits for events.
      if (['done', 'review', 'failed'].includes(item.phase)) continue;
      return;
    } catch (error) {
      await recoverItem(queue, item, error, signal);
    }
  }
  queue.phase = 'done';
  queue.lease = undefined;
  if (monitor) clearInterval(monitor);
  monitor = undefined;
  const done = queue.items.filter((i) => i.phase === 'done').length,
    review = queue.items.filter((i) =>
      ['failed', 'review'].includes(i.phase),
    ).length,
    drafts = queue.items.filter((i) => i.phase === 'draft').length;
  queue.note =
    '学习结束：' +
    done +
    ' 项平台确认完成，' +
    drafts +
    ' 项草稿，' +
    review +
    ' 项需检查';
  releaseLearningForeground(queue.id);
  await stopPlayer();
  await finishOperation(queue.runId, review ? 'review' : 'done', queue.note);
  await persist(true);
}
export function continueLearning(): void {
  if (state.learning.phase !== 'running') return;
  if (runner) {
    needsContinue = true;
    return;
  }
  controller = new AbortController();
  const queue = state.learning;
  runner = process(queue, controller.signal)
    .catch(async (error) => {
      if (monitor) clearInterval(monitor);
      monitor = undefined;
      if (state.learning !== queue) return;
      releaseLearningForeground(queue.id);
      if (queue.phase === 'running') {
        queue.phase = 'paused';
        queue.note = error instanceof Error ? error.message : '学习暂停';
      }
      if (error instanceof PlatformAccessError) await holdPlatform(error.block);
      await stopPlayer();
      queue.lease = undefined;
      await finishOperation(
        queue.runId,
        queue.phase === 'stopped' ? 'cancelled' : 'paused',
        queue.note ?? '学习暂停',
      );
      log(queue.note ?? '学习暂停', 'warn');
      await persist(true);
    })
    .finally(() => {
      runner = undefined;
      controller = undefined;
      if (needsContinue) {
        needsContinue = false;
        if (state.learning.phase === 'running') requestContinue();
      }
    });
}
export async function awaitLearningIdle(): Promise<void> {
  await runner;
}
export function startLearning(
  courseIds: string[],
  range: LearningQueue['range'],
  goal: LearningQueue['goal'],
  policy: LearningQueue['policy'],
  types?: LearningQueue['selectedTypes'],
): { operationId: string } {
  assertPlatformReady();
  if (
    !state.accountId ||
    !Array.isArray(courseIds) ||
    !courseIds.length ||
    !['video', 'quiz', 'both'].includes(range) ||
    !['submit', 'draft'].includes(goal) ||
    !['preserve', 'overwrite'].includes(policy)
  )
    throw new Error('请选择课程、学习范围和题目目标');
  if (
    runner ||
    state.learning.phase === 'running' ||
    state.queue.phase === 'running'
  )
    throw new Error('已有学习或答题队列，请先暂停');
  if (
    courseIds.some(
      (id) =>
        !state.courses.some(
          (c) =>
            c.id === id &&
            c.accountId === state.accountId &&
            c.state === 'active',
        ),
    )
  )
    throw new Error('课程不属于当前账号的在读课程');
  if (
    types &&
    (!types.length || types.some((t) => !LEARNING_TYPES.includes(t)))
  )
    throw new Error('学习任务类型无效');
  const runId = beginOperation('learning', '自动学习', undefined, goal);
  reloadAfterResume = directoryAfterResume = false;
  state.learning = {
    id: crypto.randomUUID(),
    phase: 'running',
    accountId: state.accountId,
    courseIds: [...new Set(courseIds)],
    range,
    selectedTypes: types ?? [...LEARNING_TYPES],
    cursor: { course: 0, chapter: 0 },
    goal,
    policy,
    items: [],
    index: 0,
    discovered: false,
    startedAt: Date.now(),
    runId,
  };
  startMonitor();
  updateOperation(runId, '正在发现所选课程的任务', {
    stage: 'checking',
    waiting: 'page',
  });
  void cancelWorkflowAndWait().then(() => continueLearning());
  void persist(true);
  return { operationId: runId };
}
export async function pauseLearning(
  stop = false,
  reason?: string,
): Promise<void> {
  if (continuation) clearTimeout(continuation);
  continuation = undefined;
  const queue = state.learning;
  releaseLearningForeground(queue.id);
  if (queue.phase === 'idle' || queue.phase === 'done') return;
  queue.phase = stop ? 'stopped' : 'paused';
  queue.note = reason ?? (stop ? '学习已停止' : '学习已暂停');
  queue.lease = undefined;
  if (monitor) clearInterval(monitor);
  monitor = undefined;
  controller?.abort();
  await persist(true);
  await stopPlayer();
  if (
    state.queue.phase === 'running' &&
    queue.items[queue.index]?.phase === 'executing'
  ) {
    await pauseQueue(stop, queue.note);
    await awaitQueueIdle();
  }
  await runner;
  if (queue.runId)
    await finishOperation(
      queue.runId,
      stop ? 'cancelled' : 'paused',
      queue.note,
    );
}
export function resumeLearning(): { operationId: string } {
  assertPlatformReady();
  const queue = state.learning;
  if (
    runner ||
    !['paused', 'stopped'].includes(queue.phase) ||
    queue.accountId !== state.accountId
  )
    throw new Error('无法恢复学习，请检查账号或等待上次操作结束');
  queue.phase = 'running';
  reloadAfterResume = true;
  directoryAfterResume = true;
  queue.lease = undefined;
  queue.frameId = undefined;
  queue.documentId = undefined;
  if (queue.cursor) {
    queue.cursor.nextChapterId ??=
      queue.cursor.chapters?.[queue.cursor.chapter]?.id;
    queue.cursor.chapters = undefined;
  }
  queue.note = undefined;
  if (queue.runId) resumeOperation(queue.runId);
  else
    queue.runId = beginOperation(
      'learning',
      '恢复自动学习',
      undefined,
      queue.goal,
    );
  const item = queue.items[queue.index];
  queue.resumeChild = item?.phase === 'executing';
  if (
    queue.resumeChild &&
    state.queue.phase === 'paused' &&
    (state.queue.items[state.queue.index]?.taskId === item?.task?.id ||
      state.queue.items[state.queue.index]?.taskId === item?.embeddedTaskId)
  )
    state.queue.learningId = queue.id;
  if (item && ['preparing', 'playing', 'reading'].includes(item.phase)) {
    item.phase = 'waiting';
    item.errorCode = undefined;
  }
  startMonitor();
  continueLearning();
  void persist(true);
  return { operationId: queue.runId! };
}
export function authorizeVideo(
  binding: VideoBinding,
  tabId: number,
  frameId: number,
  documentId?: string,
): boolean {
  const queue = state.learning,
    item = queue.items[queue.index];
  return (
    !state.platformBlock &&
    queue.phase === 'running' &&
    queue.accountId === state.accountId &&
    queue.id === binding.learningId &&
    queue.runId === binding.runId &&
    queue.tabId === tabId &&
    queue.frameId === frameId &&
    (!queue.documentId ||
      (queue.documentId === documentId &&
        binding.documentId === queue.documentId)) &&
    item?.id === binding.itemId &&
    ['video', 'audio', 'document', 'image'].includes(item.type) &&
    ['preparing', 'playing', 'reading', 'verifying'].includes(item.phase) &&
    binding.accountId === state.accountId &&
    (queue.lease ? binding.lease === queue.lease : !binding.lease) &&
    (!binding.objectId || item.objectId === binding.objectId) &&
    (!binding.jobId || item.jobId === binding.jobId)
  );
}
export async function resourceStartup(
  binding: VideoBinding,
  result: LearningStartupEvent,
  tabId: number,
  frameId: number,
  documentId?: string,
): Promise<boolean> {
  if (
    !authorizeVideo(binding, tabId, frameId, documentId) ||
    !result ||
    !['started', 'failed'].includes(result.state)
  )
    return false;
  const queue = state.learning,
    item = queue.items[queue.index]!;
  if (item.phase !== 'preparing') return false;
  if (result.block) {
    await holdPlatform(result.block);
    interruptLearning(result.block.message);
    return false;
  }
  queue.lastHeartbeatAt = Date.now();
  heartbeatOperation(queue.runId);
  if (result.state === 'failed') {
    item.errorCode = result.errorCode ?? 'resource-startup';
    item.note = result.error ?? '资源启动失败';
  } else if (!item.errorCode) {
    item.resourceStartedAt = Date.now();
    item.phase = ['video', 'audio'].includes(item.type) ? 'playing' : 'reading';
  }
  await persist(true);
  return true;
}
function requestObservedCompletion(
  queue: LearningQueue,
  item: LearningItem,
): void {
  if (!item.pendingCompletionEvidence || item.completionRequested) return;
  const seconds = item.completion?.seconds ?? 0;
  const media = ['video', 'audio'].includes(item.type);
  if (
    seconds &&
    (media
      ? (item.position ?? 0) < seconds
      : item.resourceStartedAt === undefined ||
        Date.now() - item.resourceStartedAt < seconds * 1000)
  )
    return;
  if (
    media &&
    item.completion?.ratio &&
    (!item.duration ||
      (item.position ?? 0) / item.duration < item.completion.ratio)
  )
    return;
  item.pendingCompletionEvidence = false;
  item.completionFromMarker = true;
  item.completionRequested = true;
  requestContinue();
}
export async function completionObserved(
  binding: VideoBinding,
  evidence: import('../domain').CompletionEvidence,
  tabId: number,
  frameId: number,
  documentId?: string,
): Promise<boolean> {
  if (
    !authorizeVideo(binding, tabId, frameId, documentId) ||
    evidence?.source !== 'card-marker' ||
    !['confirmed', 'conflict'].includes(evidence.state ?? '') ||
    !Number.isFinite(evidence.at)
  )
    return false;
  const queue = state.learning,
    item = queue.items[queue.index]!;
  const key = (documentId ?? '') + ':' + binding.lease + ':' + evidence.state;
  if (item.completionEventKey === key) return true;
  item.completionEventKey = key;
  item.pendingCompletionEvidence = true;
  requestObservedCompletion(queue, item);
  updateOperation(
    queue.runId,
    item.completionRequested
      ? '页面出现完成标记，核验最新平台状态'
      : '页面出现完成标记，等待明确的学习条件满足',
    { code: 'learning-completion-observed' },
  );
  await persist();
  return true;
}
export async function videoEvent(
  binding: VideoBinding,
  video: VideoDescription,
  tabId: number,
  frameId: number,
  documentId?: string,
): Promise<boolean> {
  if (!authorizeVideo(binding, tabId, frameId, documentId)) return false;
  if (video.block) {
    await holdPlatform(video.block);
    interruptLearning(video.block.message);
    return false;
  }
  const queue = state.learning,
    item = queue.items[queue.index]!;
  if (
    !['video', 'audio'].includes(item.type) ||
    (video.kind && video.kind !== item.type) ||
    !Number.isFinite(video.position) ||
    video.position < 0 ||
    (video.duration !== undefined &&
      (!Number.isFinite(video.duration) || video.duration <= 0))
  )
    return false;
  if (video.position > (item.position ?? 0) + 0.2) {
    queue.lastAdvancedAt = Date.now();
    const run = queue.runId ? state.operations[queue.runId] : undefined;
    if (run) run.lastProgressAt = Date.now();
    if (item.note === '等待播放器实际启动') item.note = undefined;
  }
  item.position = video.position;
  item.actualPlaybackRate = video.actualPlaybackRate;
  item.speedStatus = video.speedStatus;
  item.duration = video.duration;
  requestObservedCompletion(queue, item);
  item.mediaEnded = video.ended;
  if (
    item.phase === 'preparing' &&
    video.readyState >= 2 &&
    (!video.paused || video.ended)
  ) {
    item.resourceStartedAt ??= Date.now();
    item.phase = 'playing';
  }
  queue.lastHeartbeatAt = Date.now();
  if (queue.note?.startsWith('连接异常')) queue.note = undefined;
  heartbeatOperation(queue.runId);
  if (item.recovering) {
    await persist();
    return queue.phase === 'running';
  }
  if (video.errorCode) {
    item.errorCode = video.errorCode;
    item.note =
      video.errorCode === 'player-replaced'
        ? '播放器已重建，需要重新绑定'
        : video.errorCode === 'media-source-changed'
          ? '媒体来源已变化，需要重新绑定'
          : video.errorCode === 'unsupported-source'
            ? '媒体资源地址不可用'
            : '媒体资源加载失败';
    requestContinue();
  } else if (
    video.ended ||
    (!item.thresholdChecked &&
      ((item.completion?.ratio &&
        video.duration &&
        video.position / video.duration >= item.completion.ratio) ||
        (item.completion?.seconds &&
          video.position >= item.completion.seconds)))
  ) {
    item.completionRequested = true;
    requestContinue();
  } else if (
    item.phase !== 'preparing' &&
    video.paused &&
    !item.embeddedTaskId
  ) {
    if (video.blockedQuestion) {
      item.popupDetected = true;
      item.note = '检测到播放中题目，正在识别';
      requestContinue();
    } else {
      item.errorCode = 'media-aborted';
      item.note = '播放器意外暂停，正在恢复';
      requestContinue();
    }
  } else if (
    !video.ended &&
    Date.now() - (queue.lastAdvancedAt ?? Date.now()) > 60000
  ) {
    item.errorCode = 'playback-stalled';
    item.note = '播放超过 60 秒无进展';
    requestContinue();
  }
  await persist();
  return (
    queue.phase === 'running' &&
    !video.ended &&
    !['account-changed', 'login-required', 'unsupported-source'].includes(
      item.errorCode ?? '',
    )
  );
}
export async function readingEvent(
  binding: VideoBinding,
  reading: ReaderDescription,
  tabId: number,
  frameId: number,
  documentId?: string,
): Promise<boolean> {
  if (!authorizeVideo(binding, tabId, frameId, documentId)) return false;
  if (reading.block) {
    await holdPlatform(reading.block);
    interruptLearning(reading.block.message);
    return false;
  }
  const queue = state.learning,
    item = queue.items[queue.index]!;
  const changed =
    reading.currentPage !== item.currentPage ||
    reading.scrollPosition !== item.scrollPosition ||
    reading.waiting !== item.note ||
    !!reading.errorCode ||
    reading.finished;
  if (
    !['document', 'image'].includes(item.type) ||
    !Number.isInteger(reading.currentPage) ||
    reading.currentPage < 0 ||
    (reading.totalPages !== undefined &&
      (!Number.isInteger(reading.totalPages) ||
        reading.totalPages < 1 ||
        reading.currentPage > reading.totalPages)) ||
    (reading.mode === 'scroll' &&
      (!Number.isFinite(reading.scrollPosition) ||
        reading.scrollPosition! < 0 ||
        !Number.isFinite(reading.scrollExtent) ||
        reading.scrollExtent! < 0))
  )
    return false;
  if (
    reading.currentPage > (item.currentPage ?? 0) ||
    (reading.scrollPosition ?? 0) > (item.scrollPosition ?? 0)
  ) {
    queue.lastAdvancedAt = Date.now();
    const run = queue.runId ? state.operations[queue.runId] : undefined;
    if (run) run.lastProgressAt = Date.now();
  }
  item.currentPage = reading.currentPage;
  item.totalPages = reading.totalPages;
  item.readerMode = reading.mode;
  item.scrollPosition = reading.scrollPosition;
  item.scrollExtent = reading.scrollExtent;
  item.note = reading.waiting;
  item.localReadingFinished = reading.finished;
  requestObservedCompletion(queue, item);
  if (item.phase === 'preparing') {
    item.resourceStartedAt ??= Date.now();
    item.phase = 'reading';
  }
  queue.lastHeartbeatAt = Date.now();
  if (queue.note?.startsWith('连接异常')) queue.note = undefined;
  heartbeatOperation(queue.runId);
  if (changed)
    updateOperation(queue.runId, reading.waiting ?? '正在阅读：' + item.title, {
      code: reading.errorCode ?? 'reader-progress',
      done: reading.currentPage,
      total: reading.totalPages,
      waiting: reading.finished ? 'page' : undefined,
    });
  if (reading.finished) {
    item.completionRequested = true;
    requestContinue();
  } else if (reading.errorCode) {
    item.errorCode = reading.errorCode;
    requestContinue();
  }
  await persist();
  return queue.phase === 'running' && !item.errorCode && !reading.finished;
}
/** A rebuilt reader has a new document/lease even if its URL is unchanged. */
export function observeLearningReader(ref: FrameRef): void {
  const queue = state.learning,
    item = queue.items[queue.index];
  const identity = ref.learningIdentity;
  if (
    state.platformBlock ||
    queue.phase !== 'running' ||
    queue.accountId !== state.accountId ||
    queue.tabId !== ref.tabId ||
    !queue.documentId ||
    !ref.documentId ||
    queue.documentId === ref.documentId ||
    ref.loginRequired ||
    ref.verificationRequired ||
    (ref.accountId && ref.accountId !== queue.accountId) ||
    !ref.reader ||
    !item ||
    !['document', 'image'].includes(item.type) ||
    !['preparing', 'reading'].includes(item.phase) ||
    item.errorCode ||
    !item.jobId ||
    identity?.jobId !== item.jobId ||
    (identity.objectId && identity.objectId !== item.objectId)
  )
    return;
  queue.lease = undefined;
  item.errorCode = 'reader-document-replaced';
  item.note = '阅读页面已重新加载，正在核对完成状态并重新连接';
  updateOperation(queue.runId, item.note, {
    code: item.errorCode,
    waiting: 'page',
  });
  requestContinue();
  void persist(true);
}
export function observeLearningQuestion(ref: FrameRef): void {
  const q = state.learning,
    item = q.items[q.index];
  if (
    state.platformBlock ||
    ref.loginRequired ||
    ref.verificationRequired ||
    (ref.accountId && ref.accountId !== q.accountId) ||
    q.phase !== 'running' ||
    q.tabId !== ref.tabId ||
    !item ||
    !['video', 'audio'].includes(item.type) ||
    !['playing', 'preparing'].includes(item.phase) ||
    !ref.adapter ||
    ref.taskKind !== 'quiz' ||
    !ref.taskSummary?.questionCount ||
    ['submitted', 'complete'].includes(ref.taskSummary.status)
  )
    return;
  const work = ref.taskKey?.split(':work:')[1];
  if (!work || !/^\d+$/.test(work)) return;
  const task: TaskRecord = {
    id: q.accountId + ':embedded:' + ref.taskKey,
    accountId: q.accountId,
    courseId: item.courseId,
    type: 'quiz',
    title: '播放中题目：' + ref.taskSummary.title,
    status: 'pending',
    platformId: work,
    url: ref.url,
    listed: false,
    discovery: 'opened',
    source: { url: ref.url, at: Date.now(), label: '自动学习播放中题目' },
  };
  state.tasks = mergeTaskRecords(state.tasks, [task]);
  item.embeddedTaskId = task.id;
  requestContinue();
  void persist(true);
}
export function retryLearningItems(): { operationId: string } {
  const queue = state.learning;
  assertPlatformReady();
  if (
    queue.phase === 'running' ||
    runner ||
    queue.accountId !== state.accountId
  )
    throw new Error('请先暂停学习或检查账号');
  const exhaustedDiscovery = queue.items.filter(
    shouldRetryExhaustedDiscoveryCheckpoint,
  );
  if (queue.phase === 'done' && exhaustedDiscovery.length) {
    const retryCourseId = exhaustedDiscovery[0]!.courseId;
    for (const item of exhaustedDiscovery) {
      item.discoveryRetryCount ??= item.discoveryRetryAttempted ? 1 : 0;
      item.discoveryRetryAttempted = false;
    }
    for (const item of queue.items) {
      if (
        item.courseId === retryCourseId &&
        item.type === 'quiz' &&
        item.phase === 'review'
      ) {
        item.taskRetryAttempted = false;
        item.completionVerificationAttempted = false;
      }
    }
    queue.index = queue.items.length;
    queue.discovered = true;
    queue.phase = 'paused';
    queue.note = '待重试章节目录检查点';
    return resumeLearning();
  }
  const failed = queue.items.filter(
    (i) => ['failed', 'review'].includes(i.phase) && i.type !== 'unknown',
  );
  if (!failed.length) throw new Error('没有可重试的失败项');
  for (const item of failed) {
    const taskStatus = item.task
      ? state.tasks.find((task) => task.id === item.task?.id)?.status
      : undefined;
    item.phase =
      item.task && (taskStatus === 'submitted' || taskStatus === 'complete')
        ? 'verifying'
        : 'waiting';
    item.errorCode = undefined;
    item.attempts = 0;
    item.completionRequested = false;
    item.completionVerificationAttempted = false;
    item.taskRetryAttempted = false;
    item.discoveryRetryAttempted = false;
    item.readingSettings = undefined;
  }
  queue.index = Math.min(...failed.map((i) => queue.items.indexOf(i)));
  queue.phase = 'paused';
  return resumeLearning();
}
