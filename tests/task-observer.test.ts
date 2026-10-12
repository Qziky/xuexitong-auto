import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, type CourseRecord } from '../src/domain';
import type { FrameRef } from '../src/background/transport';
import { openedTaskFromFrame } from '../src/opened-task';

const mock = vi.hoisted(() => ({
  store: { state: undefined as any, persist: vi.fn(), log: vi.fn() },
  discover: vi.fn(),
  hold: vi.fn(),
}));
vi.mock('../src/background/store', () => mock.store);
vi.mock('../src/background/transport', () => ({
  discoverFrames: mock.discover,
}));
vi.mock('../src/background/platform', () => ({ holdPlatform: mock.hold }));

import {
  observeActiveTask,
  cancelTaskObservation,
  scheduleActiveTaskObservation,
} from '../src/background/task-observer';
import { ownedTabs } from '../src/background/owned-tabs';

const URL =
  'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900';
const course = {
  id: '100:200',
  accountId: 'cx:1',
  courseId: '100',
  classId: '200',
  state: 'active',
} as CourseRecord;
const frame = (): FrameRef => ({
  tabId: 1,
  frameId: 8,
  url: URL,
  top: false,
  accountId: 'cx:1',
  loginRequired: false,
  taskKey: '100:200:work:900',
  taskKind: 'quiz',
  adapter: 'legacy',
  taskSummary: { title: '1.2节章节测验', status: 'pending', questionCount: 30 },
});

