import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSnapshot, TaskRecord } from '../src/domain';
import {
  initialState,
  DEFAULT_PROVIDER,
  TEXT_PROCESSING_VERSION,
} from '../src/domain';
import { platformBlockFor, PlatformAccessError } from '../src/platform-access';

const mock = vi.hoisted(() => ({
  store: {
    state: undefined as any,
    provider: undefined as any,
    persist: vi.fn(),
    log: vi.fn(),
    effectiveVisionProvider: vi.fn(() => ({
      ...DEFAULT_PROVIDER,
      apiKey: 'test-placeholder',
    })),
  },
  offscreen: vi.fn(),
  frameCall: vi.fn(),
  discoverFrames: vi.fn(),
  taskFrame: vi.fn(),
  delay: vi.fn(),
  pages: new Map<string, PageSnapshot>(),
  clicked: new Map<string, number>(),
  drafts: new Set<string>(),
  submitted: new Set<string>(),
  uncertain: false,
  auth: false,
  ambiguous: false,
  account: 'cx:1',
  verifying: false,
  resultVerifying: false,
}));
vi.mock('../src/background/store', () => mock.store);
vi.mock('../src/background/transport', () => ({
  offscreen: mock.offscreen,
  frameCall: mock.frameCall,
  discoverFrames: mock.discoverFrames,
  taskFrame: mock.taskFrame,
  delay: mock.delay,
}));
vi.mock('../src/background/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/platform')>()),
  accessPlatform: vi.fn(async (action: () => unknown) => action()),
}));
import {
  startQueue,
  resumeQueue,
  cancelChangedExecution,
  verifyResult,
} from '../src/background/executor';
import { ownedTabs } from '../src/background/owned-tabs';
import { existingAnswersDigest } from '../src/preparation';
import { beginScan, endScan } from '../src/background/scan-control';

