import type {
  ConfirmedQuestionText,
  PageSnapshot,
  TaskAction,
  TaskPreparation,
  TaskRecord,
  TaskWorkflow,
  AnalysisIntent,
} from '../domain';
import { requiresTextRecognition } from '../image-content';
import { TEXT_PROCESSING_VERSION } from '../domain';
import { completeAnswer } from '../answers';
import { existingAnswersDigest } from '../preparation';
import { taskIdentifiers, matchesTaskFrameKey } from '../task-context';
import { state, persist } from './store';
import { prepareTask, prepareQuestion, cancelPreparation } from './preparer';
import { cancelScanAndWait, checkFrames } from './scan-control';
import { assertPlatformReady, holdPlatform } from './platform';
import { PlatformAccessError } from '../platform-access';
import {
  beginOperation,
  updateOperation,
  resumeOperation,
  finishOperation,
  operationEvent,
} from './operations';
import {
  assertCurrent,
  fillBound,
  saveBoundDraft,
  submitBound,
  guardTask,
  verifySavedDraft,
} from './task-writes';
import { verifyResult } from './executor';
import { cancelConnectionTests } from './connection-tests';
import { discoverFrames, frameCall } from './transport';
import {
  resolveTask,
  assertTaskCapability,
  recordVerifiedSubmission,
} from '../page-workspace';

let active:
  | {
      taskId: string;
      action: TaskAction;
      questionId?: string;
      runId: string;
      controller: AbortController;
      promise: Promise<void>;
    }
  | undefined;
