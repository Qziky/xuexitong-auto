import { expect, it } from 'vitest';
import { initialState } from '../src/domain';
import {
  canAutoResumeAfterWorkerRestart,
  canAutoResumeMissingAccount,
  shouldRecheckSubmittedQuizPoint,
  shouldAutoResumeDiscoveryRetry,
  nextStaleDiscoveryRetryIndex,
  shouldRetryQuizAtRunEnd,
  shouldRetryStaleCardCheckpoint,
  shouldRetryExhaustedDiscoveryCheckpoint,
  shouldVerifySubmittedQuiz,
} from '../src/learning-policy';

it('only resumes missing-account pauses for the same account without a platform block', () => {
  const queue = {
    ...initialState().learning,
    phase: 'paused' as const,
    accountId: 'account-a',
    note: '无法确认当前账号，请回到已登录的个人中心',
  };
  expect(canAutoResumeMissingAccount(queue, 'account-a', false)).toBe(true);
  expect(canAutoResumeAfterWorkerRestart(queue, 'account-a', false)).toBe(true);
  expect(canAutoResumeMissingAccount(queue, 'account-b', false)).toBe(false);
  expect(canAutoResumeMissingAccount(queue, undefined, false)).toBe(false);
  expect(canAutoResumeMissingAccount(queue, 'account-a', true)).toBe(false);
  for (const note of ['学习已暂停', '学习已停止', '登录失效或账号已变化'])
    expect(
      canAutoResumeMissingAccount({ ...queue, note }, 'account-a', false),
    ).toBe(false);
  expect(
    canAutoResumeMissingAccount(
      { ...queue, phase: 'stopped' },
      'account-a',
      false,
    ),
  ).toBe(false);
});

it('verifies completed task points after either a confirmed submit or an already-submitted skip', () => {
  expect(shouldVerifySubmittedQuiz('submitted', 'pending')).toBe(true);
  expect(shouldVerifySubmittedQuiz('skipped', 'submitted')).toBe(true);
  expect(shouldVerifySubmittedQuiz('skipped', 'complete')).toBe(true);
  expect(shouldVerifySubmittedQuiz('skipped', 'pending')).toBe(false);
  expect(shouldVerifySubmittedQuiz('failed', 'submitted')).toBe(false);
});

it('retries stale card and changed directory placeholders only once', () => {
  const failure = {
    type: 'unknown',
    phase: 'failed',
    errorCode: undefined,
    note: '待恢复的卡片标识已不存在，请打开检查',
    discoveryRetryAttempted: false,
  } as const;
  expect(shouldRetryStaleCardCheckpoint(failure)).toBe(true);
  expect(
    shouldRetryStaleCardCheckpoint({
      ...failure,
      errorCode: 'directory-page-changed',
      note: '章节目录页面已变化，请打开检查',
    }),
  ).toBe(true);
  expect(
    shouldRetryStaleCardCheckpoint({
      ...failure,
      note: '章节目录页面已变化，请打开检查',
    }),
  ).toBe(true);
  expect(shouldRetryStaleCardCheckpoint({ ...failure, discoveryRetryAttempted: true })).toBe(false);
  expect(shouldRetryStaleCardCheckpoint({ ...failure, discoveryRetryCount: 2 })).toBe(false);
  expect(shouldRetryStaleCardCheckpoint({ ...failure, type: 'quiz' })).toBe(false);
  expect(shouldRetryStaleCardCheckpoint({ ...failure, task: {} as any })).toBe(false);
  expect(
    shouldRetryStaleCardCheckpoint({
      ...failure,
      errorCode: 'stale-card-checkpoint',
      note: 'other failure',
    }),
  ).toBe(true);
  expect(shouldRetryStaleCardCheckpoint({ ...failure, note: 'other failure' })).toBe(false);
});

it('allows one bounded post-fix retry for a previously attempted discovery checkpoint', () => {
  const attempted = {
    type: 'unknown',
    phase: 'failed',
    errorCode: 'directory-page-changed',
    note: '章节目录页面已变化，请打开检查',
    discoveryRetryAttempted: true,
  } as const;
  expect(shouldRetryExhaustedDiscoveryCheckpoint(attempted)).toBe(true);
  expect(
    shouldRetryExhaustedDiscoveryCheckpoint({
      ...attempted,
      discoveryRetryCount: 2,
    }),
  ).toBe(false);
  expect(
    shouldRetryExhaustedDiscoveryCheckpoint({
      ...attempted,
      errorCode: undefined,
      note: 'other failure',
    }),
  ).toBe(false);
});

it('limits directory recovery to one retry per course chapter', () => {
  const checkpoint = {
    id: 'one', courseId: 'course-a', chapterId: 'chapter-a',
    title: '示例章节一', url: 'https://i.chaoxing.com/', type: 'unknown',
    phase: 'failed', errorCode: 'directory-page-changed',
    discoveryRetryAttempted: false,
  } as const;
  const duplicate = { ...checkpoint, id: 'two' };
  expect(nextStaleDiscoveryRetryIndex([checkpoint, duplicate])).toBe(0);
  expect(
    nextStaleDiscoveryRetryIndex([
      { ...checkpoint, discoveryRetryAttempted: true },
      duplicate,
    ]),
  ).toBe(-1);
  expect(
    nextStaleDiscoveryRetryIndex([
      checkpoint,
      { ...duplicate, chapterId: 'chapter-b' },
    ]),
  ).toBe(0);
});

