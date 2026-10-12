import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';

const mock = vi.hoisted(() => ({
  store: {
    state: undefined as any,
    provider: {},
    initStore: vi.fn(),
    persist: vi.fn(),
    stateSnapshot: () => mock.store.state,
    log: vi.fn(),
    saveProvider: vi.fn(),
    saveRecognition: vi.fn(),
    visionProvider: {},
    effectiveVisionProvider: vi.fn(),
    exportDiagnostics: vi.fn(),
  },
  overview: vi.fn(),
  progress: vi.fn(),
  homework: vi.fn(),
  prepare: vi.fn(),
  prepareTask: vi.fn(),
  schedulePreparation: vi.fn(),
  frames: new Map(),
  discover: vi.fn(),
  observe: vi.fn(),
  cancelScan: vi.fn(),
  cancelPreparation: vi.fn(),
  cancelChangedPreparation: vi.fn(),
  cancelInactivePreparation: vi.fn(),
  startQueue: vi.fn(),
  pauseQueue: vi.fn(),
  resumeQueue: vi.fn(),
  cancelChangedExecution: vi.fn(),
  taskAction: vi.fn(() => ({ operationId: 'manual-run' })),
  acceptQueue: vi.fn(() => ({ operationId: 'queue-run' })),
}));
vi.mock('../src/background/workflows', () => ({
  startTaskAction: mock.taskAction,
  manualRunning: () => false,
  cancelWorkflow: vi.fn(),
  cancelWorkflowAndWait: vi.fn(),
  cancelInactiveWorkflow: vi.fn(),
  cancelChangedWorkflow: vi.fn(),
}));
vi.mock('../src/background/store', () => mock.store);
vi.mock('../src/background/transport', () => ({
  frames: mock.frames,
  discoverFrames: mock.discover,
  notifyFrameRegistry: vi.fn(),
  invalidateLearningFrames: vi.fn(),
  offscreen: vi.fn(),
  finishJob: vi.fn(),
}));
vi.mock('../src/background/scanner', () => ({
  refreshOverview: mock.overview,
  refreshCourseProgress: mock.progress,
  cancelScan: mock.cancelScan,
}));
vi.mock('../src/background/homework-scanner', () => ({
  refreshHomeworkLists: mock.homework,
  observeHomeworkEntry: mock.observe,
}));
vi.mock('../src/background/preparer', () => ({
  prepareActiveTask: mock.prepare,
  prepareTask: mock.prepareTask,
  cancelPreparation: mock.cancelPreparation,
  cancelChangedPreparation: mock.cancelChangedPreparation,
  cancelInactivePreparation: mock.cancelInactivePreparation,
}));
vi.mock('../src/background/executor', () => ({
  startQueue: mock.startQueue,
  acceptQueue: mock.acceptQueue,
  acceptResume: vi.fn(),
  pauseQueue: mock.pauseQueue,
  resumeQueue: mock.resumeQueue,
  cancelChangedExecution: mock.cancelChangedExecution,
}));
vi.mock('../src/background/editor', () => ({ editorBridge: vi.fn() }));
vi.mock('../src/reminders', () => ({ dueReminders: vi.fn(() => []) }));

