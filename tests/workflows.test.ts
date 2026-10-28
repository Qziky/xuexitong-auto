import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initialState,
  DEFAULT_PROVIDER,
  type PageSnapshot,
} from '../src/domain';
import { connectionHealth } from '../src/progress';
import { reconcileState } from '../src/ui/progress-state';
const mock = vi.hoisted(() => ({
  store: {
    state: undefined as any,
    provider: undefined as any,
    persist: vi.fn(async () => {}),
    log: vi.fn(),
    effectiveVisionProvider: vi.fn(),
  },
  offscreen: vi.fn(),
  frameCall: vi.fn(),
  discoverFrames: vi.fn(),
  page: undefined as any,
  ref: undefined as any,
  events: [] as any[],
  uncertain: false,
  failed: false,
  confirmedDraft: true,
  confirmedSubmit: true,
}));
vi.mock('../src/background/store', () => mock.store);
vi.mock('../src/background/transport', () => ({
  offscreen: mock.offscreen,
  frameCall: mock.frameCall,
  discoverFrames: mock.discoverFrames,
  delay: vi.fn(async (ms) => vi.setSystemTime(Date.now() + ms)),
}));
vi.mock('../src/background/journal', () => ({
  appendEvent: vi.fn(async (e) => {
    mock.events.push(structuredClone(e));
  }),
  putRun: vi.fn(async () => {}),
  pruneJournal: vi.fn(async () => {}),
  flushJournal: vi.fn(async () => {}),
  safeLogText: (s: string) => s,
}));
import {
  startTaskAction,
  confirmQuestionText,
  manualRunning,
  cancelWorkflowAndWait,
  cancelWorkflow,
} from '../src/background/workflows';
import { cancelChangedPreparation } from '../src/background/preparer';
it('只读页面可以识别和生成参考，后台始终拒绝写入', async () => {
  const task = mock.store.state.tasks[0];
  task.analysisOnly = true;
  task.pageMode = 'preview';
  task.status = 'expired';
  mock.page.status = 'unknown';
  mock.page.pageMode = 'preview';
  mock.ref.taskSummary = {
    pageMode: 'preview',
    status: 'unknown',
    questionCount: 1,
  };
  startTaskAction(id, 'decode', undefined, undefined, 'reference');
  await idle();
  expect(mock.store.state.preparations[id]?.decoded).toBe(true);
  startTaskAction(id, 'solve', undefined, undefined, 'reference');
  await idle();
  expect(mock.store.state.preparations[id]?.proposals).toHaveLength(1);
  expect(() =>
    startTaskAction(id, 'fill', undefined, undefined, 'reference'),
  ).toThrow('不能填写');
  expect(
    mock.frameCall.mock.calls.every(([, command]) => command.op === 'extract'),
  ).toBe(true);
});
it('参考模式对已有答案重新求解，保留模式填写仍保持网页原答案', async () => {
  mock.page.questions[0].existing = ['q1:o2'];
  startTaskAction(id, 'decode', undefined, undefined, 'reference');
  await idle();
  startTaskAction(id, 'solve', undefined, undefined, 'reference');
  await idle();
  expect(
    mock.offscreen.mock.calls.find(([job]) => job.op === 'solve')?.[0].policy,
  ).toBe('overwrite');
  expect(mock.store.state.preparations[id].proposals[0].optionIds).toEqual([
    'q1:o1',
  ]);
  startTaskAction(id, 'fill', undefined, undefined, 'reference');
  await idle();
  expect(mock.page.questions[0].existing).toEqual(['q1:o2']);
});
const id = 'cx:1:100:200:quiz:900';
const url =
  'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900';
