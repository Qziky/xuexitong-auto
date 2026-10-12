import type {
  AnswerProposal,
  DraftPolicy,
  PageSnapshot,
  TaskPreparation,
  TaskRecord,
  AnalysisIntent,
} from '../domain';
import { TEXT_PROCESSING_VERSION } from '../domain';
import { completeAnswer, existingProposal, needsSolve } from '../answers';
import { existingAnswersDigest, preparationMatches } from '../preparation';
import { mergeTaskRecords } from '../scan-cache';
import { state, provider, persist, effectiveVisionProvider } from './store';
import {
  discoverFrames,
  frameCall,
  offscreen,
  delay,
  taskFrame,
  type FrameRef,
} from './transport';
import { checkFrames } from './scan-control';
import {
  assertPlatformReady,
  holdPlatform,
  rethrowPlatformBlock,
} from './platform';
import { PlatformAccessError } from '../platform-access';
import { ownedTabs } from './owned-tabs';
import { taskIdentifiers, matchesTaskFrameKey } from '../task-context';
import { isChaoxingUrl } from '../security';
import type { ProgressDetail } from '../progress';
import { operationEvent, updateOperation } from './operations';
import { resolveTask, resolveWorkspace, assertTaskCapability } from '../page-workspace';
export type PreparationMode = 'full' | 'decode' | 'solve';
type PreparationProgress = (
  note: string,
  detail?: ProgressDetail,
) => Promise<void>;

let preparing:
  | {
      controller: AbortController;
      promise: Promise<void>;
      identity: string;
      ref: FrameRef;
    }
  | undefined;