function task(id: string): TaskRecord {
  return {
    id,
    platformId: id,
    accountId: 'cx:1',
    courseId: '100:200',
    title: `任务 ${id}`,
    type: 'homework',
    status: 'pending',
    url: `https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?courseId=100&classId=200&workId=${id}`,
    source: { url: '', at: 0, label: '模拟平台' },
  };
}
function page(id: string): PageSnapshot {
  return {
    adapter: 'modern',
    taskKey: `100:200:work:${id}`,
    fingerprint: `hash${id}`,
    url: task(id).url,
    title: `任务 ${id}`,
    status: 'pending',
    accountId: 'cx:1',
    questions: [
      {
        id: `q${id}`,
        number: 1,
        type: 'single',
        stem: '示例题',
        required: true,
        issues: [],
        options: [
          { id: `q${id}:o1`, key: 'B', label: 'A', text: '答案一' },
          { id: `q${id}:o2`, key: 'A', label: 'B', text: '答案二' },
        ],
        existing: [],
        blanks: [],
      },
    ],
  };
}
beforeEach(() => {
  ownedTabs.clear();
  vi.useFakeTimers();
  mock.pages.clear();
  mock.clicked.clear();
  mock.drafts.clear();
  mock.submitted.clear();
  mock.uncertain = false;
  mock.auth = false;
  mock.ambiguous = false;
  mock.account = 'cx:1';
  mock.verifying = false;
  mock.resultVerifying = false;
  mock.store.state = initialState();
  mock.store.state.accountId = 'cx:1';
  mock.store.state.tasks = [task('1'), task('2')];
  mock.store.state.preferences.notifications = false;
  mock.store.provider = {
    ...DEFAULT_PROVIDER,
    apiKey: 'test-only-placeholder',
  };
  mock.store.persist.mockResolvedValue(undefined);
  mock.store.log.mockReset();
  for (const id of ['1', '2']) mock.pages.set(id, page(id));
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async ({ url }: { url: string }) => ({
        id: Number(new URL(url).searchParams.get('workId')),
      })),
      get: vi.fn(async (id: number) => ({ id, url: task(String(id)).url })),
    },
  });
  mock.taskFrame.mockImplementation(async (tabId: number) => ({
    ref: { tabId, frameId: 0 },
    page: structuredClone(mock.pages.get(String(tabId))!),
  }));
  mock.discoverFrames.mockImplementation(async (tabId: number) => [
    {
      tabId,
      frameId: 0,
      accountId: mock.account,
      loginRequired: false,
      verificationRequired: mock.verifying,
      url: mock.verifying
        ? 'https://mooc1.chaoxing.com/antispiderShowVerify.ac'
        : task(String(tabId)).url,
      taskKey: `100:200:work:${tabId}`,
    },
  ]);
  mock.delay.mockImplementation(async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  });
  mock.offscreen.mockImplementation(async (job: any) => {
    if (job.op === 'restore') return structuredClone(job.page);
    if (job.op === 'solve') {
      if (mock.auth) throw new Error('模型接口鉴权失败');
      return job.questions.map((q: any) => ({
        questionId: q.id,
        optionIds: [q.options[0].id],
        explanation: '模拟答案',
        needsReview: mock.uncertain && q.id === 'q1',
      }));
    }
    if (job.op === 'fetch') return { html: '', url: job.url };
    if (job.op === 'status') return { status: 'unknown' };
  });
  mock.frameCall.mockImplementation(async (ref: any, cmd: any) => {
    const id = String(ref.tabId);
    const p = mock.pages.get(id)!;
    if (cmd.op === 'extract') return structuredClone(p);
    if (cmd.op === 'fill') {
      p.questions[0]!.existing = [...cmd.proposals[0].optionIds];
      return structuredClone(p);
    }
    if (cmd.op === 'draft') {
      mock.drafts.add(id);
      return { clicked: true };
    }
    if (cmd.op === 'submit') {
      mock.clicked.set(id, (mock.clicked.get(id) ?? 0) + 1);
      return { clicked: true };
    }
    if (cmd.op === 'confirm') {
      if (!mock.ambiguous) {
        mock.submitted.add(id);
        p.status = 'submitted';
      }
      return { confirmed: true };
    }
    if (cmd.op === 'result') {
      if (mock.resultVerifying)
        throw new PlatformAccessError(
          platformBlockFor(
            'https://mooc1.chaoxing.com/antispiderShowVerify.ac',
          ),
        );
      return {
        status: mock.submitted.has(id) ? 'submitted' : 'pending',
        taskKey: p.taskKey,
        grade: mock.submitted.has(id) ? '88' : undefined,
      };
    }
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(['same', 'other-task', 'preview'])(
  '服务端核验使用真实答题帧并检查跳转身份：%s',
  async (mode) => {
    const bound =
      'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?courseId=100&classId=200&workId=1';
    const card = {
      ...task('1'),
      url: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?courseid=100&clazzid=200&knowledgeid=4',
    };
    mock.discoverFrames.mockResolvedValue([
      {
        tabId: 1,
        frameId: 2,
        accountId: 'cx:1',
        adapter: 'legacy',
        taskKey: '100:200:work:1',
        url: bound,
        loginRequired: false,
      },
    ]);
    mock.offscreen.mockImplementation(async (job) =>
      job.op === 'fetch'
        ? {
            html: 'fixture',
            url:
              mode === 'other-task'
                ? bound.replace('workId=1', 'workId=2')
                : mode === 'preview'
                  ? bound.replace('/doHomeWorkNew', '/preview')
                  : bound,
          }
        : { status: 'submitted' },
    );
    const result = await verifyResult(1, card, new AbortController().signal, 0);
    expect(
      mock.offscreen.mock.calls.find(([job]) => job.op === 'fetch')![0],
    ).toMatchObject({
      url: bound,
      fresh: true,
      purpose: 'result',
      scope: 'cx:1',
    });
    expect(result.status).toBe(mode === 'same' ? 'submitted' : 'unknown');
    if (mode !== 'same')
      expect(
        mock.offscreen.mock.calls.some(([job]) => job.op === 'status'),
      ).toBe(false);
  },
);
async function settled() {
  for (let i = 0; i < 400; i++) {
    await Promise.resolve();
  }
  await Promise.resolve();
}
describe('完整队列流程（模拟平台）', () => {
  it('任务入口转到只读预览时停止本任务，不识别、求解或写入', async () => {
    mock.pages.set('1', {
      ...page('1'),
      pageMode: 'preview',
      status: 'unknown',
    });
    await startQueue(['1'], 'overwrite');
    await settled();
    expect(mock.store.state.queue.items[0].stage).toBe('review');
    expect(mock.store.state.queue.items[0].note).toContain('只读预览');
    expect(mock.store.state.tasks[0].pageMode).toBe('preview');
    expect(mock.offscreen).not.toHaveBeenCalled();
    expect(mock.clicked.size).toBe(0);
    expect(mock.drafts.size).toBe(0);
  });
  it('批量草稿目标逐份填写并核验保存，全程没有提交', async () => {
    const original = mock.offscreen.getMockImplementation()!;
    mock.offscreen.mockImplementation(async (job) =>
      job.op === 'draft-snapshot'
        ? structuredClone(
            mock.pages.get(new URL(job.url).searchParams.get('workId')!),
          )
        : original(job),
    );
    await startQueue(['1', '2'], 'overwrite', 'draft');
    await settled();
    expect(mock.store.state.queue.goal).toBe('draft');
    expect(mock.store.state.queue.items.map((i: any) => i.stage)).toEqual([
      'draft-saved',
      'draft-saved',
    ]);
    expect(mock.drafts.size).toBe(2);
    expect(mock.clicked.size).toBe(0);
    expect(mock.store.state.workflows['1'].draftVerified).toBe(true);
  });
  it('新队列继续遵守上次不明确的提交标记，仅核验不重提', async () => {
    mock.ambiguous = true;
    await startQueue(['1'], 'overwrite');
    await settled();
    await startQueue(['1'], 'overwrite');
    await settled();
    expect(mock.clicked.get('1')).toBe(1);
    expect(mock.store.state.queue.items[0].stage).toBe('review');
  });
  it('队列识别期间页面版本变化立即暂停，未填写或提交', async () => {
    let started!: () => void;
    const begin = new Promise<void>((resolve) => {
      started = resolve;
    });
    mock.offscreen.mockImplementation((job, signal) => {
      if (job.op === 'restore') {
        started();
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('已取消'))),
        );
      }
      throw new Error('不应继续求解');
    });
    await startQueue(['1'], 'overwrite');
    await begin;
    await cancelChangedExecution({
      tabId: 1,
      frameId: 0,
      url: task('1').url,
      taskKey: '100:200:work:1',
      revision: 'changed',
      loginRequired: false,
      top: true,
    });
    await settled();
    expect(mock.store.state.queue.phase).toBe('paused');
    expect(mock.clicked.size).toBe(0);
    expect(mock.frameCall.mock.calls.some(([, cmd]) => cmd.op === 'fill')).toBe(
      false,
    );
  });
  it('并发开始请求只能创建一个执行队列', async () => {
    const result = await Promise.allSettled([
      startQueue(['1'], 'overwrite'),
      startQueue(['2'], 'overwrite'),
    ]);
    await settled();
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(mock.clicked.size).toBe(1);
  });
  it('nested chapter execution keeps its learning owner and opens its task in front', async () => {
    await startQueue(
      ['1'],
      'preserve',
      'submit',
      undefined,
      undefined,
      'learning-1',
    );
    await settled();
    expect(mock.store.state.queue.learningId).toBe('learning-1');
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: task('1').url,
      active: true,
    });
  });
  it('接管当前已打开任务，复用匹配候选，不另开标签页或再次求解', async () => {
    (chrome.tabs.query as any).mockResolvedValue([
      { id: 1, url: task('1').url },
    ]);
    const original = mock.discoverFrames.getMockImplementation()!;
    mock.discoverFrames.mockImplementation(async (tabId) =>
      (await original(tabId)).map((f: any) => ({
        ...f,
        taskKind: 'homework',
        adapter: 'modern',
      })),
    );
    const raw = page('1');
    mock.store.state.preparations['1'] = {
      workflowVersion: TEXT_PROCESSING_VERSION,
      taskId: '1',
      accountId: 'cx:1',
      courseId: '100:200',
      tabId: 1,
      frameId: 0,
      taskKey: raw.taskKey,
      fingerprint: raw.fingerprint,
      existingDigest: existingAnswersDigest(raw),
      providerRevision: 0,
      policy: 'overwrite',
      phase: 'ready',
      at: Date.now(),
      snapshot: raw,
      proposals: [
        {
          questionId: 'q1',
          optionIds: ['q1:o1'],
          explanation: '已生成',
          needsReview: false,
        },
      ],
    };
    await startQueue(['1'], 'overwrite');
    await settled();
    expect(mock.store.state.queue.items[0].stage).toBe('submitted');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(
      mock.offscreen.mock.calls.some(([job]) =>
        ['solve', 'restore'].includes(job.op),
      ),
    ).toBe(false);
  });
  it('用户在求解期间修改已有答案，拒绝旧结果写入', async () => {
    const original = mock.offscreen.getMockImplementation()!;
    mock.offscreen.mockImplementation(async (job) => {
      const answer = await original(job);
      if (job.op === 'solve')
        mock.pages.get('1')!.questions[0]!.existing = ['q1:o2'];
      return answer;
    });
    await startQueue(['1'], 'overwrite');
    await settled();
    expect(
      mock.frameCall.mock.calls.some(([, command]) =>
        ['fill', 'submit', 'confirm'].includes(command.op),
      ),
    ).toBe(false);
    expect(mock.store.state.queue.items[0].stage).toBe('failed');
  });
  it('一键完成先取消只读刷新，等待刷新结束后才打开执行页面', async () => {
    const controller = beginScan();
    mock.store.state.scan.phase = 'running';
    const start = startQueue(['1'], 'overwrite');
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(controller.signal.aborted).toBe(true);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    endScan(controller);
    mock.store.state.scan.phase = 'cancelled';
    await start;
    await settled();
    expect(mock.store.state.queue.items[0].stage).toBe('submitted');
  });
  it('串行求解、填写、回读、确认和核验，仅真实结果后标记提交', async () => {
    await startQueue(['1', '2'], 'preserve');
    await settled();
    expect(mock.store.state.queue.phase).toBe('done');
    expect(mock.store.state.queue.items.map((i: any) => i.stage)).toEqual([
      'submitted',
      'submitted',
    ]);
    expect(mock.clicked.get('1')).toBe(1);
    expect(mock.clicked.get('2')).toBe(1);
    expect(mock.store.state.tasks[0].grade).toBe('88');
  });
  it('继续队列也先结束只读刷新，并拒绝同时启动第二个恢复操作', async () => {
    mock.store.state.queue = {
      id: 'paused',
      phase: 'paused',
      accountId: 'cx:1',
      policy: 'preserve',
      index: 0,
      startedAt: 0,
      items: [{ taskId: '1', stage: 'waiting' }],
    };
    const controller = beginScan();
    mock.store.state.scan.phase = 'running';
    const resume = resumeQueue();
    await expect(resumeQueue()).rejects.toThrow(/当前操作/);
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(controller.signal.aborted).toBe(true);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    endScan(controller);
    mock.store.state.scan.phase = 'cancelled';
    await resume;
    await settled();
    expect(mock.store.state.queue.items[0].stage).toBe('submitted');
    expect(mock.clicked.get('1')).toBe(1);
  });
  it('明确不确定的候选保存草稿，该任务不提交，下一项继续', async () => {
    mock.uncertain = true;
    await startQueue(['1', '2'], 'overwrite');
    await settled();
    expect(mock.store.state.queue.items.map((i: any) => i.stage)).toEqual([
      'review',
      'submitted',
    ]);
    expect(mock.drafts.has('1')).toBe(true);
    expect(mock.clicked.has('1')).toBe(false);
    expect(mock.clicked.get('2')).toBe(1);
  });
  it('结果不明先读服务器状态，并且不会重复提交', async () => {
    mock.ambiguous = true;
    await startQueue(['1'], 'overwrite');
    await settled();
    expect(mock.store.state.queue.items[0].stage).toBe('review');
    expect(mock.store.state.tasks[0].status).toBe('unknown');
    expect(mock.clicked.get('1')).toBe(1);
    expect(mock.offscreen.mock.calls.some((c) => c[0].op === 'status')).toBe(
      true,
    );
  });
  it('模型鉴权失败暂停整个队列，不继续写入或提交', async () => {
    mock.auth = true;
    await startQueue(['1', '2'], 'preserve');
    await settled();
    expect(mock.store.state.queue.phase).toBe('paused');
    expect(mock.clicked.size).toBe(0);
    expect(mock.store.state.queue.index).toBe(0);
  });
  it('打开任务后检测到换号时立即暂停', async () => {
    mock.account = 'cx:2';
    await startQueue(['1'], 'preserve');
    await settled();
    expect(mock.store.state.queue.phase).toBe('paused');
    expect(mock.clicked.size).toBe(0);
  });
  it('恢复已有提交标记的任务只核验，不重新求解或提交', async () => {
    mock.store.state.queue = {
      id: 'previous',
      phase: 'paused',
      policy: 'preserve',
      accountId: 'cx:1',
      index: 0,
      startedAt: 0,
      items: [
        { taskId: '1', stage: 'verifying', submitAttempted: true, tabId: 1 },
      ],
    };
    mock.submitted.add('1');
    await resumeQueue();
    await settled();
    expect(mock.store.state.queue.items[0].stage).toBe('submitted');
    expect(mock.clicked.size).toBe(0);
    expect(mock.offscreen.mock.calls.some((c) => c[0].op === 'solve')).toBe(
      false,
    );
  });
  it('验证码页面暂停整个队列，后续任务不访问、不求解也不提交', async () => {
    mock.verifying = true;
    await startQueue(['1', '2'], 'preserve');
    await settled();
    expect(mock.store.state.queue.phase).toBe('paused');
    expect(mock.store.state.platformBlock.kind).toBe('captcha');
    expect(mock.store.state.queue.index).toBe(0);
    expect(mock.clicked.size).toBe(0);
    expect(mock.offscreen).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    await expect(resumeQueue()).rejects.toThrow(/验证码/);
  });
  it('提交核验遇到验证码时保留提交标记，恢复后只核验上次结果', async () => {
    mock.resultVerifying = true;
    await startQueue(['1'], 'overwrite');
    await settled();
    expect(mock.store.state.queue.phase).toBe('paused');
    expect(mock.store.state.queue.items[0].submitAttempted).toBe(true);
    expect(mock.store.state.queue.items[0].stage).toBe('verifying');
    expect(mock.clicked.get('1')).toBe(1);
    mock.resultVerifying = false;
    mock.store.state.platformBlock = undefined;
    await resumeQueue();
    await settled();
    expect(mock.store.state.queue.items[0].stage).toBe('submitted');
    expect(mock.clicked.get('1')).toBe(1);
  });
});