async function idle() {
  for (let n = 0; n < 600; n++) await Promise.resolve();
  expect(manualRunning()).toBe(false);
}
async function action(a: 'decode' | 'solve' | 'fill' | 'draft' | 'submit') {
  const r = startTaskAction(id, a);
  await idle();
  return r;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.events.length = 0;
  mock.uncertain = mock.failed = false;
  mock.confirmedDraft = mock.confirmedSubmit = true;
  const s = (mock.store.state = initialState());
  s.accountId = 'cx:1';
  s.courses = [
    {
      id: '100:200',
      accountId: 'cx:1',
      courseId: '100',
      classId: '200',
      state: 'active',
      title: '课程',
      url,
      cpi: '',
      warnings: [],
      source: { url, at: 0, label: '测试' },
    },
  ];
  s.tasks = [
    {
      id,
      accountId: 'cx:1',
      courseId: '100:200',
      title: '测验',
      type: 'quiz',
      discovery: 'opened',
      status: 'pending',
      platformId: '900',
      url,
      source: { url, at: 0, label: '测试' },
    },
  ];
  mock.store.provider = { ...DEFAULT_PROVIDER, apiKey: 'test-placeholder' };
  mock.store.effectiveVisionProvider.mockImplementation(
    () => mock.store.provider,
  );
  mock.page = {
    taskKey: '100:200:work:900',
    fingerprint: 'fp',
    url,
    adapter: 'legacy',
    accountId: 'cx:1',
    title: '测验',
    status: 'pending',
    questions: [
      {
        id: 'q1',
        number: 1,
        stem: '示例题',
        type: 'single',
        required: true,
        existing: [],
        blanks: [],
        issues: [],
        options: [
          { id: 'q1:o1', key: 'B', label: 'A', text: '选项一' },
          { id: 'q1:o2', key: 'A', label: 'B', text: '选项二' },
        ],
      },
    ],
  } satisfies PageSnapshot;
  mock.ref = {
    tabId: 1,
    frameId: 3,
    taskKey: mock.page.taskKey,
    revision: 'revision',
    url,
    accountId: 'cx:1',
    taskKind: 'quiz',
    adapter: 'legacy',
    loginRequired: false,
  };
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [{ id: 1, url }]),
      get: vi.fn(async () => ({ id: 1, url })),
      update: vi.fn(async () => {}),
      create: vi.fn(async () => ({ id: 1, url })),
    },
  });
  mock.discoverFrames.mockImplementation(async () => [mock.ref]);
  mock.offscreen.mockImplementation(async (job) => {
    if (job.op === 'restore') {
      const p = structuredClone(job.page);
      if (mock.failed) p.questions[0].issues = ['文字未确认'];
      return p;
    }
    if (job.op === 'solve')
      return [
        {
          questionId: 'q1',
          optionIds: ['q1:o1'],
          explanation: '候选',
          needsReview: mock.uncertain,
        },
      ];
    if (job.op === 'fetch') return { url, html: '' };
    if (job.op === 'draft-snapshot')
      return mock.confirmedDraft ? structuredClone(mock.page) : undefined;
    if (job.op === 'status') return { status: 'unknown' };
  });
  mock.frameCall.mockImplementation(async (_ref, cmd) => {
    if (cmd.op === 'extract') return structuredClone(mock.page);
    if (cmd.op === 'fill') {
      mock.page.questions[0].existing = [...cmd.proposals[0].optionIds];
      return structuredClone(mock.page);
    }
    if (cmd.op === 'draft' || cmd.op === 'submit') return { clicked: true };
    if (cmd.op === 'confirm') {
      if (mock.confirmedSubmit) mock.page.status = 'submitted';
      return { confirmed: true };
    }
    if (cmd.op === 'result')
      return { status: mock.page.status, taskKey: mock.page.taskKey };
  });
});
afterEach(async () => {
  await cancelWorkflowAndWait();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('分步工作台实际后台流程', () => {
  it('重载清除准备缓存后可核验原草稿，不再保存或提交', async () => {
    await action('decode'); await action('solve'); await action('fill');
    mock.confirmedDraft = false;
    await action('draft');
    mock.store.state.preparations = {};
    mock.confirmedDraft = true;
    mock.frameCall.mockClear(); mock.offscreen.mockClear();
    await action('draft');
    expect(mock.store.state.workflows[id].draftVerified).toBe(true);
    expect(mock.frameCall.mock.calls.every(([,c]) => c.op === 'extract')).toBe(true);
    expect(mock.offscreen.mock.calls.some(([j]) => j.op === 'fetch' && j.fresh && j.purpose === 'result')).toBe(true);
  });
  it('重载后的草稿核验拒绝网页答案变化，不发起新的保存', async () => {
    await action('decode'); await action('solve'); await action('fill');
    mock.confirmedDraft = false; await action('draft');
    mock.store.state.preparations = {};
    mock.page.questions[0].existing = ['q1:o2'];
    mock.frameCall.mockClear(); mock.offscreen.mockClear();
    await action('draft');
    expect(mock.store.state.workflows[id].draftVerified).toBe(false);
    expect(mock.store.state.workflows[id].note).toContain('已有答案已变化');
    expect(mock.frameCall.mock.calls.every(([,c]) => c.op === 'extract')).toBe(true);
    expect(mock.offscreen).not.toHaveBeenCalled();
  });
  it('重新生成答案撤销以前的回读依据，必须再次填写后才能提交', async () => {
    await action('decode');
    await action('solve');
    await action('fill');
    await action('solve');
    expect(mock.store.state.workflows[id].filled).toBe(false);
    await action('submit');
    expect(mock.frameCall.mock.calls.some(([, c]) => c.op === 'submit')).toBe(
      false,
    );
  });
  it('解密不求解，求解不填写，填写不保存、不提交，阶段等待用户', async () => {
    mock.store.provider.apiKey = '';
    const first = startTaskAction(id, 'decode');
    expect(first.operationId).toBeTruthy();
    expect(mock.store.state.operations[first.operationId].stage).toBe(
      'extracting',
    );
    expect(mock.store.state.operations[first.operationId].phase).toBe(
      'running',
    );
    expect(startTaskAction(id, 'decode')).toEqual(first);
    await idle();
    expect(mock.store.state.operations[first.operationId].phase).toBe(
      'waiting-user',
    );
    expect(mock.offscreen.mock.calls.map(([j]) => j.op)).toEqual(['restore']);
    expect(mock.page.questions[0].existing).toEqual([]);
    mock.store.provider.apiKey = 'test-placeholder';
    await action('solve');
    // Repeating the same stage after user review must start a fresh stage clock.
    vi.setSystemTime(Date.now() + 300000);
    const resumedAt = Date.now();
    await action('solve');
    expect(
      mock.store.state.operations[first.operationId].stageStartedAt,
    ).toBeGreaterThanOrEqual(resumedAt);
    expect(
      mock.store.state.operations[first.operationId].stageStartedAt - resumedAt,
    ).toBeLessThan(1000);
    expect(
      mock.events.filter(
        (e) => e.code === 'stage-start' && e.stage === 'solving',
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(mock.offscreen.mock.calls.map(([j]) => j.op)).toEqual([
      'restore',
      'solve',
      'solve',
    ]);
    expect(mock.frameCall.mock.calls.every(([, c]) => c.op === 'extract')).toBe(
      true,
    );
    await action('fill');
    expect(mock.page.questions[0].existing).toEqual(['q1:o1']);
    expect(
      mock.frameCall.mock.calls.some(([, c]) =>
        ['draft', 'submit', 'confirm'].includes(c.op),
      ),
    ).toBe(false);
    expect(mock.store.state.workflows[id].readbackVerified).toBe(true);
    expect(
      mock.events.some(
        (e) => e.code === 'answer-filled' && e.questionNumber === 1,
      ),
    ).toBe(true);
    expect(mock.events.every((e) => e.runId === first.operationId)).toBe(true);
  });
  it('单题重做只生成新候选，保留网页答案且不填写', async () => {
    mock.store.state.answerSettings = { concurrency: 50, batchSize: 5 };
    mock.page.questions[0].existing = ['q1:o2'];
    await action('decode');
    await action('solve');
    const record = mock.store.state.preparations[id];
    const revision = record.resultRevision ?? 0;
    const started = startTaskAction(id, 'solve-question', 'q1', revision);
    await idle();
    expect(mock.store.state.operations[started.operationId].questionId).toBe(
      'q1',
    );
    expect(mock.store.state.preparations[id].proposals).toHaveLength(1);
    expect(mock.page.questions[0].existing).toEqual(['q1:o2']);
    expect(mock.frameCall.mock.calls.some(([, c]) => c.op === 'fill')).toBe(
      false,
    );
    expect(mock.offscreen.mock.calls.at(-1)?.[0]).toMatchObject({
      op: 'solve',
      answerConcurrency: 50,
      policy: 'overwrite',
      questions: [{ id: 'q1' }],
    });
    expect(mock.store.state.preparations[id].resultRevision).toBe(revision + 1);
    expect(() => startTaskAction(id, 'solve-question', 'q1', revision)).toThrow(
      /结果已更新/,
    );
  });
  it('单题动作重复点击合并；取消后的迟到候选不会覆盖旧结果', async () => {
    await action('decode');
    const record = mock.store.state.preparations[id];
    const previous = [
      {
        questionId: 'q1',
        optionIds: ['q1:o2'],
        explanation: '旧候选',
        needsReview: false,
      },
    ];
    record.proposals = structuredClone(previous);
    const original = mock.offscreen.getMockImplementation()!;
    let begin!: () => void;
    const started = new Promise<void>((resolve) => (begin = resolve));
    let release!: (value: unknown) => void;
    mock.offscreen.mockImplementation((job, ...args) => {
      if (job.op !== 'solve') return original(job, ...args);
      begin();
      return new Promise((resolve) => (release = resolve));
    });
    const revision = record.resultRevision ?? 0;
    const first = startTaskAction(id, 'solve-question', 'q1', revision);
    await started;
    expect(startTaskAction(id, 'solve-question', 'q1', revision)).toEqual(
      first,
    );
    cancelWorkflow();
    release([
      {
        questionId: 'q1',
        optionIds: ['q1:o1'],
        explanation: '迟到候选',
        needsReview: false,
      },
    ]);
    await idle();
    expect(mock.store.state.preparations[id].proposals).toEqual(previous);
    expect(mock.store.state.preparations[id].resultRevision).toBe(revision);
    expect(mock.store.state.operations[first.operationId].phase).toBe(
      'cancelled',
    );
    expect(mock.frameCall.mock.calls.some(([, c]) => c.op === 'fill')).toBe(
      false,
    );
  });
  it('单题解密只替换目标题目并使该题旧候选失效', async () => {
    mock.page.questions[0].obfuscated = true;
    await action('decode');
    const record = mock.store.state.preparations[id];
    record.proposals = [
      {
        questionId: 'q1',
        optionIds: ['q1:o1'],
        explanation: '',
        needsReview: false,
      },
      {
        questionId: 'q2',
        optionIds: ['q2:o1'],
        explanation: '',
        needsReview: false,
      },
    ];
    record.snapshot.questions.push({
      ...structuredClone(record.snapshot.questions[0]),
      id: 'q2',
      number: 2,
      stem: '其他题目',
      options: record.snapshot.questions[0].options.map((option: any) => ({
        ...option,
        id: option.id.replace('q1', 'q2'),
      })),
    });
    const beforeOther = structuredClone(record.snapshot.questions[1]);
    const revision = record.resultRevision ?? 0;
    const original = mock.offscreen.getMockImplementation()!;
    mock.offscreen.mockImplementation(async (job, ...args) => {
      const page = await original(job, ...args);
      if (job.op === 'restore' && job.page.questions.length === 1)
        page.questions[0].stem = '本题重新识别';
      return page;
    });
    const started = startTaskAction(id, 'decode-question', 'q1', revision);
    await idle();
    expect(mock.offscreen.mock.calls.at(-1)?.[0].page.questions).toHaveLength(
      1,
    );
    expect(mock.store.state.preparations[id].snapshot.questions[0].stem).toBe(
      '本题重新识别',
    );
    expect(mock.store.state.preparations[id].snapshot.questions[1]).toEqual(
      beforeOther,
    );
    expect(mock.store.state.preparations[id].proposals).toEqual([
      expect.objectContaining({ questionId: 'q2' }),
    ]);
    expect(mock.store.state.preparations[id].resultRevision).toBe(revision + 1);
    expect(mock.store.state.operations[started.operationId].questionId).toBe(
      'q1',
    );
  });
  it('人工确认只解除文字问题并在页面、答案或配置变化时拒绝应用', async () => {
    mock.page.questions[0].obfuscated = true;
    await action('decode');
    const record = mock.store.state.preparations[id];
    const question = record.snapshot.questions[0];
    question.issues = [
      '题干文字识别需检查（两次结果不同）',
      '图片题需人工处理',
    ];
    question.recognition = {
      stem: {
        attempts: [
          {
            engine: 'vision',
            success: false,
            text: 'OCR 预览',
            reason: '需人工复核',
          },
        ],
      },
      options: {},
    };
    await confirmQuestionText(id, 'q1', record.resultRevision ?? 0, {
      stem: '人工确认后的题干',
    });
    expect(question.stem).toBe('人工确认后的题干');
    expect(question.recognition.stem.source).toBe('manual');
    expect(question.issues).toEqual(['图片题需人工处理']);
    expect(record.proposals).toEqual([]);
    expect(record.resultRevision).toBe(1);
    expect(
      mock.events.some((event) => event.message.includes('人工确认后的题干')),
    ).toBe(false);
  });
  it('图片文字未确认时可人工修正，非文字问题及其他候选保留', async () => {
    await action('decode');
    const record = mock.store.state.preparations[id];
    const question = record.snapshot.questions[0];
    question.images = [
      {
        id: 'q1:image1',
        part: 'stem',
        placeholder: '〔图片1〕',
        resourceKey: 'fixture',
      },
    ];
    question.issues = [
      '题干文字识别需检查（图片不清晰）',
      '图片不是可完整转录的文字或公式，需人工处理',
    ];
    question.recognition = {
      stem: { attempts: [] },
      options: {},
      images: { 'q1:image1': { attempts: [] } },
    };
    await confirmQuestionText(id, 'q1', record.resultRevision ?? 0, {
      stem: String.raw`极限 \(\lim_{x\to1}7\)=____。`,
    });
    expect(question.recognition.stem.source).toBe('manual');
    expect(question.recognition.images['q1:image1'].source).toBe('manual');
    expect(question.issues).toEqual([
      '图片不是可完整转录的文字或公式，需人工处理',
    ]);
    expect(
      mock.frameCall.mock.calls.some(([, command]) =>
        ['fill', 'draft', 'submit'].includes(command.op),
      ),
    ).toBe(false);
  });
  it('预览任务禁止启动解密、求解及写入操作', () => {
    mock.store.state.tasks[0].pageMode = 'preview';
    for (const action of [
      'decode',
      'solve',
      'fill',
      'draft',
      'submit',
    ] as const)
      expect(() => startTaskAction(id, action)).toThrow('只读预览');
    expect(mock.offscreen).not.toHaveBeenCalled();
  });
  it('页面指纹过期后不应用人工确认文字', async () => {
    mock.page.questions[0].obfuscated = true;
    await action('decode');
    const record = mock.store.state.preparations[id];
    const question = record.snapshot.questions[0];
    question.recognition = { stem: { attempts: [] }, options: {} };
    mock.page.fingerprint = 'changed';
    await expect(
      confirmQuestionText(id, 'q1', record.resultRevision ?? 0, {
        stem: '不应应用',
      }),
    ).rejects.toThrow(/变化/);
    expect(question.stem).toBe('示例题');
    expect(question.recognition.stem.source).toBeUndefined();
  });
  it('可靠文字的不确定候选允许填写与草稿，但禁止提交', async () => {
    mock.uncertain = true;
    await action('decode');
    await action('solve');
    await action('fill');
    await action('submit');
    expect(mock.store.state.workflows[id].phase).toBe('error');
    expect(mock.frameCall.mock.calls.some(([, c]) => c.op === 'submit')).toBe(
      false,
    );
    await action('draft');
    expect(mock.store.state.workflows[id].draftVerified).toBe(true);
    expect(mock.store.state.workflows[id].phase).toBe('review');
  });
  it('服务端无法读取时只报告保存待确认，重复点击仅核验', async () => {
    mock.confirmedDraft = false;
    await action('decode');
    await action('solve');
    await action('fill');
    await action('draft');
    await action('draft');
    expect(
      mock.frameCall.mock.calls.filter(([, c]) => c.op === 'draft'),
    ).toHaveLength(1);
    expect(mock.store.state.workflows[id].draftVerified).toBe(false);
    expect(mock.store.state.workflows[id].phase).toBe('review');
  });
  it('完整答案提交后核验真实结果，不把点击视为成功', async () => {
    await action('decode');
    await action('solve');
    await action('fill');
    await action('submit');
    expect(mock.store.state.tasks[0].status).toBe('submitted');
    expect(mock.store.state.workflows[id].phase).toBe('done');
    expect(
      mock.frameCall.mock.calls.filter(([, c]) => c.op === 'submit'),
    ).toHaveLength(1);
  });
  it('结果不明的提交再次执行只核验，不再次填写或点击提交', async () => {
    mock.confirmedSubmit = false;
    mock.confirmedDraft = false;
    await action('decode');
    await action('solve');
    await action('fill');
    await action('submit');
    await action('submit');
    expect(mock.store.state.tasks[0].status).toBe('unknown');
    expect(
      mock.frameCall.mock.calls.filter(([, c]) => c.op === 'submit'),
    ).toHaveLength(1);
    expect(() => startTaskAction(id, 'decode')).toThrow(/核验/);
  });
  it('手动核验确认三次同答案未提交草稿后允许重新读取，但不自动提交', async () => {
    mock.confirmedSubmit = false;
    await action('decode'); await action('solve'); await action('fill'); await action('submit');
    mock.offscreen.mockClear();
    await action('submit');
    expect(mock.store.state.tasks[0].status).toBe('pending');
    expect(mock.store.state.workflows[id].submitAttempted).toBe(false);
    expect(mock.store.state.workflows[id].filled).toBe(false);
    expect(mock.store.state.preparations[id]).toBeUndefined();
    expect(mock.offscreen.mock.calls.filter(([j]) => j.op === 'draft-snapshot')).toHaveLength(3);
    expect(mock.frameCall.mock.calls.filter(([,c]) => c.op === 'submit')).toHaveLength(1);
    expect(mock.events.some(e => e.code === 'submit-not-applied')).toBe(true);
  });
  it('未提交核验中网页答案变化仍保留提交保护', async () => {
    mock.confirmedSubmit = false;
    await action('decode'); await action('solve'); await action('fill'); await action('submit');
    mock.page.questions[0].existing = ['q1:o2'];
    await action('submit');
    expect(mock.store.state.workflows[id].submitAttempted).toBe(true);
    expect(mock.frameCall.mock.calls.filter(([,c]) => c.op === 'submit')).toHaveLength(1);
  });
  it('识别失败的题目不求解、不填写，草稿列为待检查', async () => {
    mock.failed = true;
    await action('decode');
    await action('solve');
    await action('fill');
    await action('draft');
    expect(mock.offscreen.mock.calls.some(([j]) => j.op === 'solve')).toBe(
      false,
    );
    expect(mock.frameCall.mock.calls.some(([, c]) => c.op === 'fill')).toBe(
      false,
    );
    expect(mock.store.state.workflows[id].phase).toBe('review');
    expect(mock.events.some((e) => e.code === 'fill-skipped')).toBe(true);
  });
  it.each(['existing', 'fingerprint', 'config', 'policy', 'account'])(
    '%s 变化阻止旧结果填写',
    async (change) => {
      await action('decode');
      await action('solve');
      if (change === 'existing') mock.page.questions[0].existing = ['q1:o2'];
      if (change === 'fingerprint') mock.page.fingerprint = 'changed';
      if (change === 'config') mock.store.state.providerRevision++;
      if (change === 'policy') mock.store.state.draftPolicy = 'overwrite';
      if (change === 'account') mock.ref.accountId = 'cx:2';
      await action('fill');
      expect(mock.frameCall.mock.calls.some(([, c]) => c.op === 'fill')).toBe(
        false,
      );
    },
  );
  it('提交确认框等待期间修改答案立即停止确认', async () => {
    await action('decode');
    await action('solve');
    await action('fill');
    const original = mock.frameCall.getMockImplementation()!;
    mock.frameCall.mockImplementation(async (ref, c) => {
      const r = await original(ref, c);
      if (c.op === 'submit') mock.page.questions[0].existing = ['q1:o2'];
      return r;
    });
    await action('submit');
    expect(mock.frameCall.mock.calls.some(([, c]) => c.op === 'confirm')).toBe(
      false,
    );
    expect(mock.store.state.workflows[id].submitAttempted).toBe(true);
  });
  it('取消并丢弃迟到识别结果，保持页面答案不变', async () => {
    let release!: (v: any) => void;
    mock.offscreen.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const r = startTaskAction(id, 'decode');
    for (let n = 0; n < 60; n++) await Promise.resolve();
    cancelWorkflow();
    release(structuredClone(mock.page));
    await idle();
    expect(mock.store.state.operations[r.operationId].phase).toBe('cancelled');
    expect(mock.frameCall.mock.calls.some(([, c]) => c.op === 'fill')).toBe(
      false,
    );
  });
  it('页面重复报告与相同版本不取消，版本变化中断识别', async () => {
    let started!: () => void;
    const begin = new Promise<void>((r) => (started = r));
    mock.offscreen.mockImplementation((_job, signal) => {
      started();
      return new Promise((_r, reject) =>
        signal.addEventListener('abort', () => reject(new Error('已取消'))),
      );
    });
    startTaskAction(id, 'decode');
    await begin;
    cancelChangedPreparation({ ...mock.ref });
    expect(manualRunning()).toBe(true);
    cancelChangedPreparation({ ...mock.ref, revision: 'new' });
    await idle();
    expect(mock.store.state.workflows[id].phase).toBe('cancelled');
  });
  it('UI 拒绝旧快照覆盖新进度，30/60 秒连接状态有独立判定', async () => {
    const r = startTaskAction(id, 'decode');
    await idle();
    const current = structuredClone(mock.store.state);
    const incoming = structuredClone(current);
    incoming.operations[r.operationId].seq = 0;
    expect(
      reconcileState(current, incoming).operations[r.operationId]!.seq,
    ).toBe(current.operations[r.operationId]!.seq);
    expect(connectionHealth(0, 29999)).toBe('online');
    expect(connectionHealth(0, 30000)).toBe('delayed');
    expect(connectionHealth(0, 60000)).toBe('lost');
  });
});