let locating: AbortController | undefined;
let executionPriority = false;
let selectionVersion = 0;
export function cancelPreparation(): void {
  selectionVersion++;
  locating?.abort();
  preparing?.controller.abort();
}
export function cancelChangedPreparation(ref: FrameRef): void {
  const previous = preparing?.ref;
  if (
    previous &&
    ref.tabId === previous.tabId &&
    ref.frameId === previous.frameId &&
    (ref.taskKey !== previous.taskKey ||
      ref.revision !== previous.revision ||
      ref.url !== previous.url)
  )
    cancelPreparation();
}
export function cancelInactivePreparation(tabId: number): void {
  if (preparing && preparing.ref.tabId !== tabId) cancelPreparation();
}
export async function yieldPreparation(): Promise<void> {
  executionPriority = true;
  cancelPreparation();
  await preparing?.promise;
}
export function releasePreparationPriority(): void {
  executionPriority = false;
}
export function reusablePreparation(
  page: PageSnapshot,
  task: TaskRecord,
  policy: DraftPolicy,
): TaskPreparation | undefined {
  const record = state.preparations[task.id];
  return preparationMatches(record, page, task, policy, state.providerRevision)
    ? record
    : undefined;
}
export interface CandidateAnswers {
  page: PageSnapshot;
  proposals: AnswerProposal[];
  modelProblem?: string;
}
export async function decodePage(
  raw: PageSnapshot,
  signal: AbortSignal,
  progress: PreparationProgress,
  runId?: string,
  forceQuestionIds?: string[],
): Promise<PageSnapshot> {
  await progress('正在还原题目文字', { stage: 'restoring' });
  const page = await offscreen<PageSnapshot>(
    {
      op: 'restore',
      page: raw,
      recognition: structuredClone(state.recognition),
      visionProvider: effectiveVisionProvider(),
      forceQuestionIds,
    },
    signal,
    runId,
  );
  await progress('正在复核文字与题型', {
    stage: 'reviewing',
    done: 0,
    total: page.questions.length,
  });
  for (const q of page.questions) {
    operationEvent(
      runId,
      `第 ${q.number} 题${q.issues.length ? '需要检查：' + q.issues.join('；') : '文字与题型复核通过'}`,
      {
        code: q.issues.length ? 'question-review' : 'question-confirmed',
        questionNumber: q.number,
      },
      q.issues.length ? 'warn' : 'info',
    );
  }
  const good = page.questions.filter(
    (q) => !q.issues.length && q.type !== 'unsupported',
  ).length;
  await progress(
    `文字复核完成：${good}/${page.questions.length} 题可作答，${page.questions.length - good} 题需检查`,
    {
      stage: 'reviewing',
      done: page.questions.length,
      total: page.questions.length,
      success: good,
      review: page.questions.length - good,
    },
  );
  return page;
}
export async function generateCandidateAnswers(
  raw: PageSnapshot,
  policy: DraftPolicy,
  signal: AbortSignal,
  progress: PreparationProgress,
  runId?: string,
): Promise<CandidateAnswers> {
  const page = await decodePage(raw, signal, progress, runId);
  return solveDecodedPage(page, policy, signal, progress, runId);
}
export async function solveDecodedPage(
  page: PageSnapshot,
  policy: DraftPolicy,
  signal: AbortSignal,
  progress: PreparationProgress,
  runId?: string,
  intent: AnalysisIntent = 'execution',
  onBatch?: (proposals: AnswerProposal[]) => void,
): Promise<CandidateAnswers> {
  const solvePolicy = intent === 'reference' ? 'overwrite' : policy;
  const proposals = page.questions
    .filter(
      (q) =>
        !needsSolve(q, solvePolicy) &&
        !q.issues.length &&
        q.type !== 'unsupported',
    )
    .map(existingProposal);
  const needed = page.questions.filter(
    (q) =>
      needsSolve(q, solvePolicy) &&
      !q.issues.length &&
      q.type !== 'unsupported',
  );
  let modelProblem: string | undefined;
  await progress(
    `待生成 ${needed.length} 题答案，保留 ${proposals.length} 题已有答案`,
    { stage: 'solving', done: 0, total: needed.length },
  );
  if (needed.length && !provider.apiKey)
    throw new Error('请在设置中配置答题模型服务');
  for (let i = 0; i < needed.length; i += 5) {
    if (signal.aborted) throw new Error('操作已取消');
    assertPlatformReady();
    await progress(
      `请求第 ${Math.floor(i / 5) + 1}/${Math.ceil(needed.length / 5)} 批答案，题号 ${needed
        .slice(i, i + 5)
        .map((q) => q.number)
        .join('、')}（已返回 ${i}/${needed.length} 题）`,
      {
        stage: 'solving',
        done: i,
        total: needed.length,
        questionNumber: needed[i]!.number,
        code: 'solve-batch-start',
      },
    );
    try {
      proposals.push(
        ...(await offscreen<AnswerProposal[]>(
          {
            op: 'solve',
            priority:
              runId && state.operations[runId]?.kind === 'queue' ? 1 : 0,
            provider: { ...provider },
            questions: needed.slice(i, i + 5),
            policy: solvePolicy,
          },
          signal,
          runId,
        )),
      );
      for (const proposal of proposals) proposal.source ??= 'model';
      onBatch?.(structuredClone(proposals));
      for (const q of needed.slice(i, i + 5))
        operationEvent(
          runId,
          `第 ${q.number} 题候选已返回${proposals.find((p) => p.questionId === q.id)?.needsReview ? '，模型表示不确定' : '，格式校验通过'}`,
          { code: 'answer-validated', questionNumber: q.number },
        );
      await progress(
        `已返回 ${Math.min(i + 5, needed.length)}/${needed.length} 题答案`,
        {
          stage: 'solving',
          done: Math.min(i + 5, needed.length),
          total: needed.length,
          waiting: undefined,
          requestStartedAt: undefined,
        },
      );
    } catch (error) {
      rethrowPlatformBlock(error);
      if (signal.aborted || /鉴权|API Key/.test(String(error))) throw error;
      modelProblem = error instanceof Error ? error.message : '模型求解失败';
      break;
    }
  }
  return { page, proposals, modelProblem };
}
function taskFromPage(ref: FrameRef, page: PageSnapshot): TaskRecord {
  if (!['quiz', 'homework'].includes(ref.taskKind ?? ''))
    throw new Error('当前页面不是可识别的测验或普通作业');
  const match = page.taskKey.match(/^([^:]+):([^:]+):work:([^:]+)$/);
  if (!match) throw new Error('无法确认题目所属课程，请先回到课程页面');
  const course = state.courses.find(
    (c) =>
      c.accountId === state.accountId &&
      c.courseId === match[1] &&
      c.classId === match[2] &&
      c.state === 'active',
  );
  if (!course || page.accountId !== state.accountId)
    throw new Error('当前任务不属于已确认账号的在读课程');
  const type = ref.taskKind as 'quiz' | 'homework';
  const id = `${course.accountId}:${course.id}:${type}:${match[3]}`;
  const old = state.tasks.find((t) => t.id === id);
  return {
    ...old,
    id,
    accountId: course.accountId,
    courseId: course.id,
    title: page.title || old?.title || '当前任务',
    platformId: match[3]!,
    url: ref.url,
    type,
    status: page.status,
    grade: page.grade ?? old?.grade,
    pageMode: page.pageMode,
    deadline: page.deadline ?? old?.deadline,
    note: undefined,
    discovery: 'opened',
    source: {
      url: ref.url,
      at: Date.now(),
      label: type === 'quiz' ? '已打开的章节测验' : '已打开的普通作业',
    },
  };
}
export async function prepareActiveTask(
  mode: PreparationMode = 'full',
  runId?: string,
): Promise<void> {
  if (
    executionPriority ||
    ['running'].includes(state.queue.phase) ||
    state.platformBlock
  )
    return;
  const selection = ++selectionVersion;
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (selection !== selectionVersion) return;
  if (!tab?.id || ownedTabs.has(tab.id)) {
    cancelPreparation();
    state.currentTaskId = undefined;
    await persist();
    return;
  }
  const all = await discoverFrames(tab.id);
  if (selection !== selectionVersion) return;
  const candidates = all.filter(
    (ref) =>
      ref.adapter &&
      ['quiz', 'homework'].includes(ref.taskKind ?? '') &&
      !ref.loginRequired &&
      !ref.verificationRequired,
  );
  if (all.some((ref) => ref.taskKind === 'exam') || candidates.length !== 1) {
    cancelPreparation();
    state.currentTaskId = undefined;
    await persist();
    return;
  }
  await prepareRef(candidates[0]!, all, selection, mode, runId);
}

