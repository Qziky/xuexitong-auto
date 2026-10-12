import { expect, it } from 'vitest';
import { initialState, type LearningItem } from '../src/domain';
import {
  reconcileCompletedDiscoveryFailures,
  markRetriedDiscoveryPlaceholders,
  removeResolvedDiscoveryPlaceholders,
} from '../src/learning-recovery';

const failure = {
  id: 'discovery',
  courseId: 'c',
  chapterId: 'chapter',
  title: '任务发现',
  url: 'https://i.chaoxing.com/',
  type: 'unknown',
  phase: 'failed',
} as LearningItem;

it('最新目录确认已完成章节后移除发现失败占位，保持当前任务且不增加完成数量', () => {
  const q = initialState().learning;
  const active = {
    ...failure,
    id: 'active',
    chapterId: 'next',
    type: 'video',
    phase: 'playing',
    jobId: 'video',
  } as LearningItem;
  q.items = [failure, active];
  q.index = 1;
  expect(
    reconcileCompletedDiscoveryFailures(q, 'c', [
      { id: 'chapter', complete: true },
    ]),
  ).toBe(1);
  expect(q.items).toEqual([active]);
  expect(q.items[q.index]).toBe(active);
  expect(q.items.filter((i) => i.phase === 'done')).toHaveLength(0);
});

it('未知或冲突目录、其他课程及已定位真实任务的错误不被清除', () => {
  const q = initialState().learning;
  q.items = [
    failure,
    { ...failure, id: 'real', jobId: 'known' },
    { ...failure, id: 'unsupported', phase: 'review' },
  ];
  for (const chapter of [
    { id: 'chapter', complete: false },
    { id: 'chapter', complete: true, completionState: 'conflict' as const },
  ])
    expect(reconcileCompletedDiscoveryFailures(q, 'c', [chapter])).toBe(0);
  expect(
    reconcileCompletedDiscoveryFailures(q, 'other', [
      { id: 'chapter', complete: true },
    ]),
  ).toBe(0);
  expect(
    reconcileCompletedDiscoveryFailures(q, 'c', [
      { id: 'chapter', complete: true },
    ]),
  ).toBe(1);
  expect(q.items.map((i) => i.id)).toEqual(['real', 'unsupported']);
});

it('成功重读章节后标记同章重试占位，并在最终清理时移除', () => {
  const q = initialState().learning;
  const retried = {
    ...failure,
    id: 'retry-placeholder',
    phase: 'failed',
    discoveryRetryAttempted: true,
  } as LearningItem;
  const duplicate = { ...retried, id: 'duplicate' };
  const current = {
    ...failure,
    id: 'current',
    chapterId: 'next',
    type: 'video',
    phase: 'playing',
    jobId: 'video',
  } as LearningItem;
  q.items = [retried, duplicate, current];
  q.index = 2;

  expect(markRetriedDiscoveryPlaceholders(q, 'c', 'chapter')).toBe(2);
  expect(q.items.slice(0, 2).every((item) => item.phase === 'done')).toBe(true);
  expect(q.items[q.index]).toBe(current);
  expect(removeResolvedDiscoveryPlaceholders(q)).toBe(2);
  expect(q.items).toEqual([current]);
  expect(q.index).toBe(0);
  expect(q.items.filter((item) => item.phase === 'done')).toHaveLength(0);
});