function assertManualActionIdle(): void {
  if (active || state.queue.phase === 'running')
    throw new Error('请等待当前步骤结束后再确认文字');
}
export function manualRunning(): boolean {
  return Boolean(active);
}
export async function cancelWorkflowAndWait(): Promise<void> {
  cancelWorkflow();
  await active?.promise;
}
export function cancelWorkflow(taskId?: string): void {
  if (!taskId || active?.taskId === taskId) {
    active?.controller.abort();
    if (active && state.workflows[active.taskId])
      state.workflows[active.taskId]!.phase = 'cancelled';
    cancelPreparation();
  }
}
export function cancelInactiveWorkflow(tabId: number): void {
  if (
    active &&
    state.workflows[active.taskId]?.tabId !== undefined &&
    state.workflows[active.taskId]?.tabId !== tabId
  )
    cancelWorkflow();
}
export function cancelChangedWorkflow(
  ref: import('./transport').FrameRef,
): void {
  if (!active) return;
  const record = state.preparations[active.taskId];
  if (
    record &&
    ref.tabId === record.tabId &&
    ref.frameId === record.frameId &&
    (ref.taskKey !== record.taskKey || ref.url !== record.snapshot?.url)
  ) {
    // Fill/save/submit change DOM themselves; those phases check each subsequent write.
    if (
      active.action === 'decode' ||
      active.action === 'solve' ||
      active.action === 'decode-question' ||
      active.action === 'solve-question'
    )
      cancelWorkflow();
  }
}
export function startTaskAction(
  taskId: string,
  action: TaskAction,
  questionId?: string,
  expectedRevision?: number,
  intent: AnalysisIntent = 'execution',
): { operationId: string } {
  assertPlatformReady();
  cancelConnectionTests();
  if (
    ![
      'decode',
      'solve',
      'decode-question',
      'solve-question',
      'fill',
      'draft',
      'submit',
    ].includes(action)
  )
    throw new Error('任务步骤无效');
  const task = resolveTask(state, taskId);
  if (!task || task.accountId !== state.accountId || task.type === 'video')
    throw new Error('任务不属于当前账号');
  const writing = ['fill', 'draft', 'submit'].includes(action);
  if (!(action === 'submit' && state.workflows[taskId]?.submitAttempted))
    assertTaskCapability(
      task,
      writing
        ? action === 'draft'
          ? 'save'
          : (action as 'fill' | 'submit')
        : 'analyze',
    );
  const singleQuestion =
    action === 'decode-question' || action === 'solve-question';
  if (
    action !== 'decode' &&
    expectedRevision !== undefined &&
    (state.preparations[taskId]?.resultRevision ?? 0) !== expectedRevision
  )
    throw new Error('题目结果已更新，请重新打开详情');
  if (singleQuestion) {
    const record = state.preparations[taskId];
    if (
      !questionId ||
      !record?.snapshot?.questions.some(
        (question) => question.id === questionId,
      )
    )
      throw new Error('请先读取任务并选择有效题目');
    if ((record.resultRevision ?? 0) !== (expectedRevision ?? 0))
      throw new Error('题目结果已更新，请重新打开详情');
    if (
      action === 'solve-question' &&
      record.snapshot.questions.find((question) => question.id === questionId)
        ?.issues.length
    )
      throw new Error('本题文字仍需确认，请先重新解密或人工复核');
  }
  if (active) {
    if (
      active.taskId === taskId &&
      active.action === action &&
      active.questionId === (singleQuestion ? questionId : undefined)
    )
      return { operationId: active.runId };
    throw new Error('已有步骤正在执行，请先取消或等待完成');
  }
  if (
    state.queue.phase === 'running' ||
    Object.values(state.operations).some(
      (r) => r.kind === 'queue' && r.phase === 'running',
    )
  )
    throw new Error('请先暂停执行队列');
  if (
    intent !== 'reference' &&
    ['submitted', 'complete', 'expired'].includes(task.status)
  )
    throw new Error('任务已提交或已截止');
  if (intent !== 'reference' && task.pageMode === 'preview')
    throw new Error('当前是只读预览页，没有答题控件，请打开有效任务的答题页面');
  const initial = {
    decode: 'extracting',
    solve: 'solving',
    'decode-question': 'restoring',
    'solve-question': 'solving',
    fill: 'filling',
    draft: 'saving',
    submit: 'submitting',
  } as const;
  let workflow = state.workflows[taskId];
  if (action !== 'decode' && !workflow) throw new Error('请先开始解密');
  if (action !== 'submit' && workflow?.submitAttempted)
    throw new Error('上次提交结果待核验，请先核验，不能重新执行');
  if (action === 'decode' && workflow)
    void finishOperation(
      workflow.runId,
      'cancelled',
      '用户重新解密，原运行结束',
    );
  if (
    action === 'decode' ||
    singleQuestion ||
    !workflow ||
    !state.operations[workflow.runId] ||
    state.operations[workflow.runId]?.kind !== 'manual'
  ) {
    const runId = beginOperation('manual', task.title, taskId);
    workflow =
      action !== 'decode' && workflow
        ? { ...workflow, runId }
        : { taskId, runId, stage: 'extracting', phase: 'running', steps: {} };
    state.workflows[taskId] = workflow;
  } else resumeOperation(workflow.runId, initial[action]);
  workflow.action = action;
  workflow.questionId = singleQuestion ? questionId : undefined;
  workflow.resultRevision = singleQuestion ? expectedRevision : undefined;
  workflow.phase = 'running';
  state.currentTaskId = taskId;
  const runId = workflow.runId;
  updateOperation(
    runId,
    action === 'decode' || action === 'decode-question'
      ? '正在定位并读取题目'
      : '正在检查步骤前置条件',
    {
      stage: initial[action],
      waiting: 'page',
      ...(singleQuestion ? { questionId } : {}),
    },
  );
  const controller = new AbortController();
  // Register synchronously so rapid repeat clicks cannot create a second operation.
  const promise = Promise.resolve()
    .then(() => execute(task, action, workflow!, controller.signal, intent))
    .finally(() => {
      if (active?.controller === controller) active = undefined;
    });
  active = { taskId, action, questionId, runId, controller, promise };
  void persist();
  return { operationId: runId };
}
async function execute(
  task: TaskRecord,
  action: TaskAction,
  workflow: TaskWorkflow,
  signal: AbortSignal,
  intent: AnalysisIntent,
): Promise<void> {
  const runId = workflow.runId;
  try {
    await cancelScanAndWait();
    if (signal.aborted) throw new Error('操作已取消');
    if (
      action === 'decode' ||
      action === 'solve' ||
      action === 'decode-question' ||
      action === 'solve-question'
    ) {
      if (action === 'decode' || action === 'solve') {
        workflow.filled = workflow.readbackVerified = false;
        for (const stage of [
          'filling',
          'readback',
          'saving',
          'submitting',
          'verifying',
        ] as const)
          delete workflow.steps[stage];
        if (action === 'decode') {
          workflow.filled =
            workflow.readbackVerified =
            workflow.draftAttempted =
            workflow.draftVerified =
              false;
          workflow.steps = {};
        }
      }
      if (action === 'decode-question' || action === 'solve-question')
        await prepareQuestion(
          task.id,
          workflow.questionId!,
          action,
          runId,
          signal,
          workflow.resultRevision,
        );
      else await prepareTask(task.id, action, runId, signal, intent);
      const record = state.preparations[task.id];
      if (
        !record?.snapshot ||
        !record.decoded ||
        ['error', 'cancelled'].includes(record.phase)
      )
        throw new Error(record?.note ?? '无法取得当前任务题目');
      workflow.tabId = record.tabId;
      workflow.frameId = record.frameId;
      workflow.expectedDigest = record.existingDigest;
      workflow.resultRevision = record.resultRevision ?? 0;
      if (action === 'solve' && !record.proposals)
        throw new Error('候选答案尚未生成');
      await finishOperation(
        runId,
        'waiting-user',
        action === 'decode' || action === 'decode-question'
          ? '解密与文字复核完成；请查看结果并选择是否生成答案'
          : action === 'solve-question'
            ? '本题候选答案已更新；未填写网页答案'
            : '候选答案已生成；请查看结果并选择是否填写答案',
      );
      return;
    }
    // After an ambiguous submit, this action only verifies; never repeats the click.
    if (action === 'submit' && workflow.submitAttempted) {
      const tab =
        workflow.tabId !== undefined
          ? await chrome.tabs.get(workflow.tabId).catch(() => undefined)
          : undefined;
      const tabId =
        tab?.id ??
        (await chrome.tabs.create({ url: task.url, active: true })).id;
      if (tabId === undefined) throw new Error('无法打开核验页面');
      await guardTask({ tabId, frameId: workflow.frameId ?? 0 }, task, signal);
      updateOperation(runId, '核验上次提交结果，不重复提交', {
        stage: 'verifying',
      });
      const result = await verifyResult(tabId, task, signal, 12000, runId);
      await guardTask({ tabId, frameId: workflow.frameId ?? 0 }, task, signal);
      if (result.status === 'submitted' || result.status === 'complete') {
        recordVerifiedSubmission(state, task, result.grade);
        await finishOperation(runId, 'done', '已核验上次提交');
      } else if (await confirmUnsubmittedDraft(tabId, task, workflow, signal, runId)) {
        // Only this explicit verification action can retire an unsuccessful intent.
        // Require a new read/solve/fill cycle; never retry submission automatically.
        workflow.submitAttempted = false;
        workflow.filled = workflow.readbackVerified = false;
        delete state.preparations[task.id];
        task.status = 'pending';
        await finishOperation(runId, 'review', '服务器连续确认尚未提交；请重新识别并检查后再提交');
      } else
        await finishOperation(
          runId,
          'review',
          '上次提交结果仍待确认，请到平台核对',
        );
      return;
    }
    const record = state.preparations[task.id];
    if (action === 'draft' && workflow.draftAttempted && !record?.snapshot) {
      if (!workflow.filled || !workflow.readbackVerified || !workflow.expectedDigest || workflow.tabId === undefined)
        throw new Error('缺少原草稿核对依据，请在平台检查');
      const ids = taskIdentifiers(task.url);
      const course = state.courses.find(c => c.id === task.courseId && c.accountId === task.accountId);
      const key = `${course?.courseId ?? ids.course}:${course?.classId ?? ids.clazz}:work:${task.platformId}`;
      const refs = await discoverFrames(workflow.tabId, signal);
      checkFrames(refs, task.accountId);
      const ref = refs.find(f => f.frameId === workflow.frameId && matchesTaskFrameKey(f, key, state.preparations[task.id]?.snapshot?.taskKey) && f.taskKind === task.type);
      if (!ref) throw new Error('原草稿页面已变化，请在平台检查');
      const current = await frameCall<PageSnapshot | undefined>(ref, { op: 'extract' }, { signal });
      if (!current || current.accountId !== task.accountId || !matchesTaskFrameKey(current, key, state.preparations[task.id]?.snapshot?.taskKey) || current.status !== 'pending' || existingAnswersDigest(current) !== workflow.expectedDigest)
        throw new Error('原草稿的任务、账号或已有答案已变化，未重复保存');
      workflow.draftVerified = await verifySavedDraft(ref, task, current, signal, runId);
      await finishOperation(runId, workflow.draftVerified ? 'done' : 'review',
        workflow.draftVerified ? '已核验上次草稿保存，未重复保存' : '上次草稿保存仍待确认，请到平台检查');
      return;
    }
    if (!record?.snapshot || !record.proposals || !record.decoded)
      throw new Error('候选已失效，请重新解密并生成答案');
    if (
      record.policy !== state.draftPolicy ||
      record.providerRevision !== state.providerRevision
    )
      throw new Error('答题策略或配置已变化，请重新生成');
    const ref = { tabId: record.tabId, frameId: record.frameId };
    if (action === 'fill') {
      workflow.draftAttempted = workflow.draftVerified = false;
      const filled = await fillBound(
        ref,
        task,
        record.snapshot,
        record.proposals,
        record.existingDigest,
        record.providerRevision,
        signal,
        runId,
        task.autoSubmitBestCandidate === true,
      );
      workflow.filled = true;
      workflow.readbackVerified = filled.verified;
      workflow.expectedDigest = record.existingDigest = existingAnswersDigest(
        filled.readback,
      );
      // Keep restored text while adopting the actual post-write answer state.
      adoptAnswers(record, filled.readback);
      record.phase = 'filled';
      await finishOperation(
        runId,
        filled.verified ? 'waiting-user' : 'review',
        filled.verified
          ? '答案已填写，回读一致；请选择保存草稿或提交'
          : '回读不一致，禁止提交，请检查平台答案',
      );
      return;
    }
    if (!workflow.filled) throw new Error('请先填写答案');
    const expected = await assertCurrent(
      ref,
      task,
      record.snapshot,
      record.existingDigest,
      record.providerRevision,
      signal,
      runId,
    );
    if (action === 'draft') {
      if (workflow.draftAttempted) {
        workflow.draftVerified = await verifySavedDraft(
          ref,
          task,
          expected,
          signal,
          runId,
        );
        await finishOperation(
          runId,
          workflow.draftVerified ? 'done' : 'review',
          workflow.draftVerified
            ? '已核验上次草稿保存，未重复保存'
            : '上次草稿保存待确认，请到平台检查',
        );
        return;
      }
      workflow.draftAttempted = true;
      await persist(true);
      const saved = await saveBoundDraft(ref, task, expected, signal, runId);
      workflow.draftVerified = saved.verified;
      const needsReview = record.snapshot.questions.some(
        (q) =>
          !completeAnswer(
            q,
            record.proposals!.find((a) => a.questionId === q.id),
          ),
      );
      task.note = saved.verified
        ? '草稿已核验保存，尚未提交'
        : '草稿保存已触发，服务端保存待确认';
      if (needsReview) task.status = 'review';
      await finishOperation(
        runId,
        saved.verified && !needsReview ? 'done' : 'review',
        task.note + (needsReview ? '；存在待检查题目' : ''),
      );
      return;
    }
    if (
      !workflow.readbackVerified ||
      !record.snapshot.questions.every((q) =>
        completeAnswer(
          q,
          record.proposals!.find((a) => a.questionId === q.id),
          task.autoSubmitBestCandidate === true,
        ),
      )
    )
      throw new Error('仍有待检查、空答案或回读不一致；可以保存草稿，不能提交');
    await guardTask(ref, task, signal);
    workflow.submitAttempted = true;
    await persist(true);
    await submitBound(ref, task, expected, signal, runId);
    updateOperation(runId, '正在核验平台提交结果', { stage: 'verifying' });
    const result = await verifyResult(ref.tabId, task, signal, 25000, runId);
    await guardTask(ref, task, signal);
    if (result.status === 'submitted' || result.status === 'complete') {
      recordVerifiedSubmission(state, task, result.grade);
      await finishOperation(runId, 'done', '平台已确认提交');
    } else {
      task.status = 'unknown';
      task.note = '提交结果待确认，未重复提交';
      await finishOperation(runId, 'review', task.note);
    }
  } catch (error) {
    if (error instanceof PlatformAccessError) await holdPlatform(error.block);
    const note = error instanceof Error ? error.message : '操作失败';
    operationEvent(
      runId,
      '步骤未完成，未自动进入下一步',
      { code: 'step-stopped' },
      'warn',
    );
    await finishOperation(
      runId,
      signal.aborted || /已取消|已中断/.test(note)
        ? 'cancelled'
        : /心跳|账号|登录|鉴权|验证码|限流/.test(note)
          ? 'paused'
          : 'error',
      note,
    );
  }
}
/** Unlock only after a non-preview, nonempty, same-task draft is freshly verified. */
async function confirmUnsubmittedDraft(
  tabId: number,
  task: TaskRecord,
  workflow: TaskWorkflow,
  signal: AbortSignal,
  runId: string,
): Promise<boolean> {
  if (
    !workflow.filled ||
    !workflow.readbackVerified ||
    !workflow.expectedDigest
  )
    return false;
  const refs = await discoverFrames(tabId, signal);
  checkFrames(refs, task.accountId);
  const ids = taskIdentifiers(task.url);
  const course = state.courses.find(
    (c) => c.id === task.courseId && c.accountId === task.accountId,
  );
  const key = `${course?.courseId ?? ids.course}:${course?.classId ?? ids.clazz}:work:${task.platformId}`;
  const ref = refs.find(
    (f) =>
      f.frameId === workflow.frameId &&
      matchesTaskFrameKey(
        f,
        key,
        state.preparations[task.id]?.snapshot?.taskKey,
      ) &&
      f.taskKind === task.type,
  );
  if (!ref) return false;
  const matches = (page?: PageSnapshot) =>
    !!page &&
    page.pageMode !== 'preview' &&
    page.questions.length > 0 &&
    page.status === 'pending' &&
    page.accountId === task.accountId &&
    matchesTaskFrameKey(
      page,
      key,
      state.preparations[task.id]?.snapshot?.taskKey,
    ) &&
    existingAnswersDigest(page) === workflow.expectedDigest;
  const expected = await frameCall<PageSnapshot | undefined>(
    ref,
    { op: 'extract' },
    { signal },
  );
  if (!matches(expected)) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await guardTask(ref, task, signal);
    if (!(await verifySavedDraft(ref, task, expected!, signal, runId)))
      return false;
  }
  if (
    !matches(
      await frameCall<PageSnapshot | undefined>(
        ref,
        { op: 'extract' },
        { signal },
      ),
    )
  )
    return false;
  operationEvent(
    runId,
    '三次最新服务器读取确认同任务、同答案草稿且尚未提交；未重试提交',
    { code: 'submit-not-applied' },
  );
  return true;
}
let textConfirmation: Promise<void> | undefined;
export function confirmQuestionText(
  taskId: string,
  questionId: string,
  expectedRevision: number,
  text: ConfirmedQuestionText,
): Promise<void> {
  if (textConfirmation) return Promise.reject(new Error('正在确认另一题文字'));
  const pending = confirmQuestionTextImpl(
    taskId,
    questionId,
    expectedRevision,
    text,
  ).finally(() => {
    if (textConfirmation === pending) textConfirmation = undefined;
  });
  textConfirmation = pending;
  return pending;
}
async function confirmQuestionTextImpl(
  taskId: string,
  questionId: string,
  expectedRevision: number,
  text: ConfirmedQuestionText,
): Promise<void> {
  assertPlatformReady();
  assertManualActionIdle();
  const task = resolveTask(state, taskId);
  const record = state.preparations[taskId];
  if (!task || !record?.snapshot || !record.decoded)
    throw new Error('请先读取并解密任务');
  if (record.workflowVersion !== TEXT_PROCESSING_VERSION)
    throw new Error('文字处理版本已更新，请重新解密整份任务');
  if (
    record.accountId !== state.accountId ||
    record.taskId !== task.id ||
    record.courseId !== task.courseId ||
    (record.resultRevision ?? 0) !== expectedRevision
  )
    throw new Error('题目结果已更新，请重新打开详情');
  if (state.platformBlock) throw new Error('平台当前暂停，请先恢复连接');
  const workflow = state.workflows[taskId];
  if (workflow?.submitAttempted)
    throw new Error('提交结果仍待核验，不能修改题目');
  if (
    record.providerRevision !== state.providerRevision ||
    record.policy !== state.draftPolicy
  )
    throw new Error('模型设置或答题策略已变化，请重新识别本题');
  const frames = await discoverFrames(record.tabId);
  checkFrames(frames, state.accountId);
  const ref = frames.find(
    (frame) =>
      frame.frameId === record.frameId && frame.taskKey === record.taskKey,
  );
  if (
    !ref ||
    ref.taskKind !== task.type ||
    ref.loginRequired ||
    ref.accountId !== record.accountId
  )
    throw new Error('当前页面或登录账号已变化，不能确认旧题目文字');
  const current = await frameCall<PageSnapshot | undefined>(ref, {
    op: 'extract',
  });
  assertManualActionIdle();
  if (
    state.preparations[taskId] !== record ||
    state.accountId !== record.accountId ||
    state.providerRevision !== record.providerRevision ||
    state.draftPolicy !== record.policy ||
    (record.resultRevision ?? 0) !== expectedRevision ||
    active ||
    state.queue.phase === 'running' ||
    !current ||
    (record.intent !== 'reference' && current.status !== 'pending') ||
    current.accountId !== record.accountId ||
    current.taskKey !== record.taskKey ||
    current.fingerprint !== record.fingerprint ||
    existingAnswersDigest(current) !== record.existingDigest ||
    !current.questions.some((item) => item.id === questionId)
  )
    throw new Error('当前题目、答案或任务状态已变化，人工确认未应用');
  const question = record.snapshot.questions.find(
    (item) => item.id === questionId,
  );
  if (!question?.recognition) throw new Error('本题没有文字识别记录');
  const pendingStem = Boolean(
    requiresTextRecognition(question) && !question.recognition.stem.source,
  );
  const pendingOptions = question.options.filter(
    (option) =>
      requiresTextRecognition(question, option.id) &&
      !question.recognition!.options[option.id]?.source,
  );
  if (!pendingStem && !pendingOptions.length)
    throw new Error('本题文字已经确认');
  const stemValue = pendingStem ? text.stem?.trim() : undefined;
  if (pendingStem && (!stemValue || stemValue.length > 6000))
    throw new Error('请填写有效的题干文字');
  const optionValues = new Map<string, string>();
  for (const option of pendingOptions) {
    const value = text.options?.[option.id]?.trim();
    if (!value || value.length > 6000)
      throw new Error(`请填写有效的选项 ${option.label} 文字`);
    optionValues.set(option.id, value);
  }
  if (pendingStem) {
    question.stem = stemValue!;
    question.recognition.stem.source = 'manual';
    question.recognition.stem.attempts.push({
      engine: 'manual',
      success: true,
      text: stemValue!,
    });
  }
  for (const option of pendingOptions) {
    const value = optionValues.get(option.id)!;
    option.text = value;
    const trace = (question.recognition.options[option.id] ??= {
      attempts: [],
    });
    trace.source = 'manual';
    trace.attempts.push({ engine: 'manual', success: true, text: value });
  }
  for (const image of question.images ?? []) {
    if (
      (image.part === 'stem' && pendingStem) ||
      (image.optionId && optionValues.has(image.optionId))
    ) {
      const trace = ((question.recognition.images ??= {})[image.id] ??= {
        attempts: [],
      });
      trace.source = 'manual';
      trace.attempts.push({
        engine: 'manual',
        success: true,
        reason: '用户确认了所属题干或选项的完整转录',
      });
    }
  }
  question.textRevision = (question.textRevision ?? 0) + 1;
  question.issues = question.issues.filter(
    (issue) => !/文字识别需检查|混淆字体加载失败/.test(issue),
  );
  record.proposals = (record.proposals ?? []).filter(
    (proposal) => proposal.questionId !== questionId,
  );
  record.resultRevision = expectedRevision + 1;
  record.phase =
    record.snapshot.questions.some((item) => item.issues.length) ||
    (record.proposals ?? []).some((proposal) => proposal.needsReview)
      ? 'review'
      : 'decoded';
  record.note = `第 ${question.number} 题文字已人工确认；请检查后生成新候选`;
  record.at = Date.now();
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
  operationEvent(workflow?.runId, `用户人工确认第 ${question.number} 题文字`, {
    code: 'manual-text-confirmed',
    questionId,
    questionNumber: question.number,
  });
  await persist();
}

function adoptAnswers(record: TaskPreparation, raw: PageSnapshot): void {
  for (const q of record.snapshot!.questions) {
    const current = raw.questions.find((v) => v.id === q.id)!;
    q.existing = [...current.existing];
    q.blanks.forEach((b, i) => {
      b.value = current.blanks[i]!.value;
    });
  }
}