function expectedTaskKey(task: TaskRecord): string {
  const course = state.courses.find(
    (item) => item.id === task.courseId && item.accountId === task.accountId,
  );
  const identifiers = taskIdentifiers(task.url);
  const courseId = course?.courseId ?? identifiers.course;
  const classId = course?.classId ?? identifiers.clazz;
  if (!courseId || !classId) throw new Error('无法确认任务所属课程');
  return `${courseId}:${classId}:work:${task.platformId}`;
}

/** Explicit user action: open/reuse exactly this task and prepare candidates only. */
export async function prepareTask(
  taskId: string,
  mode: PreparationMode = 'full',
  runId?: string,
  signal?: AbortSignal,
  intent: AnalysisIntent = 'execution',
): Promise<void> {
  const task = resolveTask(state, taskId);
  const workspace = resolveWorkspace(state, taskId);
  if (!task || !['quiz', 'homework'].includes(task.type))
    throw new Error('请选择有效的测验或普通作业');
  if (!isChaoxingUrl(task.url)) throw new Error('任务入口无效');
  if (
    intent === 'execution' &&
    ['submitted', 'complete', 'expired'].includes(task.status)
  )
    throw new Error('该任务已提交或已截止');
  if (
    executionPriority ||
    state.queue.phase === 'running' ||
    state.platformBlock
  )
    throw new Error('当前执行队列或平台暂停中，暂不能生成候选答案');

  const selection = ++selectionVersion;
  locating?.abort();
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    preparing?.controller.abort();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  locating = controller;
  const expected = expectedTaskKey(task);
  try {
    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (selection !== selectionVersion) return;

    let tabId = workspace?.tabId ?? active?.id;
    let all = tabId === undefined ? [] : await discoverFrames(tabId);
    if (selection !== selectionVersion) return;
    if (all.length) checkFrames(all, state.accountId);
    let ref = all.find(
      (item) =>
        !ownedTabs.has(item.tabId) &&
        matchesTaskFrameKey(
          item,
          expected,
          state.preparations[task.id]?.snapshot?.taskKey,
        ) &&
        item.taskKind === task.type,
    );

    if (!ref) {
      if (workspace)
        throw new Error('当前页绑定已失效，请返回该题目页后重新读取');
      const tab = await chrome.tabs.create({ url: task.url, active: true });
      if (tab.id === undefined) throw new Error('无法打开任务页面');
      tabId = tab.id;
      const found = await taskFrame(
        tabId,
        task.platformId,
        controller.signal,
        expected,
        state.preparations[task.id]?.snapshot?.taskKey,
      );
      if (selection !== selectionVersion) return;
      if (found.ref.taskKind !== task.type)
        throw new Error('页面类型与所选任务不一致，未生成候选答案');
      all = await discoverFrames(tabId);
      checkFrames(all, state.accountId);
      ref =
        all.find(
          (item) =>
            matchesTaskFrameKey(
              item,
              expected,
              state.preparations[task.id]?.snapshot?.taskKey,
            ) &&
            item.taskKind === task.type,
        ) ?? found.ref;
    }
    if (selection !== selectionVersion) return;
    if (!ref) throw new Error('未找到所选任务的答题页面');
    if (intent === 'execution' && ref.taskSummary?.pageMode === 'preview') {
      task.pageMode = 'preview';
      task.note = '此入口仅供预览，没有答题控件；请打开尚未截止任务的答题页面';
      await persist();
      throw new Error(task.note);
    }
    if (ref.loginRequired || ref.accountId !== state.accountId)
      throw new Error('登录账号已变化，请重新登录并确认课程');
    if (active?.id !== ref.tabId)
      await chrome.tabs.update(ref.tabId, { active: true });
    if (selection !== selectionVersion) return;
    await prepareRef(
      ref,
      all,
      selection,
      mode,
      runId,
      controller.signal,
      task,
      intent,
    );
  } finally {
    if (locating === controller) locating = undefined;
    signal?.removeEventListener('abort', cancel);
  }
}