beforeEach(() => {
  vi.clearAllMocks();
  ownedTabs.clear();
  cancelTaskObservation();
  mock.store.state = initialState();
  mock.store.state.accountId = 'cx:1';
  mock.store.state.courses = [course];
  mock.store.persist.mockResolvedValue(undefined);
  mock.discover.mockResolvedValue([
    { ...frame(), frameId: 0, taskKind: undefined, adapter: undefined },
    { ...frame(), frameId: 4, taskKind: undefined, adapter: undefined },
    frame(),
  ]);
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn(async () => [{ id: 1 }]) },
  });
});
afterEach(() => {
  cancelTaskObservation();
  ownedTabs.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('被动识别用户已打开的任务', () => {
  it('预览保留已截止状态；打开真实答题页后清除预览提示', () => {
    const ref = {
      ...frame(),
      taskKind: 'homework' as const,
      url: URL.replace('/api/work', '/mooc2/work/preview'),
      taskSummary: {
        ...frame().taskSummary!,
        status: 'unknown' as const,
        pageMode: 'preview' as const,
      },
    };
    const preview = openedTaskFromFrame(ref, 'cx:1', [course], [])!;
    expect(preview).toMatchObject({ pageMode: 'preview', status: 'unknown' });
    const expired = openedTaskFromFrame(
      ref,
      'cx:1',
      [course],
      [{ ...preview, status: 'expired' }],
    )!;
    expect(expired.status).toBe('expired');
    const answerRef = {
      ...ref,
      url: ref.url.replace('preview', 'dowork'),
      taskSummary: { ...frame().taskSummary! },
    };
    expect(
      openedTaskFromFrame(answerRef, 'cx:1', [course], [preview]),
    ).toMatchObject({ pageMode: 'answer', status: 'pending', note: undefined });
  });
  it('从嵌套 iframe 登记章节测验和题数，不创建题目准备记录', async () => {
    await observeActiveTask();
    expect(mock.discover).toHaveBeenCalledWith(1);
    expect(mock.store.state.currentTaskId).toBe('cx:1:100:200:quiz:900');
    expect(mock.store.state.tasks[0]).toMatchObject({
      title: '1.2节章节测验',
      questionCount: 30,
      type: 'quiz',
      discovery: 'opened',
    });
    expect(mock.store.state.preparations).toEqual({});
    expect(mock.store.state.queue.items).toEqual([]);
  });
  it('重复事件和同一任务的重复 iframe 合并，不重复写入存储', async () => {
    mock.discover.mockResolvedValue([frame(), { ...frame(), frameId: 9 }]);
    await observeActiveTask();
    await observeActiveTask();
    expect(mock.store.state.tasks).toHaveLength(1);
    expect(mock.store.persist).toHaveBeenCalledTimes(1);
  });
  it('题目晚加载后可识别，离开答题页清除当前入口并保留已打开任务', async () => {
    mock.discover.mockResolvedValue([{ ...frame(), adapter: undefined }]);
    await observeActiveTask();
    expect(mock.store.state.currentTaskId).toBeUndefined();
    mock.discover.mockResolvedValue([frame()]);
    await observeActiveTask();
    mock.discover.mockResolvedValue([{ ...frame(), adapter: undefined }]);
    await observeActiveTask();
    expect(mock.store.state.currentTaskId).toBeUndefined();
    expect(mock.store.state.tasks).toHaveLength(1);
  });
  it('普通作业更新已缓存任务，已核验提交状态和成绩不会被旧页面覆盖', async () => {
    const ref = {
      ...frame(),
      taskKind: 'homework' as const,
      url: 'https://mooc1.chaoxing.com/mooc2/work/dowork?courseId=100&classId=200&workId=900',
    };
    const old = openedTaskFromFrame(ref, 'cx:1', [course], [])!;
    mock.store.state.tasks = [{ ...old, status: 'submitted', grade: '90' }];
    mock.discover.mockResolvedValue([ref]);
    await observeActiveTask();
    expect(mock.store.state.tasks).toHaveLength(1);
    expect(mock.store.state.tasks[0]).toMatchObject({
      type: 'homework',
      status: 'submitted',
      grade: '90',
    });
    await observeActiveTask();
    expect(mock.store.persist).toHaveBeenCalledTimes(1);
  });
  it('考试、不同账号、未知课程和多个不同任务都不提供当前完成入口', async () => {
    for (const refs of [
      [{ ...frame(), taskKind: 'exam' }],
      [{ ...frame(), accountId: 'cx:2' }],
      [{ ...frame(), taskKey: '101:200:work:900' }],
      [
        frame(),
        {
          ...frame(),
          taskKey: '100:200:work:901',
          url: URL.replace('900', '901'),
        },
      ],
      [
        frame(),
        { ...frame(), frameId: 0, taskKind: 'exam', adapter: undefined },
      ],
    ]) {
      mock.store.state.currentTaskId = 'old-task';
      mock.discover.mockResolvedValue(refs);
      await observeActiveTask();
      expect(mock.store.state.currentTaskId).toBeUndefined();
    }
    expect(mock.store.state.tasks).toEqual([]);
  });
  it('执行队列、后台标签页和平台暂停期间不会登记任务', async () => {
    mock.store.state.queue.phase = 'running';
    await observeActiveTask();
    expect(mock.discover).not.toHaveBeenCalled();
    mock.store.state.queue.phase = 'idle';
    ownedTabs.add(1);
    await observeActiveTask();
    expect(mock.discover).not.toHaveBeenCalled();
    ownedTabs.clear();
    mock.store.state.platformBlock = { kind: 'captcha' };
    await observeActiveTask();
    expect(mock.discover).not.toHaveBeenCalled();
    expect(mock.store.state.tasks).toEqual([]);
  });
  it('验证码停止观察并进入人工恢复状态，不重试', async () => {
    mock.store.state.currentTaskId = 'old-task';
    mock.discover.mockResolvedValue([
      { ...frame(), verificationRequired: true },
    ]);
    await observeActiveTask();
    expect(mock.hold).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'captcha' }),
    );
    expect(mock.store.state.currentTaskId).toBeUndefined();
    expect(mock.discover).toHaveBeenCalledTimes(1);
    expect(mock.store.state.tasks).toEqual([]);
  });
  it('标签页切换后的过期异步观察不能恢复旧任务', async () => {
    let resolveOld!: (value: FrameRef[]) => void;
    mock.discover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const old = observeActiveTask();
    await vi.waitFor(() => expect(mock.discover).toHaveBeenCalledTimes(1));
    mock.discover.mockResolvedValue([{ ...frame(), adapter: undefined }]);
    await observeActiveTask();
    resolveOld([frame()]);
    await old;
    expect(mock.store.state.currentTaskId).toBeUndefined();
    expect(mock.store.state.tasks).toEqual([]);
  });
  it('密集报告只安排一次只读观察，取消后不再执行', async () => {
    vi.useFakeTimers();
    scheduleActiveTaskObservation();
    scheduleActiveTaskObservation();
    await vi.advanceTimersByTimeAsync(250);
    expect(mock.discover).toHaveBeenCalledTimes(1);
    scheduleActiveTaskObservation();
    cancelTaskObservation();
    await vi.advanceTimersByTimeAsync(250);
    expect(mock.discover).toHaveBeenCalledTimes(1);
  });
});
