import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  initialState,
  DEFAULT_PROVIDER,
  type PageSnapshot,
} from '../src/domain';
import { classifyTaskPage, taskIdentifiers } from '../src/task-context';
import { existingAnswersDigest, preparationMatches } from '../src/preparation';
const mock = vi.hoisted(() => ({
  store: {
    state: undefined as any,
    provider: undefined as any,
    persist: vi.fn(async () => {}),
    effectiveVisionProvider: vi.fn(),
  },
  discoverFrames: vi.fn(),
  frameCall: vi.fn(),
  offscreen: vi.fn(),
  page: undefined as any,
  ref: undefined as any,
}));
vi.mock('../src/background/store', () => mock.store);
vi.mock('../src/background/transport', () => ({
  discoverFrames: mock.discoverFrames,
  frameCall: mock.frameCall,
  offscreen: mock.offscreen,
  delay: vi.fn(async () => {}),
}));
import {
  prepareActiveTask,
  prepareTask,
  cancelPreparation,
  cancelChangedPreparation,
  releasePreparationPriority,
} from '../src/background/preparer';
import { ownedTabs } from '../src/background/owned-tabs';
const URL =
  'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900';
function answers() {
  return [
    {
      questionId: 'q1',
      optionIds: ['q1:o1'],
      explanation: '测试答案',
      needsReview: false,
    },
  ];
}
beforeEach(() => {
  vi.clearAllMocks();
  ownedTabs.clear();
  releasePreparationPriority();
  mock.store.state = initialState();
  mock.store.state.accountId = 'cx:1';
  mock.store.state.courses = [
    {
      id: '100:200',
      accountId: 'cx:1',
      courseId: '100',
      classId: '200',
      state: 'active',
      title: '课程',
    },
  ];
  mock.store.provider = { ...DEFAULT_PROVIDER, apiKey: 'test-placeholder' };
  mock.store.effectiveVisionProvider.mockImplementation(() => ({
    ...mock.store.provider,
  }));
  mock.page = {
    taskKey: '100:200:work:900',
    fingerprint: 'structure-1',
    url: URL,
    adapter: 'legacy',
    accountId: 'cx:1',
    title: '章节测验',
    status: 'pending',
    questions: [
      {
        id: 'q1',
        number: 1,
        stem: '题目',
        type: 'single',
        required: true,
        existing: [],
        blanks: [],
        issues: [],
        options: [
          { id: 'q1:o1', key: 'B', label: 'A', text: '答案一' },
          { id: 'q1:o2', key: 'A', label: 'B', text: '答案二' },
        ],
      },
    ],
  } satisfies PageSnapshot;
  mock.ref = {
    tabId: 1,
    frameId: 3,
    taskKey: mock.page.taskKey,
    revision: 'revision-1',
    url: URL,
    accountId: 'cx:1',
    taskKind: 'quiz',
    adapter: 'legacy',
    loginRequired: false,
  };
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: URL }]),
      update: vi.fn(async () => {}),
      create: vi.fn(async () => ({ id: 2 })),
    },
  });
  mock.discoverFrames.mockImplementation(async () => [mock.ref]);
  mock.frameCall.mockImplementation(async (_ref, command) => {
    if (command.op !== 'extract') throw new Error('准备阶段禁止网页写入');
    return structuredClone(mock.page);
  });
  mock.offscreen.mockImplementation(async (job) => {
    if (job.op === 'restore') return structuredClone(job.page);
    if (job.op === 'solve') return answers();
    throw new Error('准备阶段不应遍历平台页面');
  });
});
afterEach(() => {
  cancelPreparation();
  ownedTabs.clear();
  vi.unstubAllGlobals();
});
describe('当前页面只生成候选答案', () => {
  it.each(['decode', 'full'] as const)(
    '同题多页 %s 优先当前页，复用候选也重新绑定当前 iframe',
    async (mode) => {
      await prepareActiveTask();
      const id = 'cx:1:100:200:quiz:900';
      const task = mock.store.state.tasks.find((t: any) => t.id === id);
      const old = {
        id: 'old', task, tabId: 1, frameId: 3, taskKey: mock.page.taskKey,
        at: 1, capabilities: { analyze: true, fill: true, save: true, submit: true },
      };
      mock.store.state.workspaces = { old, current: { ...old, id: 'current', tabId: 2, frameId: 7 } };
      mock.store.state.currentPage = { kind: 'question', tabId: 2, workspaceId: 'current' };
      mock.discoverFrames.mockClear();
      mock.discoverFrames.mockImplementation(async (tabId: number) => [
        { ...mock.ref, tabId, frameId: tabId === 2 ? 7 : 3 },
      ]);
      await prepareTask(id, mode);
      expect(mock.discoverFrames).toHaveBeenCalledWith(2);
      expect(mock.store.state.preparations[id]).toMatchObject({ tabId: 2, frameId: 7 });
      expect(mock.frameCall.mock.calls.every(([, command]) => command.op === 'extract')).toBe(true);
      if (mode === 'full')
        expect(mock.offscreen.mock.calls.filter(([job]) => job.op === 'solve')).toHaveLength(1);
    },
  );
  it('文字还原任务携带识别设置和实际独立视觉配置', async () => {
    mock.store.state.recognition = {
      strategy: 'vision-only',
      validateOcr: false,
      visionService: 'independent',
    };
    mock.store.effectiveVisionProvider.mockReturnValue({
      ...DEFAULT_PROVIDER,
      apiKey: 'vision-placeholder',
      model: 'independent-vision',
    });
    await prepareActiveTask();
    const job = mock.offscreen.mock.calls.find(
      ([job]) => job.op === 'restore',
    )![0];
    expect(job.recognition).toEqual(mock.store.state.recognition);
    expect(job.visionProvider.model).toBe('independent-vision');
    expect(
      mock.offscreen.mock.calls.find(([job]) => job.op === 'solve')![0].provider
        .model,
    ).toBe(DEFAULT_PROVIDER.model);
  });
  it('识别期间页面版本变化立即取消，无后续求解或写入', async () => {
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
    const run = prepareActiveTask();
    await begin;
    cancelChangedPreparation({ ...mock.ref, revision: 'changed' });
    await run;
    expect(mock.store.state.preparations['cx:1:100:200:quiz:900'].phase).toBe(
      'cancelled',
    );
    expect(mock.offscreen).toHaveBeenCalledOnce();
  });
  it('支持嵌套 iframe，生成后不填写、保存草稿或提交；重复事件不重复求解', async () => {
    await prepareActiveTask();
    await prepareActiveTask();
    const id = 'cx:1:100:200:quiz:900';
    expect(mock.store.state.currentTaskId).toBe(id);
    expect(mock.store.state.preparations[id].phase).toBe('ready');
    expect(mock.store.state.preparations[id].frameId).toBe(3);
    expect(
      mock.offscreen.mock.calls.filter(([job]) => job.op === 'solve'),
    ).toHaveLength(1);
    expect(
      mock.frameCall.mock.calls.every(
        ([, command]) => command.op === 'extract',
      ),
    ).toBe(true);
    expect(mock.page.questions[0].existing).toEqual([]);
  });
  it('显式点击目标任务的生成入口后才打开所选题目并求解，不触碰提交动作', async () => {
    const id = 'cx:1:100:200:quiz:900';
    mock.store.state.tasks = [
      {
        id,
        accountId: 'cx:1',
        courseId: '100:200',
        title: '章节测验',
        type: 'quiz',
        status: 'pending',
        url: URL,
        platformId: '900',
        discovery: 'opened',
        source: { url: URL, at: Date.now(), label: '测试' },
      },
    ];
    await prepareTask(id);
    expect(mock.store.state.preparations[id].phase).toBe('ready');
    expect(
      mock.frameCall.mock.calls.every(
        ([, command]) => command.op === 'extract',
      ),
    ).toBe(true);
    expect(
      mock.offscreen.mock.calls.filter(([job]) => job.op === 'solve'),
    ).toHaveLength(1);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('用户已有答案变化后，保留策略重新准备并保留用户选择', async () => {
    await prepareActiveTask();
    mock.page.questions[0].existing = ['q1:o2'];
    mock.ref.revision = 'revision-2';
    await prepareActiveTask();
    expect(
      mock.store.state.preparations['cx:1:100:200:quiz:900'].proposals[0]
        .optionIds,
    ).toEqual(['q1:o2']);
    expect(
      mock.offscreen.mock.calls.filter(([job]) => job.op === 'solve'),
    ).toHaveLength(1);
  });
  it('题目指纹变化重新求解；模型配置或策略变化不复用旧候选', async () => {
    await prepareActiveTask();
    mock.page.fingerprint = 'structure-2';
    mock.ref.revision = 'revision-2';
    await prepareActiveTask();
    const task = mock.store.state.tasks[0];
    const record = mock.store.state.preparations[task.id];
    expect(
      mock.offscreen.mock.calls.filter(([job]) => job.op === 'solve'),
    ).toHaveLength(2);
    expect(preparationMatches(record, mock.page, task, 'preserve', 1)).toBe(
      false,
    );
    expect(
      preparationMatches(
        { ...record, workflowVersion: 2 },
        mock.page,
        task,
        'preserve',
        mock.store.state.providerRevision,
      ),
    ).toBe(false);
    expect(preparationMatches(record, mock.page, task, 'overwrite', 0)).toBe(
      false,
    );
    expect(
      preparationMatches(
        record,
        { ...mock.page, accountId: 'cx:2' },
        task,
        'preserve',
        0,
      ),
    ).toBe(false);
  });
  it.each(['submitted', 'expired'])(
    '%s 页面只更新状态，不调用模型',
    async (status) => {
      mock.page.status = status;
      mock.page.grade = '90';
      await prepareActiveTask();
      expect(mock.offscreen).not.toHaveBeenCalled();
      expect(mock.store.state.tasks[0].status).toBe(status);
      expect(mock.store.state.tasks[0].grade).toBe('90');
    },
  );
  it('不支持的题目进入检查，缺少模型配置显示设置入口，不改动网页', async () => {
    mock.page.questions[0].issues = ['含图片，需人工处理'];
    await prepareActiveTask();
    expect(mock.store.state.preparations['cx:1:100:200:quiz:900'].phase).toBe(
      'review',
    );
    expect(mock.offscreen.mock.calls.some(([job]) => job.op === 'solve')).toBe(
      false,
    );
    mock.store.provider.apiKey = '';
    mock.store.state.preparations = {};
    await prepareActiveTask();
    expect(
      mock.store.state.preparations['cx:1:100:200:quiz:900'].note,
    ).toContain('配置模型');
  });
  it('旧页面仍显示待完成时，不为已核验提交的任务再次生成答案', async () => {
    mock.store.state.tasks = [
      { id: 'cx:1:100:200:quiz:900', status: 'submitted', grade: '90' },
    ];
    await prepareActiveTask();
    expect(mock.offscreen).not.toHaveBeenCalled();
    expect(mock.store.state.tasks[0].status).toBe('submitted');
    expect(mock.store.state.tasks[0].grade).toBe('90');
  });
  it('考试、后台扫描/执行标签页及执行中的队列不会触发准备', async () => {
    mock.ref.taskKind = 'exam';
    await prepareActiveTask();
    ownedTabs.add(1);
    mock.ref.taskKind = 'quiz';
    await prepareActiveTask();
    ownedTabs.clear();
    mock.store.state.queue.phase = 'running';
    await prepareActiveTask();
    expect(mock.offscreen).not.toHaveBeenCalled();
    expect(mock.frameCall).not.toHaveBeenCalled();
  });
  it('同一页面并发报告只发一个模型请求', async () => {
    let resolve: (value: unknown) => void = () => {};
    mock.offscreen.mockImplementation(async (job) =>
      job.op === 'restore'
        ? structuredClone(job.page)
        : new Promise((r) => {
            resolve = r;
          }),
    );
    const first = prepareActiveTask();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await prepareActiveTask();
    resolve(answers());
    await first;
    expect(
      mock.offscreen.mock.calls.filter(([job]) => job.op === 'solve'),
    ).toHaveLength(1);
  });
  it('模型返回前跳转到其他任务，旧结果标记失效，不执行任何写入', async () => {
    mock.offscreen.mockImplementation(async (job) => {
      if (job.op === 'restore') return structuredClone(job.page);
      mock.page.taskKey = '100:200:work:901';
      return answers();
    });
    await prepareActiveTask();
    expect(mock.store.state.preparations['cx:1:100:200:quiz:900'].phase).toBe(
      'error',
    );
    expect(
      mock.frameCall.mock.calls.every(
        ([, command]) => command.op === 'extract',
      ),
    ).toBe(true);
  });
  it('已有答案摘要包括各个填空值', () => {
    const first = existingAnswersDigest(mock.page);
    mock.page.questions[0].blanks = [
      { id: 'answer1', kind: 'input', value: '改变' },
    ];
    expect(existingAnswersDigest(mock.page)).not.toBe(first);
  });
});
describe('任务分类依据入口及上下文', () => {
  it('答题 DOM 新旧格式不影响章节/普通作业分类', () => {
    const work = 'https://mooc1.chaoxing.com/mooc2/work/dowork?workId=1';
    expect(classifyTaskPage(URL)).toBe('quiz');
    expect(classifyTaskPage(work)).toBe('homework');
    expect(
      classifyTaskPage(
        work,
        'https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=9',
      ),
    ).toBe('quiz');
    expect(classifyTaskPage(work, '', '期末考试')).toBe('exam');
    expect(
      classifyTaskPage('https://mooc1.chaoxing.com/exam-ans/exam/test'),
    ).toBe('exam');
  });
  it('iframe 从真实 referrer 补齐课程，但不继承父页面的其他任务 ID', () => {
    const doc = new DOMParser().parseFromString(
      '<input name="workId" value="1">',
      'text/html',
    );
    Object.defineProperty(doc, 'referrer', {
      value:
        'https://mooc1.chaoxing.com/knowledge/cards?courseid=100&clazzid=200&workId=999',
    });
    expect(taskIdentifiers('https://mooc1.chaoxing.com/api/work', doc)).toEqual(
      { course: '100', clazz: '200', work: '1' },
    );
  });
});