/** Re-decode or re-solve a single question while keeping every other result. */
export async function prepareQuestion(
  taskId: string,
  questionId: string,
  action: 'decode-question' | 'solve-question',
  runId: string,
  signal: AbortSignal,
  expectedRevision?: number,
): Promise<void> {
  const task = resolveTask(state, taskId);
  const record = state.preparations[taskId];
  if (!task || !record?.snapshot || !record.decoded)
    throw new Error('请先读取并解密整份任务');
  if (record.workflowVersion !== TEXT_PROCESSING_VERSION)
    throw new Error('文字处理版本已更新，请重新解密整份任务');
  if (record.accountId !== state.accountId || record.taskId !== task.id)
    throw new Error('任务账号已变化，请重新读取');
  const revision = record.resultRevision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== revision)
    throw new Error('题目结果已更新，请重新打开详情');
  const sourceQuestion = record.snapshot.questions.find(
    (question) => question.id === questionId,
  );
  if (!sourceQuestion) throw new Error('找不到要处理的题目');
  if (record.policy !== state.draftPolicy)
    throw new Error('答题策略已变化，请重新解密');
  if (record.providerRevision !== state.providerRevision)
    throw new Error('模型设置已变化，请重新解密');
  const all = await discoverFrames(record.tabId);
  checkFrames(all, state.accountId);
  const ref = all.find(
    (frame) =>
      frame.frameId === record.frameId && frame.taskKey === record.taskKey,
  );
  if (
    !ref ||
    ref.taskKind !== task.type ||
    ref.loginRequired ||
    ref.accountId !== record.accountId
  )
    throw new Error('未找到原答题页面或登录已变化');
  const raw = await frameCall<PageSnapshot | undefined>(ref, { op: 'extract' });
  if (
    !raw ||
    (record.intent !== 'reference' && raw.status !== 'pending') ||
    raw.accountId !== record.accountId ||
    raw.taskKey !== record.taskKey ||
    raw.fingerprint !== record.fingerprint ||
    existingAnswersDigest(raw) !== record.existingDigest
  )
    throw new Error('页面、已有答案或任务状态已变化，单题结果未应用');
  const rawQuestion = raw.questions.find(
    (question) => question.id === questionId,
  );
  if (!rawQuestion) throw new Error('当前页面已没有该题目');
  const progress: PreparationProgress = async (note, detail = {}) => {
    updateOperation(
      runId,
      note,
      {
        ...detail,
        questionId,
        questionNumber: sourceQuestion.number,
      },
      task.id,
    );
    await persist();
  };
  if (action === 'decode-question') {
    await progress('正在重新读取本题文字', { stage: 'extracting' });
    const oneQuestion: PageSnapshot = {
      ...raw,
      questions: [structuredClone(rawQuestion)],
    };
    const decoded = await decodePage(oneQuestion, signal, progress, runId, [
      questionId,
    ]);
    assertPlatformReady();
    if (signal.aborted) throw new Error('操作已取消');
    const current = await frameCall<PageSnapshot | undefined>(ref, {
      op: 'extract',
    });
    if (
      state.preparations[taskId] !== record ||
      (record.resultRevision ?? 0) !== revision ||
      state.accountId !== record.accountId ||
      state.providerRevision !== record.providerRevision ||
      !current ||
      (record.intent !== 'reference' && current.status !== 'pending') ||
      current.accountId !== record.accountId ||
      current.taskKey !== record.taskKey ||
      current.fingerprint !== record.fingerprint ||
      state.draftPolicy !== record.policy ||
      existingAnswersDigest(current) !== record.existingDigest
    )
      throw new Error('页面、题目或配置已变化，本题解密结果未应用');
    const index = record.snapshot.questions.findIndex(
      (question) => question.id === questionId,
    );
    if (index < 0) throw new Error('当前题目列表已变化');
    decoded.questions[0]!.textRevision =
      (record.snapshot.questions[index]!.textRevision ?? 0) + 1;
    const snapshot = structuredClone(record.snapshot);
    snapshot.questions[index] = decoded.questions[0]!;
    record.snapshot = snapshot;
    record.proposals = (record.proposals ?? []).filter(
      (proposal) => proposal.questionId !== questionId,
    );
    record.resultRevision = revision + 1;
    record.phase = snapshot.questions.some((question) => question.issues.length)
      ? 'review'
      : 'decoded';
    record.note = `第 ${sourceQuestion.number} 题已重新解密；请检查识别结果并选择是否重做答案`;
  } else {
    const currentQuestion = record.snapshot.questions.find(
      (question) => question.id === questionId,
    )!;
    if (currentQuestion.issues.length || currentQuestion.type === 'unsupported')
      throw new Error('本题文字仍需确认或题型不支持，不能生成候选');
    await progress('正在为本题生成新候选，不会填写网页', {
      stage: 'solving',
      done: 0,
      total: 1,
    });
    const proposals = await offscreen<AnswerProposal[]>(
      {
        op: 'solve',
        provider: { ...provider },
        questions: [structuredClone(currentQuestion)],
        policy: 'overwrite',
      },
      signal,
      runId,
    );
    assertPlatformReady();
    if (signal.aborted) throw new Error('操作已取消');
    const current = await frameCall<PageSnapshot | undefined>(ref, {
      op: 'extract',
    });
    if (
      state.preparations[taskId] !== record ||
      (record.resultRevision ?? 0) !== revision ||
      state.accountId !== record.accountId ||
      state.providerRevision !== record.providerRevision ||
      !current ||
      (record.intent !== 'reference' && current.status !== 'pending') ||
      current.accountId !== record.accountId ||
      current.taskKey !== record.taskKey ||
      current.fingerprint !== record.fingerprint ||
      state.draftPolicy !== record.policy ||
      existingAnswersDigest(current) !== record.existingDigest
    )
      throw new Error('页面、答案、策略或配置已变化，本题候选未应用');
    record.proposals = [
      ...(record.proposals ?? []).filter(
        (proposal) => proposal.questionId !== questionId,
      ),
      ...proposals,
    ];
    record.resultRevision = revision + 1;
    record.phase =
      record.snapshot!.questions.some((question) => question.issues.length) ||
      [...(record.proposals ?? []), ...proposals].some(
        (proposal) => proposal.needsReview,
      )
        ? 'review'
        : 'ready';
    record.note = `第 ${sourceQuestion.number} 题候选已更新；网页答案保持原样`;
  }
  const workflow = state.workflows[taskId];
  if (workflow) {
    workflow.resultRevision = record.resultRevision;
    workflow.filled = false;
    workflow.readbackVerified = false;
    workflow.expectedDigest = undefined;
    for (const stage of [
      'filling',
      'readback',
      'saving',
      'submitting',
    ] as const)
      delete workflow.steps[stage];
  }
  await persist();
}

