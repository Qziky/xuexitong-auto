import {
  initialState,
  TEXT_PROCESSING_VERSION,
  type AppState,
  type LogEvent,
} from '../domain';
import { exportQuestions } from '../question-export';
import { rpc } from '../messages';
export const preview = !globalThis.chrome?.runtime?.id;
const demoStarted = Date.now();
let previewState: AppState | undefined;
/** Send a background command, or update the synthetic local preview state. */
export async function command<T = boolean>(
  kind: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  if (preview) {
    if (kind === 'state') return demoState() as T;
    if (kind === 'log-runs') return Object.values(demoState().operations) as T;
    if (kind === 'log-query') {
      const q = (extra.query ?? {}) as any;
      const events = demoLogs().filter(
        (e) =>
          (!q.runId || q.runId === e.runId) &&
          (!q.taskId || q.taskId === e.taskId) &&
          (!q.stage || q.stage === e.stage) &&
          (!q.level || q.level === e.level) &&
          (!q.search || e.message.includes(q.search)),
      );
      return { events: events.reverse() } as T;
    }
    if (kind === 'log-export')
      return {
        runs: Object.values(demoState().operations),
        events: demoLogs(),
      } as T;
    const state = demoState();
    if (kind === 'preferences') Object.assign(state.preferences, extra.value);
    else if (kind === 'save-learning-settings')
      state.learningSettings = extra.settings as AppState['learningSettings'];
    else if (kind === 'save-answer-settings')
      state.answerSettings = extra.settings as AppState['answerSettings'];
    else if (kind === 'answer-policy')
      state.draftPolicy = extra.policy as AppState['draftPolicy'];
    else if (kind === 'export-questions') {
      const record = state.preparations[String(extra.id)];
      if (!record?.decoded || !record.snapshot) throw new Error('请先识别文字');
      return exportQuestions(
        record.snapshot,
        record.proposals ?? [],
        extra.options as any,
      ) as T;
    } else if (kind === 'task-action' || kind === 'workspace-action') {
      const base = buildDemoState(false);
      const record = (state.preparations.t1 ??= base.preparations.t1!),
        workflow = (state.workflows.t1 ??= base.workflows.t1!),
        run = (state.operations['preview-run'] ??=
          base.operations['preview-run']!);
      const action = extra.action;
      if (action === 'decode') {
        record.decoded = true;
        record.phase = 'decoded';
        record.proposals = undefined;
        workflow.filled = false;
        run.note = '文字已确认，等待生成参考';
        run.stage = 'reviewing';
      }
      if (action === 'solve') {
        record.proposals = base.preparations.t1!.proposals;
        record.phase = 'ready';
        run.note = '参考已生成，等待你选择填写';
        run.stage = 'solving';
      }
      if (action === 'fill') {
        workflow.filled = true;
        workflow.readbackVerified = true;
        run.note = '填写并回读一致，等待保存或提交';
        run.stage = 'readback';
      }
      if (action === 'draft') {
        workflow.draftAttempted = true;
        workflow.draftVerified = true;
        workflow.phase = 'done';
        run.phase = 'done';
        run.note = '草稿已核验保存';
        run.stage = 'verifying';
      }
      if (action === 'submit') {
        workflow.submitAttempted = true;
        workflow.phase = 'done';
        run.phase = 'done';
        run.note = '界面演示：平台确认提交';
        run.stage = 'verifying';
      }
      if (action === 'decode-question' || action === 'solve-question') {
        record.resultRevision = (record.resultRevision ?? 0) + 1;
        run.note = '单题处理完成，其他题目保持不变';
      }
      record.at = Date.now();
      workflow.stage = run.stage;
      run.seq++;
    } else if (
      [
        'cancel-workflow',
        'cancel-operation',
        'pause',
        'stop',
        'cancel-scan',
        'pause-learning',
      ].includes(kind)
    ) {
      Object.values(state.operations).forEach((r) => {
        if (r.phase === 'running') r.phase = 'paused';
      });
      state.learning.phase = 'paused';
      state.queue.phase = 'paused';
    } else if (kind === 'log-clear') {
      return true as T;
    } else if (
      ![
        'open-task',
        'open-course',
        'open-homework-list',
        'open-learning',
        'open-login',
        'refresh-overview',
        'refresh-homework-list',
      ].includes(kind)
    )
      throw new Error('当前是界面预览，请在 Edge 扩展中执行此操作');
    state.revision = (state.revision ?? 0) + 1;
    previewState = state;
    window.dispatchEvent(
      new CustomEvent('preview-state', { detail: structuredClone(state) }),
    );
    return true as T;
  }
  return rpc<T>({ target: 'background', kind, ...extra });
}
export function demoState(): AppState {
  return structuredClone((previewState ??= buildDemoState()));
}
function buildDemoState(applyScenario = true): AppState {
  const s = initialState();
  const now = Date.now();
  s.accountId = 'demo';
  s.provider.hasKey = true;
  s.scan = {
    phase: 'done',
    completed: 3,
    total: 3,
    note: '已更新课程进度和普通作业列表',
    at: now - 6 * 60000,
  };
  s.courses = [
    ['c1', '合成课程 A', 12, 67, 0, 2],
    ['c2', '合成课程 B', 18, 65, 2, 2],
    ['c3', '合成课程 C', 35, 110, 1, 3],
  ].map(([id, title, completed, total, hc, ht]) => ({
    id: String(id),
    title: String(title),
    accountId: 'demo',
    courseId: String(id),
    classId: 'demo',
    cpi: '',
    url: '',
    state: 'active',
    source: { at: now, url: '', label: '示例' },
    warnings: [],
    taskPoints: { completed: Number(completed), total: Number(total) },
    homeworkCounts: { completed: Number(hc), total: Number(ht) },
  }));
  s.tasks = [
    {
      id: 't1',
      courseId: 'c1',
      title: '合成作业 1',
      type: 'homework',
      status: 'pending',
      deadline: now + 20 * 3600000,
    },
    {
      id: 't2',
      courseId: 'c1',
      title: '合成作业 2',
      type: 'homework',
      status: 'pending',
    },
    {
      id: 't3',
      courseId: 'c1',
      title: '概述',
      type: 'homework',
      status: 'pending',
      deadline: now + 66 * 3600000,
    },
    {
      id: 't4',
      courseId: 'c2',
      title: '合成测验',
      type: 'quiz',
      status: 'review',
      note: '第 8 题模型表示不确定，候选答案待检查',
    },
    {
      id: 't5',
      courseId: 'c2',
      title: '作业 2',
      type: 'homework',
      status: 'submitted',
      grade: '100',
    },
    {
      id: 't6',
      courseId: 'c3',
      title: '2.1 极限与连续',
      type: 'homework',
      status: 'unknown',
      note: '作业列表未提供明确完成状态',
    },
  ].map((t) => ({
    ...t,
    accountId: 'demo',
    url: '',
    platformId: t.id,
    source: { at: now, url: '', label: '示例' },
    discovery: t.type === 'quiz' ? 'opened' : 'list',
  })) as AppState['tasks'];
  s.progressRefreshedAt = now - 6 * 60000;
  for (const course of s.courses) {
    const works = s.tasks.filter(
      (t) => t.courseId === course.id && t.type === 'homework',
    );
    course.homeworkCounts = {
      completed: works.filter((t) => t.status === 'submitted').length,
      total: works.length,
    };
    s.homeworkCache[`${course.accountId}:${course.id}`] = {
      accountId: course.accountId,
      courseId: course.id,
      entryUrls: [],
      at: now - 6 * 60000,
      complete: true,
      taskIds: works.map((t) => t.id),
    };
  }
  s.events = [{ at: now - 6 * 60000, level: 'info', text: '课程清单已更新' }];
  s.preparations.t1 = {
    taskId: 't1',
    accountId: 'demo',
    courseId: 'c1',
    tabId: 1,
    frameId: 0,
    taskKey: 'c1:demo:work:t1',
    fingerprint: 'preview',
    existingDigest: 'preview',
    providerRevision: 0,
    policy: 'preserve',
    phase: 'ready',
    at: now,
    note: '示例候选答案已准备；点击一键完成后才填写并提交',
    snapshot: {
      adapter: 'modern',
      taskKey: 'c1:demo:work:t1',
      fingerprint: 'preview',
      accountId: 'demo',
      url: '',
      title: '合成作业 1',
      status: 'pending',
      questions: [
        {
          id: 'q1',
          number: 1,
          stem: '示例：本地配置文件通常使用哪个扩展名？',
          type: 'single',
          required: true,
          issues: [],
          existing: [],
          blanks: [],
          options: [
            { id: 'q1:o1', key: 'B', label: 'A', text: '.cfg' },
            { id: 'q1:o2', key: 'A', label: 'B', text: '.tmp' },
          ],
        },
        {
          id: 'q2',
          number: 2,
          stem: '示例：按顺序填写两个合成操作标签。',
          type: 'blank',
          required: true,
          issues: [],
          existing: [],
          options: [],
          blanks: [
            { id: 'b1', value: '', kind: 'input' },
            { id: 'b2', value: '', kind: 'input' },
          ],
        },
      ],
    },
    proposals: [
      {
        questionId: 'q1',
        optionIds: ['q1:o1'],
        explanation: '这是界面演示；候选答案尚未写入网页。',
        needsReview: false,
      },
      {
        questionId: 'q2',
        blanks: ['begin', 'finish'],
        explanation: '多个空位按页面顺序展示。',
        needsReview: false,
      },
    ],
  };
  const sampleQuestions = s.preparations.t1.snapshot!.questions;
  s.preparations.t1.workflowVersion = TEXT_PROCESSING_VERSION;
  s.preparations.t1.decoded = true;
  s.currentTaskId = 't1';
  s.tasks[0]!.questionCount = 2;
  s.operations['preview-run'] = {
    id: 'preview-run',
    taskId: 't1',
    accountId: 'demo',
    kind: 'manual',
    title: '合成作业 1',
    phase: 'waiting-user',
    stage: 'solving',
    startedAt: demoStarted - 120000,
    stageStartedAt: demoStarted - 30000,
    updatedAt: demoStarted,
    lastHeartbeatAt: now,
    lastProgressAt: demoStarted,
    seq: 10,
    done: 2,
    total: 2,
    note: '候选答案已生成；请查看结果并选择是否填写答案',
  };
  s.workflows.t1 = {
    taskId: 't1',
    runId: 'preview-run',
    stage: 'solving',
    phase: 'waiting-user',
    steps: {
      extracting: { status: 'done', note: '已确认账号与任务，读取 2 题' },
      restoring: {
        status: 'done',
        note: '3 个文字片段已确认：OCR 2 个，视觉兜底 1 个',
      },
      reviewing: { status: 'done', note: '文字复核通过，2/2 题可作答' },
      solving: {
        status: 'waiting-user',
        note: '已返回 2/2 题答案，等待你选择是否填写',
      },
    },
  };
  if (new URLSearchParams(location.search).get('scenario') === 'waiting') {
    Object.assign(s.operations['preview-run'], {
      phase: 'running',
      stage: 'restoring',
      note: '视觉兜底：第 7 题题干，等待模型响应',
      done: 70,
      total: 86,
      questionNumber: 7,
      part: '题干',
      engine: 'vision',
      waiting: 'model',
      requestStartedAt: demoStarted - 30000,
      timeoutSec: 180,
      attempt: 2,
      success: 69,
      review: 1,
    });
    s.workflows.t1.phase = 'running';
    s.workflows.t1.stage = 'restoring';
    s.workflows.t1.steps = {
      extracting: { status: 'done', note: '检测到 30 道题' },
      restoring: {
        status: 'running',
        note: '两次 OCR 校验不同，视觉兜底正在响应',
      },
    };
    s.tasks[0]!.questionCount = 30;
  }
  sampleQuestions[0]!.recognition = {
    stem: { source: 'web', attempts: [{ engine: 'web', success: true }] },
    options: Object.fromEntries(
      sampleQuestions[0]!.options.map((option) => [
        option.id,
        { source: 'web', attempts: [{ engine: 'web', success: true }] },
      ]),
    ),
  };
  sampleQuestions[1]!.recognition = {
    stem: {
      source: 'vision',
      attempts: [
        {
          engine: 'ocr',
          success: false,
          reason: '示例：两次识别结果不同',
          readings: [
            { text: '示例 OCR 初次文字', confidence: 86 },
            { text: '示例 OCR 第二次文字', confidence: 89 },
          ],
        },
        { engine: 'vision', success: true, text: sampleQuestions[1]!.stem },
      ],
    },
    options: {},
  };
  const scenario = applyScenario
    ? new URLSearchParams(location.search).get('scenario')
    : null;
  s.workspaces.demo = {
    id: 'demo',
    task: s.tasks[0]!,
    tabId: 1,
    frameId: 0,
    taskKey: s.preparations.t1.taskKey,
    bindingRevision: 'preview',
    at: now,
    capabilities: { analyze: true, fill: true, save: true, submit: true },
  };
  s.currentPage = {
    kind: 'questions',
    tabId: 1,
    url: '',
    workspaceId: 'demo',
    courseId: 'c1',
  };
  if (scenario === 'home') s.currentPage = { kind: 'home', tabId: 1, url: '' };
  if (scenario === 'learning' || scenario === 'reader') {
    s.currentPage = { kind: 'home', tabId: 1, url: '' };
    s.operations = {};
    s.queue.items = [];
    s.learning = {
      ...s.learning,
      id: 'preview-learning',
      accountId: 'demo',
      phase: 'running',
      range: 'both',
      selectedTypes: ['video', 'audio', 'document', 'image', 'quiz'],
      courseIds: ['c2'],
      runId: 'preview-run',
      startedAt: now - 90000,
      discovered: false,
      index: 1,
      note: '逐章发现并执行，已完成项不会重复读取。',
      items: [
        {
          id: 'read',
          title: '春节课件',
          chapterTitle: '第一章',
          type: 'document',
          courseId: 'c2',
          chapterId: '1',
          url: '',
          phase: 'done',
          platformComplete: true,
        },
        {
          id: 'play',
          title: scenario === 'reader' ? '春节第一章课件' : '春节第一章',
          chapterTitle: '第一章',
          type: scenario === 'reader' ? 'document' : 'video',
          courseId: 'c2',
          chapterId: '1',
          url: '',
          phase: scenario === 'reader' ? 'reading' : 'playing',
          position: 90,
          duration: 601.5,
          currentPage: 8,
          totalPages: 21,
          note:
            scenario === 'reader'
              ? '按阅读器页码顺序阅读'
              : '正常速度播放，达到条件后核验平台状态',
        },
      ],
    };
    s.operations['preview-run'] = {
      id: 'preview-run',
      kind: 'learning',
      phase: 'running',
      stage: 'checking',
      title: '自动学习',
      note: scenario === 'reader' ? '按页阅读' : '正常速度播放',
      lastHeartbeatAt: now,
      startedAt: now - 90000,
      stageStartedAt: now - 90000,
      updatedAt: now,
      lastProgressAt: now,
      seq: 1,
    };
  }
  if (scenario === 'course')
    s.currentPage = { kind: 'course', tabId: 1, url: '', courseId: 'c1' };
  if (scenario === 'readonly') {
    Object.assign(s.workspaces.demo.task, {
      status: 'submitted',
      analysisOnly: true,
      pageMode: 'preview',
    });
    s.workspaces.demo.capabilities = {
      analyze: true,
      fill: false,
      save: false,
      submit: false,
    };
  }
  if (scenario === 'detect') {
    s.preparations = {};
    s.workflows = {};
    s.operations = {};
  }
  if (scenario === 'math') {
    sampleQuestions[0]!.stem = String.raw`设 \(f(x)=\frac{x^2+1}{\sqrt{x+2}}\)，求 \(f(2)\)。`;
    sampleQuestions[0]!.options[0]!.text = String.raw`\(\frac{5}{2}\)`;
    sampleQuestions[0]!.options[1]!.text = String.raw`\(\sqrt{5}\)`;
    sampleQuestions[0]!.existing = ['q1:o1'];
    sampleQuestions[0]!.recognition!.stem.attempts = [
      { engine: 'vision', success: true, text: sampleQuestions[0]!.stem },
    ];
    sampleQuestions[1]!.stem = String.raw`根据公式 \[\sum_{k=1}^{n}k=\frac{n(n+1)}{2}\]，填写参数与结果。`;
    sampleQuestions[1]!.existing = [String.raw`\(n=4\)`, String.raw`\(10\)`];
    sampleQuestions[1]!.recognition!.stem.attempts = [
      { engine: 'vision', success: true, text: sampleQuestions[1]!.stem },
    ];
    s.preparations.t1!.proposals![0]!.explanation = String.raw`代入 \(x=2\)，得 \(f(2)=\frac{2^2+1}{\sqrt{2+2}}=\frac{5}{2}\)。`;
    s.preparations.t1!.proposals![1]!.blanks = [
      String.raw`\(n=4\)`,
      String.raw`\(10\)`,
    ];
  }
  if (scenario === 'long') {
    const samples = s.preparations.t1!.snapshot!.questions;
    s.preparations.t1!.snapshot!.questions = Array.from(
      { length: 45 },
      (_, i) => ({
        ...structuredClone(samples[i % 2]!),
        id: 'q' + (i + 1),
        number: i + 1,
      }),
    );
  }
  s.preparations.t1 && (s.preparations.t1.resultRevision = 1);
  s.preferences.developerMode = scenario === 'logs';
  return s;
}
function demoLogs(): LogEvent[] {
  return [
    '运行开始',
    '账号、任务、题目指纹核对通过',
    'OCR 第 1 次识别，置信度 86',
    'OCR 第 2 次识别，置信度 89',
    'OCR 需检查：两次识别结果不同',
    '视觉识别确认，采用视觉文字',
    '文字复核完成：2/2 题可作答',
    '模型请求开始，超时 180 秒',
    '模型正文已返回，正在校验',
    '第 1 题候选已返回，格式校验通过',
    '第 2 题候选已返回，格式校验通过',
    '等待你选择是否填写答案',
  ].map((message, i) => ({
    id: 'preview:' + i,
    runId: 'preview-run',
    taskId: 't1',
    seq: i,
    at: demoStarted - 120000 + i * 10000,
    level: i === 4 ? 'warn' : 'info',
    stage:
      i < 2
        ? 'extracting'
        : i < 6
          ? 'restoring'
          : i === 6
            ? 'reviewing'
            : 'solving',
    questionNumber: i > 1 ? 1 : undefined,
    code: 'preview-step',
    message,
  }));
}