it('automatically gives a reviewed quiz one final result or task-point check', () => {
  const reviewed = {
    phase: 'review',
    type: 'quiz',
    completionVerificationAttempted: false,
    taskRetryAttempted: false,
  } as const;
  expect(shouldRetryQuizAtRunEnd(reviewed, 'submitted')).toBe(true);
  expect(shouldRetryQuizAtRunEnd(reviewed, 'complete')).toBe(true);
  expect(shouldRetryQuizAtRunEnd(reviewed, 'unknown')).toBe(true);
  expect(shouldRetryQuizAtRunEnd(reviewed, 'pending')).toBe(true);
  expect(
    shouldRetryQuizAtRunEnd(
      { ...reviewed, task: { autoSubmitBestCandidate: true } as any },
      'review',
    ),
  ).toBe(true);
  expect(shouldRetryQuizAtRunEnd(reviewed, 'review')).toBe(false);
  expect(shouldRetryQuizAtRunEnd({ ...reviewed, taskRetryAttempted: true }, 'unknown')).toBe(false);
  expect(shouldRetryQuizAtRunEnd({ ...reviewed, completionVerificationAttempted: true }, 'submitted')).toBe(true);
  expect(shouldRetryQuizAtRunEnd({ ...reviewed, type: 'video' }, 'submitted')).toBe(false);
  expect(shouldRetryQuizAtRunEnd({ ...reviewed, phase: 'done' }, 'submitted')).toBe(false);
  expect(shouldRetryQuizAtRunEnd(reviewed, undefined)).toBe(false);
});

it('rechecks a reviewed quiz once when its task was already submitted', () => {
  expect(shouldRecheckSubmittedQuizPoint('review', 'quiz', false, 'submitted')).toBe(true);
  expect(shouldRecheckSubmittedQuizPoint('review', 'quiz', undefined, 'complete')).toBe(true);
  expect(shouldRecheckSubmittedQuizPoint('review', 'quiz', true, 'submitted')).toBe(false);
  expect(shouldRecheckSubmittedQuizPoint('review', 'quiz', false, 'pending')).toBe(false);
  expect(shouldRecheckSubmittedQuizPoint('review', 'unknown', false, 'submitted')).toBe(false);
  expect(shouldRecheckSubmittedQuizPoint('done', 'quiz', false, 'submitted')).toBe(false);
});

it('rechecks recoverable pauses before resuming the same account without a platform block', () => {
  const queue = {
    phase: 'paused',
    note: '上次学习已中断，请核验后继续',
    accountId: 'account-a',
  } as const;
  expect(canAutoResumeAfterWorkerRestart(queue, 'account-a', false)).toBe(true);
  expect(
    canAutoResumeAfterWorkerRestart(
      { ...queue, note: '待重试章节目录检查点' },
      'account-a',
      false,
    ),
  ).toBe(true);
  expect(canAutoResumeAfterWorkerRestart(queue, 'account-b', false)).toBe(false);
  expect(canAutoResumeAfterWorkerRestart(queue, undefined, false)).toBe(false);
  expect(canAutoResumeAfterWorkerRestart(queue, 'account-a', true)).toBe(false);
  expect(
    canAutoResumeAfterWorkerRestart(
      { ...queue, note: '学习已暂停' },
      'account-a',
      false,
    ),
  ).toBe(false);
  expect(
    canAutoResumeAfterWorkerRestart(
      { ...queue, note: '登录失效或账号已变化' },
      'account-a',
      false,
    ),
  ).toBe(true);
});

it('auto-resumes only a completed same-account queue with retryable discovery placeholders', () => {
  const queue = initialState().learning;
  queue.phase = 'done';
  queue.accountId = 'account-a';
  queue.items = [
    {
      id: 'discovery',
      courseId: 'course-a',
      chapterId: 'chapter-a',
      title: '示例章节一',
      url: 'https://i.chaoxing.com/',
      type: 'unknown',
      phase: 'failed',
      errorCode: 'directory-page-changed',
      discoveryRetryAttempted: false,
    },
  ];
  expect(shouldAutoResumeDiscoveryRetry(queue, 'account-a', false)).toBe(true);
  expect(shouldAutoResumeDiscoveryRetry(queue, 'account-b', false)).toBe(false);
  expect(shouldAutoResumeDiscoveryRetry(queue, undefined, false)).toBe(false);
  expect(shouldAutoResumeDiscoveryRetry(queue, 'account-a', true)).toBe(false);
  expect(
    shouldAutoResumeDiscoveryRetry(
      { ...queue, phase: 'paused' },
      'account-a',
      false,
    ),
  ).toBe(false);
  expect(
    shouldAutoResumeDiscoveryRetry(
      {
        ...queue,
        items: [{ ...queue.items[0]!, discoveryRetryAttempted: true }],
      },
      'account-a',
      false,
    ),
  ).toBe(false);
});