async function prepareRef(
  ref: FrameRef,
  all: FrameRef[],
  selection: number,
  mode: PreparationMode = 'full',
  runId?: string,
  signal?: AbortSignal,
  selectedTask?: TaskRecord,
  intent: AnalysisIntent = 'execution',
): Promise<void> {
  const identity = `${ref.tabId}:${ref.frameId}:${ref.taskKey}:${ref.revision}`;
  if (preparing?.identity === identity && !preparing.controller.signal.aborted)
    return;
  if (preparing) {
    preparing.controller.abort();
    await preparing.promise;
  }
  if (selection !== selectionVersion) return;
  if (
    executionPriority ||
    state.queue.phase === 'running' ||
    state.platformBlock
  )
    return;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const promise = prepare(
    ref,
    all,
    controller.signal,
    mode,
    runId,
    selectedTask,
    intent,
  ).finally(() => {
    signal?.removeEventListener('abort', cancel);
    if (preparing?.controller === controller) preparing = undefined;
  });
  preparing = { identity, controller, promise, ref: { ...ref } };
  await promise;
}
async function prepare(
  ref: FrameRef,
  all: FrameRef[],
  signal: AbortSignal,
  mode: PreparationMode = 'full',
  runId?: string,
  selectedTask?: TaskRecord,
  intent: AnalysisIntent = 'execution',
): Promise<void> {
  let record: TaskPreparation | undefined;
  try {
    checkFrames(all, state.accountId);
    if (
      mode !== 'solve' &&
      ref.hasObfuscatedText &&
      state.recognition.strategy !== 'vision-only'
    )
      void offscreen({ op: 'warm-ocr' }, signal).catch(() => {});
    updateOperation(runId, '正在读取题目和页面身份', { stage: 'extracting' });
    const raw = await frameCall<PageSnapshot | undefined>(ref, {
      op: 'extract',
    });
    if (!raw || !raw.questions.length) return;
    const task = selectedTask ?? taskFromPage(ref, raw);
    assertTaskCapability(task, 'analyze');
    if (
      task.accountId !== raw.accountId ||
      expectedTaskKey(task) !== raw.taskKey
    )
      throw new Error('当前页与所选任务绑定不一致');
    if (!task.analysisOnly) state.tasks = mergeTaskRecords(state.tasks, [task]);
    state.currentTaskId = task.id;
    const confirmed = resolveTask(state, task.id)!;
    if (
      intent !== 'reference' &&
      (['submitted', 'complete', 'expired'].includes(raw.status) ||
        ['submitted', 'complete'].includes(confirmed.status))
    ) {
      delete state.preparations[task.id];
      await persist();
      return;
    }
    const cached = mode === 'full'
      ? reusablePreparation(raw, task, state.draftPolicy)
      : undefined;
    if (cached) {
      // The content is reusable; its old tab binding is not. Extraction above
      // has checked the current page and answers before accepting this cache.
      cached.tabId = ref.tabId;
      cached.frameId = ref.frameId;
      cached.at = Date.now();
      cached.snapshot!.url = raw.url;
      operationEvent(runId, '复用已校验的候选答案', {
        code: 'candidate-cache',
      });
      await persist();
      return;
    }
    const previous = state.preparations[task.id];
    const sameContent =
      previous?.snapshot &&
      previous.fingerprint === raw.fingerprint &&
      previous.accountId === raw.accountId &&
      previous.taskKey === raw.taskKey &&
      previous.workflowVersion === TEXT_PROCESSING_VERSION;
    const reusableDecoded =
      previous?.decoded &&
      previous.snapshot &&
      previous.workflowVersion === TEXT_PROCESSING_VERSION &&
      previous.accountId === raw.accountId &&
      previous.taskKey === raw.taskKey &&
      previous.fingerprint === raw.fingerprint &&
      previous.existingDigest === existingAnswersDigest(raw) &&
      previous.providerRevision === state.providerRevision &&
      previous.policy === state.draftPolicy;
    if (mode === 'solve' && !reusableDecoded)
      throw new Error('请先完成解密；页面、已有答案或设置变化后需重新解密');
    record = {
      taskId: task.id,
      accountId: task.accountId,
      courseId: task.courseId,
      tabId: ref.tabId,
      frameId: ref.frameId,
      taskKey: raw.taskKey,
      fingerprint: raw.fingerprint,
      existingDigest: existingAnswersDigest(raw),
      policy: state.draftPolicy,
      intent,
      recognitionRevision: state.recognitionRevision,
      answerRevision: state.answerRevision,
      providerRevision: state.providerRevision,
      phase: 'extracting',
      workflowVersion: TEXT_PROCESSING_VERSION,
      resultRevision: 0,
      at: Date.now(),
      snapshot: raw,
    };
    state.preparations[task.id] = record;
    // Keep the session cache bounded and never persist raw font resources.
    const older = Object.values(state.preparations)
      .sort((a, b) => b.at - a.at)
      .slice(20);
    older.forEach((item) => {
      delete state.preparations[item.taskId];
    });
    await persist();
    if (intent !== 'reference' && raw.status !== 'pending') {
      record.phase = 'review';
      record.note = '平台完成状态无法确认，请到原页面核对';
      return;
    }
    if (mode === 'full' && !provider.apiKey) {
      record.phase = 'error';
      record.note = '请在设置中配置模型服务后重新生成答案';
      return;
    }
    if (
      mode !== 'solve' &&
      raw.questions.some(
        (q) => q.obfuscated || q.options.some((o) => o.obfuscated),
      ) &&
      state.recognition.strategy !== 'vision-only'
    )
      void offscreen({ op: 'warm-ocr' }, signal).catch(() => {});
    await delay(350, signal);
    const stable = await frameCall<PageSnapshot | undefined>(ref, {
      op: 'extract',
    });
    if (
      !stable ||
      stable.fingerprint !== raw.fingerprint ||
      stable.taskKey !== raw.taskKey ||
      existingAnswersDigest(stable) !== record.existingDigest
    )
      throw new Error('页面仍在变化，请等待题目加载后重新读取');
    const progress: PreparationProgress = async (note, detail) => {
      record!.phase =
        detail?.stage === 'restoring'
          ? 'restoring'
          : detail?.stage === 'solving'
            ? 'solving'
            : 'extracting';
      record!.note = note;
      updateOperation(runId, note, detail);
      await persist();
    };
    let page = mode === 'solve' ? structuredClone(previous!.snapshot!) : raw;
    if (mode !== 'solve') {
      const retained = new Set(
        sameContent
          ? (previous!.retainedQuestionIds ??
              (previous!.recognitionRevision === state.recognitionRevision
                ? previous!
                    .snapshot!.questions.filter((q) => !q.issues.length)
                    .map((q) => q.id)
                : []))
          : [],
      );
      const needed = raw.questions.filter((q) => !retained.has(q.id));
      const restored = needed.length
        ? await decodePage(
            { ...raw, questions: needed },
            signal,
            progress,
            runId,
          )
        : undefined;
      page = {
        ...raw,
        questions: raw.questions.map((q) => {
          if (retained.has(q.id)) {
            const saved = structuredClone(
              previous!.snapshot!.questions.find((old) => old.id === q.id)!,
            );
            saved.existing = [...q.existing];
            saved.blanks.forEach((blank, index) => {
              blank.value = q.blanks[index]!.value;
            });
            return saved;
          }
          return restored!.questions.find((item) => item.id === q.id)!;
        }),
      };
    }
    record.decoded = true;
    record.snapshot = page;
    const candidate =
      mode === 'decode'
        ? { page, proposals: [] as AnswerProposal[], modelProblem: undefined }
        : await solveDecodedPage(
            page,
            record.policy,
            signal,
            progress,
            runId,
            intent,
            (proposals) => {
              if (
                !signal.aborted &&
                state.preparations[task.id] === record &&
                record!.providerRevision === state.providerRevision
              ) {
                record!.proposals = proposals;
                void persist();
              }
            },
          );
    assertPlatformReady();
    if (signal.aborted) throw new Error('准备已取消');
    const current = await frameCall<PageSnapshot | undefined>(ref, {
      op: 'extract',
    });
    if (
      !current ||
      (intent !== 'reference' && current.status !== 'pending') ||
      current.accountId !== record.accountId ||
      current.taskKey !== record.taskKey ||
      current.fingerprint !== record.fingerprint ||
      existingAnswersDigest(current) !== record.existingDigest ||
      state.providerRevision !== record.providerRevision ||
      state.draftPolicy !== record.policy
    )
      throw new Error('页面、已有答案或模型设置已变化，候选答案未应用');
    record.snapshot = candidate.page;
    record.proposals = candidate.proposals;
    const complete =
      !candidate.modelProblem &&
      candidate.page.questions.every((q) =>
        completeAnswer(
          q,
          candidate.proposals.find((a) => a.questionId === q.id),
          task.autoSubmitBestCandidate === true,
        ),
      );
    record.phase =
      mode === 'decode' ? 'decoded' : complete ? 'ready' : 'review';
    record.note =
      (mode === 'decode'
        ? '解密与文字复核完成；点击生成答案后才调用答题模型'
        : candidate.modelProblem) ??
      (complete
        ? '候选答案已生成；点击一键完成后填写并提交'
        : '存在需要人工检查的题目，尚未修改网页答案');
  } catch (error) {
    if (error instanceof PlatformAccessError) await holdPlatform(error.block);
    if (record) {
      record.phase = signal.aborted ? 'cancelled' : 'error';
      record.note = error instanceof Error ? error.message : '题目准备失败';
    }
    if (mode !== 'full') throw error;
  } finally {
    await persist();
  }
}