let listeners: Record<string, (...args: any[]) => any>;
const event = (name: string) => ({
  addListener: vi.fn((fn) => {
    listeners[name] = fn;
  }),
});
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
async function send(
  kind: string,
  args: any = {},
  page = false,
  pageUrl = 'https://i.chaoxing.com/base?ws=2',
) {
  const reply = vi.fn();
  listeners.message!(
    { target: 'background', kind, ...args },
    page
      ? { id: 'test-extension', tab: { id: 1 }, frameId: 0, url: pageUrl }
      : {
          id: 'test-extension',
          url: 'chrome-extension://test-extension/sidepanel.html',
        },
    reply,
  );
  await flush();
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.resetModules();
  listeners = {};
  mock.frames.clear();
  mock.store.state = initialState();
  mock.store.state.accountId = 'cx:1';
  mock.store.state.courses = [
    {
      id: '100:200',
      courseId: '100',
      classId: '200',
      accountId: 'cx:1',
      state: 'active',
    },
  ];
  mock.store.initStore.mockResolvedValue(undefined);
  mock.store.persist.mockResolvedValue(undefined);
  mock.overview.mockResolvedValue(undefined);
  mock.progress.mockResolvedValue(undefined);
  mock.homework.mockResolvedValue(undefined);
  mock.prepare.mockResolvedValue(undefined);
  mock.prepareTask.mockResolvedValue(undefined);
  mock.discover.mockResolvedValue([]);
  vi.stubGlobal('defineBackground', (fn: () => void) => ({ main: fn }));
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      onMessage: event('message'),
    },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
    alarms: { create: vi.fn(async () => {}), onAlarm: event('alarm') },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
    notifications: { onClicked: event('notification'), create: vi.fn() },
    tabs: {
      query: vi.fn(async () => [{ id: 1 }]),
      onRemoved: event('removed'),
      onActivated: event('activated'),
      create: vi.fn(async () => ({ id: 2 })),
      update: vi.fn(async () => {}),
    },
    windows: { onFocusChanged: event('focused') },
  });
  const background = await import('../entrypoints/background');
  background.default.main();
  await flush();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('实际后台入口的刷新调度', () => {
  it('启动和每 30 分钟刷新调用课程及作业汇总，不调用题目读取或模型', async () => {
    expect(chrome.alarms.create).toHaveBeenCalledWith('refresh-courses', {
      periodInMinutes: 30,
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(mock.overview).toHaveBeenCalledTimes(1);
    listeners.alarm!({ name: 'refresh-courses' });
    await flush();
    expect(mock.overview).toHaveBeenCalledTimes(2);
    expect(mock.progress).not.toHaveBeenCalled();
    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.prepareTask).not.toHaveBeenCalled();
    expect(mock.schedulePreparation).not.toHaveBeenCalled();
  });
  it('登录报告只调度汇总，标签页切换和聚焦不会准备题目', async () => {
    mock.store.state.progressRefreshedAt = Date.now();
    await send(
      'frame-ready',
      { info: { url: 'https://i.chaoxing.com/base?ws=2', accountId: 'cx:2' } },
      true,
    );
    await vi.advanceTimersByTimeAsync(2500);
    expect(mock.overview).toHaveBeenCalledTimes(1);
    expect(listeners.activated).toBeTypeOf('function');
    expect(listeners.focused).toBeTypeOf('function');
    listeners.activated!({ tabId: 1 });
    listeners.focused!(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.prepareTask).not.toHaveBeenCalled();
    for (const field of ['queue', 'scan']) {
      mock.store.state[field].phase = 'running';
      listeners.alarm!({ name: 'refresh-courses' });
      await flush();
      mock.store.state[field].phase = 'idle';
    }
    mock.store.state.platformBlock = { kind: 'captcha' };
    listeners.alarm!({ name: 'refresh-courses' });
    await flush();
    expect(mock.overview).toHaveBeenCalledTimes(1);
  });
  it('读取侧栏状态不刷新；全局、进度和单课程列表入口各自独立', async () => {
    await send('state');
    expect(mock.overview).not.toHaveBeenCalled();
    await send('refresh-overview');
    expect(mock.overview).toHaveBeenCalledWith(true);
    await send('refresh-progress');
    expect(mock.progress).toHaveBeenCalledWith(true);
    await send('refresh-homework-list', { courseId: '100:200' });
    expect(mock.homework).toHaveBeenCalledWith('100:200', true);
    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.startQueue).not.toHaveBeenCalled();
  });
  it('打开任务和答题页加载只做页面观察，不读取题目或调用模型', async () => {
    const url =
      'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900';
    mock.store.state.tasks = [
      {
        id: 'work-1',
        accountId: 'cx:1',
        courseId: '100:200',
        title: '作业',
        type: 'quiz',
        status: 'pending',
        url,
        platformId: '900',
        source: { url, at: Date.now(), label: '测试' },
      },
    ];
    await send('open-task', { id: 'work-1' });
    await send(
      'frame-ready',
      {
        info: {
          url,
          accountId: 'cx:1',
          taskKey: '100:200:work:900',
          taskKind: 'quiz',
          adapter: 'legacy',
          top: false,
        },
      },
      true,
      url,
    );
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url, active: true });
    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.prepareTask).not.toHaveBeenCalled();
    expect(mock.startQueue).not.toHaveBeenCalled();
  });
  it('分步操作与综合任务消息分开并立即返回操作编号', async () => {
    mock.store.state.currentTaskId = 'work-1';
    await send('prepare-current-task');
    expect(mock.taskAction).toHaveBeenCalledWith('work-1', 'decode');
    expect(mock.startQueue).not.toHaveBeenCalled();
    mock.store.state.tasks = [
      { id: 'work-1', accountId: 'cx:1', title: '作业', note: undefined },
    ];
    await send('prepare-task', { id: 'work-1' });
    expect(mock.taskAction).toHaveBeenCalledWith('work-1', 'decode');
    await send('task-action', { id: 'work-1', action: 'solve' });
    expect(mock.taskAction).toHaveBeenCalledWith(
      'work-1',
      'solve',
      undefined,
      undefined,
      'execution',
    );
    await send('task-action', {
      id: 'work-1',
      action: 'solve',
      intent: 'reference',
    });
    expect(mock.taskAction).toHaveBeenLastCalledWith(
      'work-1',
      'solve',
      undefined,
      undefined,
      'reference',
    );
    await send('complete-tasks', { ids: ['work-1'], policy: 'preserve' });
    expect(mock.acceptQueue).toHaveBeenCalledWith(
      ['work-1'],
      'preserve',
      'submit',
      expect.any(Function),
    );
    expect(mock.overview).not.toHaveBeenCalled();
  });
  it('已打开的章节测验自动出现在侧栏，重复页面事件不会求解或启动提交', async () => {
    const url =
      'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900';
    const info = {
      url,
      accountId: 'cx:1',
      taskKey: '100:200:work:900',
      taskKind: 'quiz',
      adapter: 'legacy',
      top: false,
      loginRequired: false,
      taskSummary: {
        title: '1.2节章节测验',
        status: 'pending',
        questionCount: 30,
      },
    };
    mock.discover.mockResolvedValue([{ ...info, tabId: 1, frameId: 3 }]);
    await send('frame-ready', { info }, true, url);
    await vi.advanceTimersByTimeAsync(500);
    expect(mock.store.state.currentTaskId).toBe('cx:1:100:200:quiz:900');
    expect(mock.store.state.tasks).toEqual([
      expect.objectContaining({
        title: '1.2节章节测验',
        questionCount: 30,
        type: 'quiz',
        discovery: 'opened',
        status: 'pending',
      }),
    ]);
    await send('frame-ready', { info }, true, url);
    await vi.advanceTimersByTimeAsync(500);
    expect(mock.store.state.tasks).toHaveLength(1);
    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.prepareTask).not.toHaveBeenCalled();
    expect(mock.startQueue).not.toHaveBeenCalled();
    expect(mock.store.state.preparations).toEqual({});
  });
  it('unrelated login tabs do not pause learning, but login loss in its tab does', async () => {
    mock.store.state.learning = {
      ...initialState().learning,
      phase: 'running',
      accountId: 'cx:1',
      tabId: 99,
      items: [],
      index: 0,
    };
    const loginUrl = 'https://passport2.chaoxing.com/login';

    await send(
      'frame-ready',
      { info: { url: loginUrl, loginRequired: true } },
      true,
      loginUrl,
    );
    expect(mock.store.state.learning.phase).toBe('running');

    mock.store.state.learning.tabId = 1;
    await send(
      'frame-ready',
      { info: { url: loginUrl, loginRequired: true } },
      true,
      loginUrl,
    );
    expect(mock.store.state.learning.phase).toBe('paused');
    expect(mock.store.state.learning.note).toBe('登录失效或账号已变化');
  });

  it.each([
    '无法确认当前账号，请回到已登录的个人中心',
    '当前页面尚未提供账号信息，请保持已登录的个人中心打开后继续',
  ])('fresh same-account reports recover the missing-account pause: %s', async (note) => {
    mock.store.state.learning = {
      ...initialState().learning,
      phase: 'paused',
      accountId: 'cx:1',
      tabId: 99,
      discovered: true,
      note,
    };
    mock.discover.mockResolvedValue([
      {
        tabId: 99,
        frameId: 0,
        documentId: 'live-course',
        url: 'https://mooc1.chaoxing.com/course',
        accountId: 'cx:1',
        loginRequired: false,
      },
    ]);
    await send(
      'frame-ready',
      { info: { url: 'https://i.chaoxing.com/base?ws=2', accountId: 'cx:1' } },
      true,
    );
    expect(mock.store.state.learning.phase).toBe('done');
    expect(mock.store.log).toHaveBeenCalledWith(
      '已即时复核当前账号，自动恢复因账号信息暂缺而暂停的学习',
    );
    expect(mock.prepareTask).not.toHaveBeenCalled();
    expect(mock.startQueue).not.toHaveBeenCalled();
  });

  it.each(['学习已暂停', '登录失效或账号已变化', '学习已停止'])(
    'same-account reports preserve an intentional or genuine login pause: %s',
    async (note) => {
      Object.assign(mock.store.state.learning, {
        phase: 'paused',
        accountId: 'cx:1',
        tabId: 99,
        discovered: true,
        note,
      });
      await send(
        'frame-ready',
        { info: { url: 'https://i.chaoxing.com/base?ws=2', accountId: 'cx:1' } },
        true,
      );
      expect(mock.store.state.learning.phase).toBe('paused');
      expect(mock.store.state.learning.note).toBe(note);
    },
  );
});
