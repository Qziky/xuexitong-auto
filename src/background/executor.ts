import type {
  AnswerProposal,
  PageSnapshot,
  QueueItem,
  TaskRecord,
  TaskStatus,
} from '../domain';
import { TEXT_PROCESSING_VERSION } from '../domain';
import { completeAnswer, readbackMatches } from '../answers';
import { accountGuard, canSubmit, createQueue, TERMINAL } from '../queue';
import { retainLearningForeground } from './learning-foreground';
import { state, provider, persist, log } from './store';
import {
  discoverFrames,
  frameCall,
  delay,
  offscreen,
  taskFrame,
  type FrameRef,
} from './transport';
import type { Binding } from '../messages';
import {
  assertPlatformReady,
  holdPlatform,
  accessPlatform,
  rethrowPlatformBlock,
} from './platform';
import { PlatformAccessError, platformBlockFor } from '../platform-access';
import { cancelScanAndWait } from './scan-control';
import {
  yieldPreparation,
  releasePreparationPriority,
  reusablePreparation,
  generateCandidateAnswers,
} from './preparer';
import { existingAnswersDigest } from '../preparation';
import { ownedTabs } from './owned-tabs';
import {
  taskIdentifiers,
  classifyTaskPage,
  matchesTaskFrameKey,
} from '../task-context';
import { recordVerifiedSubmission } from '../page-workspace';
import {
  beginOperation,
  updateOperation,
  operationEvent,
  finishOperation,
  resumeOperation,
} from './operations';
import {
  fillBound,
  saveBoundDraft,
  submitBound,
  verifySavedDraft,
} from './task-writes';
import { STAGE_LABEL, type ProgressDetail } from '../progress';

export function acceptQueue(
  ids: string[],
  policy: 'preserve' | 'overwrite',
  goal: 'submit' | 'draft',
  beforeStart?: () => Promise<void>,
): { operationId: string } {
  assertPlatformReady();
  if (
    executing ||
    starting ||
    state.queue.phase === 'running' ||
    Object.values(state.operations ?? {}).some(
      (r) => r.kind === 'queue' && r.phase === 'running',
    )
  )
    throw new Error('已有任务正在执行');
  if (!['submit', 'draft'].includes(goal)) throw new Error('执行目标无效');
  createQueue(
    state.tasks.filter((t) => ids.includes(t.id)),
    state.accountId ?? '',
    policy,
    goal,
  );
  const id = beginOperation(
    'queue',
    `${ids.length} 个任务：${goal === 'draft' ? '完成并保存草稿' : '完成并提交'}`,
    ids[0],
    goal,
  );
  void Promise.resolve()
    .then(async () => {
      await beforeStart?.();
      if (state.operations[id]?.phase !== 'running') return;
      await startQueue(ids, policy, goal, id);
    })
    .catch(async (error) => {
      await finishOperation(
        id,
        'error',
        error instanceof Error ? error.message : '启动失败',
      );
    });
  void persist();
  return { operationId: id };
}

let executing: Promise<void> | undefined;
let starting = false;
let startupCancelled = false;
let executionAbort: AbortController | undefined;
let recognizingFrame: FrameRef | undefined;
export async function awaitQueueIdle(): Promise<void> {
  await executing;
}
export function acceptResume(beforeStart?: () => Promise<void>): {
  operationId: string;
} {
  assertPlatformReady();
  if (
    executing ||
    starting ||
    Object.values(state.operations).some(
      (r) => r.kind === 'queue' && r.phase === 'running',
    )
  )
    throw new Error('正在结束当前操作，请稍后继续');
  if (
    !['paused', 'stopped'].includes(state.queue.phase) ||
    !state.queue.items.length
  )
    throw new Error('没有可恢复的执行队列');
  const id =
    state.queue.runId && state.operations[state.queue.runId]
      ? state.queue.runId
      : beginOperation(
          'queue',
          '恢复执行队列',
          state.queue.items[state.queue.index]?.taskId,
          state.queue.goal ?? 'submit',
        );
  resumeOperation(id, 'checking');
  updateOperation(id, '正在恢复执行前检查', { stage: 'checking' });
  void Promise.resolve()
    .then(async () => {
      await beforeStart?.();
      if (state.operations[id]?.phase !== 'running') return;
      await resumeQueue(id);
    })
    .catch(async (e) => {
      await finishOperation(
        id,
        'error',
        e instanceof Error ? e.message : '恢复失败',
      );
    });
  return { operationId: id };
}
export async function cancelChangedExecution(ref: FrameRef): Promise<void> {
  const previous = recognizingFrame;
  if (
    previous &&
    state.queue.phase === 'running' &&
    ref.tabId === previous.tabId &&
    ref.frameId === previous.frameId &&
    (ref.taskKey !== previous.taskKey ||
      ref.revision !== previous.revision ||
      ref.url !== previous.url)
  )
    await pauseQueue(false, '页面或已有答案已变化；已停止识别，继续时重新读取');
}
export async function startQueue(
  ids: string[],
  policy: 'preserve' | 'overwrite',
  goal: 'submit' | 'draft' = 'submit',
  runId?: string,
  pinnedTab?: { tabId: number },
  learningId?: string,
): Promise<void> {
  assertPlatformReady();
  if (state.queue.phase === 'running' || executing || starting)
    throw new Error('已有任务正在执行');
  if (!state.accountId) throw new Error('请先登录并扫描课程');
  if (!Array.isArray(ids) || !['preserve', 'overwrite'].includes(policy))
    throw new Error('任务选择无效');
  const queue = createQueue(
    state.tasks.filter((t) => ids.includes(t.id)),
    state.accountId,
    policy,
    goal,
  );
  if (pinnedTab) for (const item of queue.items) item.tabId = pinnedTab.tabId;
  queue.learningId = learningId;
  starting = true;
  startupCancelled = false;
  try {
    await yieldPreparation();
    await cancelScanAndWait();
    assertPlatformReady();
    if (startupCancelled) throw new Error('任务启动已取消');
    if (queue.accountId !== state.accountId)
      throw new Error('登录账号已变化，请重新选择任务');
    state.queue = queue;
    state.queue.runId =
      runId ??
      beginOperation(
        'queue',
        `执行 ${queue.items.length} 个任务`,
        queue.items[0]?.taskId,
        goal,
      );
    state.queue.items.forEach((item) => {
      item.runId = state.queue.runId;
    });
    log(
      `开始执行 ${state.queue.items.length} 个任务（${policy === 'preserve' ? '保留已有答案' : '覆盖重新作答'}）`,
    );
    await persist();
    launch();
  } catch (error) {
    releasePreparationPriority();
    throw error;
  } finally {
    starting = false;
  }
}
export async function pauseQueue(stop = false, reason?: string): Promise<void> {
  if (starting) startupCancelled = true;
  state.queue.phase = stop ? 'stopped' : 'paused';
  state.queue.note =
    reason ?? (stop ? '已停止；已提交的任务不会撤回' : '已暂停，可继续执行');
  executionAbort?.abort();
  for (const run of Object.values(state.operations ?? {}).filter(
    (r) =>
      r.kind === 'queue' && r.phase === 'running' && r.id !== state.queue.runId,
  ))
    await finishOperation(
      run.id,
      stop ? 'cancelled' : 'paused',
      state.queue.note!,
    );
  if (state.queue.runId)
    await finishOperation(
      state.queue.runId,
      stop ? 'cancelled' : 'paused',
      state.queue.note!,
    );
  await persist();
}
export async function resumeQueue(runId?: string): Promise<void> {
  assertPlatformReady();
  if (executing || starting) throw new Error('正在结束当前操作，请稍后继续');
  if (
    !['paused', 'stopped'].includes(state.queue.phase) ||
    !state.queue.items.length
  )
    throw new Error('没有可恢复的执行队列');
  if (state.queue.accountId !== state.accountId)
    throw new Error('账号已变化，请重新选择任务');
  const queue = state.queue;
  starting = true;
  startupCancelled = false;
  try {
    await yieldPreparation();
    await cancelScanAndWait();
    assertPlatformReady();
    if (startupCancelled) throw new Error('任务启动已取消');
    if (queue.accountId !== state.accountId)
      throw new Error('账号已变化，请重新选择任务');
    const item = queue.items[queue.index];
    if (item && !TERMINAL.has(item.stage)) {
      item.stage = item.submitAttempted ? 'verifying' : 'waiting';
      item.note = undefined;
    }
    queue.phase = 'running';
    if (runId) queue.runId = runId;
    if (queue.runId && state.operations?.[queue.runId]) {
      state.operations[queue.runId]!.phase = 'running';
      state.operations[queue.runId]!.lastHeartbeatAt = Date.now();
    } else
      queue.runId = beginOperation(
        'queue',
        '恢复执行队列',
        queue.items[queue.index]?.taskId,
        queue.goal ?? 'submit',
      );
    queue.items.forEach((item) => {
      item.runId = queue.runId;
    });
    queue.note = undefined;
    await persist();
    launch();
  } catch (error) {
    releasePreparationPriority();
    throw error;
  } finally {
    starting = false;
  }
}
function launch(): void {
  executionAbort = new AbortController();
  executing = runQueue(executionAbort.signal).finally(() => {
    executing = undefined;
    executionAbort = undefined;
    releasePreparationPriority();
    if (state.learning.phase === 'running') {
      if (
        state.queue.learningId === state.learning.id &&
        state.learning.tabId !== undefined
      )
        void retainLearningForeground(
          state.learning.id,
          state.learning.tabId,
        ).catch(() => {});
      void import('./learning').then((m) => m.continueLearning());
    }
  });
}
async function stage(
  item: QueueItem,
  next: QueueItem['stage'],
  note?: string,
  detail: ProgressDetail = {},
): Promise<void> {
  item.stage = next;
  item.note = note;
  const boundWorkflow = state.workflows?.[item.taskId];
  if (boundWorkflow) {
    boundWorkflow.tabId = item.tabId;
    boundWorkflow.submitAttempted = item.submitAttempted;
    boundWorkflow.draftAttempted = item.draftAttempted;
    boundWorkflow.draftVerified = item.draftVerified;
  }
  if (next in STAGE_LABEL)
    updateOperation(
      item.runId,
      note ?? STAGE_LABEL[next as keyof typeof STAGE_LABEL],
      { ...detail, stage: next as keyof typeof STAGE_LABEL },
      item.taskId,
    );
  else {
    operationEvent(
      item.runId,
      note ?? next,
      { code: `task-${next}` },
      ['review', 'failed'].includes(next) ? 'warn' : 'info',
    );
    const workflow = state.workflows?.[item.taskId];
    if (workflow) {
      workflow.phase = ['submitted', 'draft-saved', 'skipped'].includes(next)
        ? 'done'
        : 'review';
      workflow.note = note;
      workflow.steps[workflow.stage] = {
        ...workflow.steps[workflow.stage],
        status: workflow.phase === 'done' ? 'done' : 'review',
        finishedAt: Date.now(),
        note,
      };
    }
  }
  await persist();
}
async function guard(tabId: number): Promise<void> {
  assertPlatformReady();
  const all = await discoverFrames(tabId);
  const verifying = all.find((f) => f.verificationRequired);
  if (verifying)
    throw new PlatformAccessError({
      ...platformBlockFor(verifying.url),
      tabId,
    });
  if (all.some((f) => f.loginRequired))
    throw new Error('登录已失效，请重新登录');
  const ids = [...new Set(all.map((f) => f.accountId).filter(Boolean))];
  if (ids.length > 1) throw new Error('无法确认登录账号一致');
  accountGuard(state, ids[0]);
}
function updateTask(
  task: TaskRecord,
  status: TaskStatus,
  grade?: string,
  note?: string,
): void {
  if (status === 'submitted' || status === 'complete') {
    recordVerifiedSubmission(state, task, grade);
    return;
  }
  task.status = status;
  if (grade !== undefined) task.grade = grade;
  task.note = note;
}
async function openTask(
  task: TaskRecord,
  item: QueueItem,
  signal: AbortSignal,
): Promise<number> {
  const learningId = state.queue.learningId;
  const foreground = async (tabId: number) => {
    if (learningId) await retainLearningForeground(learningId, tabId);
  };
  const expected = expectedTaskKey(task);
  const knownTaskKey =
    item.snapshot?.taskKey ?? state.preparations[task.id]?.snapshot?.taskKey;
  if (item.tabId !== undefined) {
    const existing = await chrome.tabs.get(item.tabId).catch(() => undefined);
    if (existing?.url) {
      const matching = (await discoverFrames(item.tabId, signal)).some(
        (f) =>
          matchesTaskFrameKey(f, expected, knownTaskKey) &&
          f.taskKind === task.type,
      );
      if (matching || item.submitAttempted) {
        await foreground(item.tabId);
        return item.tabId;
      }
      await accessPlatform(
        () =>
          chrome.tabs.update(item.tabId!, {
            url: task.url,
            active: Boolean(learningId),
          }),
        {
          signal,
          runId: item.runId,
          accountId: task.accountId,
        },
      );
      await foreground(item.tabId);
      return item.tabId;
    }
  }
  const [active] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (active?.id !== undefined && !ownedTabs.has(active.id)) {
    const candidates = await discoverFrames(active.id, signal);
    const ref = candidates.find(
      (f) =>
        matchesTaskFrameKey(f, expected, knownTaskKey) &&
        f.taskKind === task.type,
    );
    if (ref) {
      item.tabId = active.id;
      await persist();
      await foreground(active.id);
      return active.id;
    }
  }
  const tab = await accessPlatform(
    () => chrome.tabs.create({ url: task.url, active: Boolean(learningId) }),
    {
      signal,
      runId: item.runId,
      accountId: task.accountId,
    },
  );
  if (tab.id === undefined) throw new Error('无法打开任务标签页');
  item.tabId = tab.id;
  item.ownedTab = true;
  ownedTabs.add(tab.id);
  await persist();
  await foreground(tab.id);
  return tab.id;
}
function expectedTaskKey(task: TaskRecord): string {
  const course = state.courses.find((c) => c.id === task.courseId);
  const ids = taskIdentifiers(task.url);
  return `${course?.courseId ?? ids.course}:${course?.classId ?? ids.clazz}:work:${task.platformId}`;
}
async function runQueue(signal: AbortSignal): Promise<void> {
  try {
    while (
      state.queue.index < state.queue.items.length &&
      state.queue.phase === 'running'
    ) {
      const item = state.queue.items[state.queue.index]!;
      if (TERMINAL.has(item.stage)) {
        state.queue.index++;
        continue;
      }
      const task = state.tasks.find((t) => t.id === item.taskId);
      if (!task) {
        await stage(item, 'failed', '任务已不在当前课程清单');
        state.queue.index++;
        continue;
      }
      try {
        await runTask(task, item, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : '任务执行失败';
        if (error instanceof PlatformAccessError) {
          await holdPlatform(error.block);
          state.queue.note = error.block.message;
        }
        if (signal.aborted || state.queue.phase !== 'running') {
          item.stage = item.submitAttempted ? 'verifying' : 'waiting';
          item.note = item.submitAttempted
            ? '继续时先核验提交结果'
            : '继续时重新读取草稿';
          break;
        }
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'foreground-unavailable'
        ) {
          state.queue.phase = 'paused';
          state.queue.note = message;
          item.stage = item.submitAttempted ? 'verifying' : 'waiting';
          item.note = message;
          log(message, 'warn');
          break;
        }
        if (/账号|登录|鉴权|API Key|无法确认当前账号|心跳/.test(message)) {
          state.queue.phase = 'paused';
          state.queue.note = message;
          item.stage = item.submitAttempted ? 'verifying' : 'waiting';
          item.note = message;
          log(message, 'warn');
          break;
        }
        await stage(
          item,
          item.submitAttempted ? 'review' : 'failed',
          item.submitAttempted ? '提交结果待确认，未重复提交' : message,
        );
        if (item.submitAttempted)
          updateTask(
            task,
            'unknown',
            undefined,
            '提交结果待确认，请到平台检查',
          );
        log(`${task.title}：${item.note}`, 'warn');
      }
      item.finishedAt = Date.now();
      state.queue.index++;
      await persist();
    }
    if (
      state.queue.phase === 'running' &&
      state.queue.index >= state.queue.items.length
    ) {
      state.queue.phase = 'done';
      state.queue.note = '执行结束，请检查需人工处理的任务';
      log('批量任务执行结束');
      await finishOperation(
        state.queue.runId,
        state.queue.items.some((i) => ['review', 'failed'].includes(i.stage))
          ? 'review'
          : 'done',
        `执行结束：${state.queue.items.filter((i) => i.stage === 'submitted').length} 已提交，${state.queue.items.filter((i) => i.stage === 'draft-saved').length} 草稿已核验，${state.queue.items.filter((i) => ['review', 'failed'].includes(i.stage)).length} 待检查`,
      );
      if (state.preferences.notifications)
        void chrome.notifications.create(`queue:${state.queue.id}`, {
          type: 'basic',
          iconUrl: 'icon/128.png',
          title: '课程任务执行结束',
          message: `${state.queue.items.filter((i) => i.stage === 'submitted').length} 个任务已提交，${state.queue.items.filter((i) => i.stage === 'draft-saved').length} 份草稿已核验，${state.queue.items.filter((i) => ['review', 'failed'].includes(i.stage)).length} 个任务需要检查。`,
        });
    }
  } finally {
    if (
      state.queue.phase === 'paused' &&
      state.operations?.[state.queue.runId ?? '']?.phase === 'running'
    )
      await finishOperation(
        state.queue.runId,
        'paused',
        state.queue.note ?? '执行已暂停',
      );
    await persist();
  }
}
async function runTask(
  task: TaskRecord,
  item: QueueItem,
  signal: AbortSignal,
): Promise<void> {
  item.startedAt ??= Date.now();
  state.workflows ??= {};
  // A new queue must also honor a previous ambiguous submission marker.
  item.submitAttempted ||= state.workflows[task.id]?.submitAttempted;
  state.workflows[task.id] = {
    taskId: task.id,
    runId: item.runId!,
    stage: 'checking',
    phase: 'running',
    steps: {},
  };
  await stage(item, item.submitAttempted ? 'verifying' : 'checking');
  const tabId = await openTask(task, item, signal);
  if (item.submitAttempted) {
    const result = await verifyResult(tabId, task, signal, 12000);
    if (result.status === 'submitted' || result.status === 'complete') {
      updateTask(task, 'submitted', result.grade);
      item.grade = result.grade;
      await stage(item, 'submitted', '已核验上次提交');
    } else {
      updateTask(
        task,
        'unknown',
        undefined,
        '上次提交结果未确认，请到平台检查',
      );
      await stage(item, 'review', '未重复提交，等待人工核验');
    }
    return;
  }
  if (['submitted', 'complete', 'expired'].includes(task.status)) {
    await stage(
      item,
      'skipped',
      task.status === 'expired' ? '任务已截止' : '任务已经提交',
    );
    return;
  }
  let { ref, page } = await taskFrame(
    tabId,
    task.platformId,
    signal,
    expectedTaskKey(task),
    item.snapshot?.taskKey ?? state.preparations[task.id]?.snapshot?.taskKey,
  );
  state.workflows[task.id]!.tabId = ref.tabId;
  state.workflows[task.id]!.frameId = ref.frameId;
  await guard(tabId);
  if (
    ref.taskKind === 'exam' ||
    classifyTaskPage(page.url, '', page.title) === 'exam'
  )
    throw new Error('考试页面不在自动完成范围内');
  if (page.pageMode === 'preview') {
    task.pageMode = 'preview';
    task.note = '当前是只读预览页，没有答题控件；请打开有效任务的答题页面';
    await stage(item, 'review', task.note);
    return;
  }
  if (
    !matchesTaskFrameKey(
      page,
      expectedTaskKey(task),
      item.snapshot?.taskKey ?? state.preparations[task.id]?.snapshot?.taskKey,
    ) ||
    page.accountId !== task.accountId
  )
    throw new Error('页面账号、课程或任务不一致');
  if (page.status === 'submitted' || page.status === 'complete') {
    updateTask(task, 'submitted', page.grade);
    item.grade = page.grade;
    await stage(item, 'skipped', '平台显示任务已提交');
    return;
  }
  if (page.status !== 'pending') {
    await stage(item, 'review', '平台完成状态无法确认，请检查后重新扫描');
    return;
  }
  if (!page.taskKey || !page.questions.length)
    throw new Error('题目数据不完整');
  if (item.draftAttempted && item.draftSnapshot) {
    const verified = await verifySavedDraft(
      ref,
      task,
      item.draftSnapshot,
      signal,
      item.runId,
    );
    item.draftVerified = verified;
    await stage(
      item,
      verified ? 'draft-saved' : 'review',
      verified
        ? '已核验上次草稿保存，未重复保存'
        : '上次草稿保存待确认，未重复执行',
    );
    return;
  }
  await stage(item, 'extracting');
  const binding: Binding = {
    taskKey: page.taskKey,
    fingerprint: page.fingerprint,
  };
  const raw = page;
  const providerRevision = state.providerRevision;
  const cached = reusablePreparation(raw, task, state.queue.policy);
  if (cached)
    operationEvent(item.runId, '复用已生成并核对的候选答案', {
      code: 'candidate-cache',
    });
  recognizingFrame = ref;
  let candidate: import('./preparer').CandidateAnswers;
  try {
    candidate = cached
      ? {
          page: cached.snapshot!,
          proposals: cached.proposals!,
          modelProblem: undefined,
        }
      : await generateCandidateAnswers(
          raw,
          state.queue.policy,
          signal,
          (note, detail) =>
            stage(item, detail?.stage ?? 'solving', note, detail),
          item.runId,
        );
  } finally {
    recognizingFrame = undefined;
  }
  page = candidate.page;
  item.snapshot = page;
  const { proposals, modelProblem } = candidate;
  item.proposals = proposals;
  await stage(item, 'filling');
  const filled = await fillBound(
    ref,
    task,
    page,
    proposals,
    existingAnswersDigest(raw),
    providerRevision,
    signal,
    item.runId,
    task.autoSubmitBestCandidate === true && state.queue.goal === 'submit',
  );
  state.workflows[task.id]!.filled = true;
  state.workflows[task.id]!.readbackVerified = filled.verified;
  if (filled.verified) {
    const snapshot = structuredClone(page);
    for (const q of snapshot.questions) {
      const current = filled.readback.questions.find((v) => v.id === q.id)!;
      q.existing = [...current.existing];
      q.blanks.forEach((b, i) => {
        b.value = current.blanks[i]!.value;
      });
    }
    state.preparations[task.id] = {
      taskId: task.id,
      accountId: task.accountId,
      courseId: task.courseId,
      tabId: ref.tabId,
      frameId: ref.frameId,
      taskKey: page.taskKey,
      fingerprint: page.fingerprint,
      existingDigest: existingAnswersDigest(filled.readback),
      providerRevision,
      policy: state.queue.policy,
      phase: 'filled',
      workflowVersion: TEXT_PROCESSING_VERSION,
      decoded: true,
      at: Date.now(),
      snapshot,
      proposals,
      note: '综合执行已填写并回读，后续操作仍需检查当前页面绑定',
    };
    state.workflows[task.id]!.frameId = ref.frameId;
  }
  item.draftSnapshot = filled.readback;
  await stage(
    item,
    'readback',
    filled.verified ? '填写回读一致' : '填写回读不一致',
  );
  const complete = !modelProblem && filled.complete;
  if (!complete || state.queue.goal === 'draft') {
    item.draftAttempted = true;
    await stage(item, 'saving');
    let triggered = false;
    let verified = false;
    try {
      const saved = await saveBoundDraft(
        ref,
        task,
        filled.readback,
        signal,
        item.runId,
      );
      triggered = saved.triggered;
      verified = saved.verified;
    } catch (error) {
      rethrowPlatformBlock(error);
      if (signal.aborted) throw error;
    }
    item.draftVerified = verified;
    const reason = complete
      ? ''
      : modelProblem ||
        (!filled.verified
          ? '填写回读不一致'
          : page.questions.some((q) => q.issues.length)
            ? '题目识别存在待检查项'
            : '模型表示不确定或仍有空答案');
    updateTask(
      task,
      complete ? 'pending' : 'review',
      undefined,
      `${reason ? reason + '；' : ''}${verified ? '草稿已核验保存，尚未提交' : triggered ? '已触发平台草稿保存，服务端保存待确认' : '未确认草稿保存，请在打开的页面检查'}`,
    );
    await stage(
      item,
      complete && verified ? 'draft-saved' : 'review',
      task.note,
    );
    log(`${task.title}：${task.note}`, verified && complete ? 'info' : 'warn');
    return;
  }
  if (!canSubmit(item)) throw new Error('提交阶段不正确');
  await guard(tabId);
  if (signal.aborted) throw new Error('操作已取消');
  item.submitAttempted = true;
  await persist(true);
  await stage(item, 'submitting');
  await submitBound(ref, task, filled.readback, signal, item.runId);
  await stage(item, 'verifying');
  const result = await verifyResult(tabId, task, signal, 25000, item.runId);
  if (result.status === 'submitted' || result.status === 'complete') {
    updateTask(task, 'submitted', result.grade);
    item.grade = result.grade;
    await stage(item, 'submitted', '平台已确认提交');
    log(`${task.title}：已提交${result.grade ? `，成绩 ${result.grade}` : ''}`);
  } else {
    updateTask(task, 'unknown', undefined, '提交结果未确认，未重复提交');
    await stage(item, 'review', '请打开平台核对提交状态');
    log(`${task.title}：提交结果待确认`, 'warn');
  }
}
async function readResults(
  tabId: number,
  task: TaskRecord,
): Promise<{ status: TaskStatus; grade?: string }> {
  assertPlatformReady();
  const refs = await discoverFrames(tabId);
  if (refs.some((f) => f.loginRequired))
    throw new Error('登录已失效，请重新登录');
  const accounts = [...new Set(refs.map((f) => f.accountId).filter(Boolean))];
  if (
    state.accountId !== task.accountId ||
    accounts.some((id) => id !== task.accountId)
  )
    throw new Error('核验期间登录账号已变化');
  const verifying = refs.find((f) => f.verificationRequired);
  if (verifying)
    throw new PlatformAccessError({
      ...platformBlockFor(verifying.url),
      tabId,
    });
  const knownTaskKey =
    state.queue.items.find(
      (item) => item.taskId === task.id && item.tabId === tabId,
    )?.snapshot?.taskKey ?? state.preparations[task.id]?.snapshot?.taskKey;
  const candidates = refs.filter((f) =>
    matchesTaskFrameKey(f, expectedTaskKey(task), knownTaskKey),
  );
  for (const ref of candidates) {
    try {
      const result = await frameCall<{
        status: TaskStatus;
        grade?: string;
        taskKey: string;
      }>(ref, { op: 'result' });
      if (
        result.taskKey === ref.taskKey &&
        ['submitted', 'complete'].includes(result.status)
      )
        return result;
    } catch (error) {
      rethrowPlatformBlock(error);
      /* Navigation is in progress. */
    }
  }
  return { status: 'unknown' };
}
export async function verifyResult(
  tabId: number,
  task: TaskRecord,
  signal: AbortSignal,
  timeout: number,
  runId?: string,
): Promise<{ status: TaskStatus; grade?: string }> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await readResults(tabId, task);
    if (result.status === 'submitted' || result.status === 'complete')
      return result;
    await delay(850, signal);
  }
  // Check a fresh server-rendered task page before exposing an ambiguous result; no submission endpoints are called here.
  try {
    const read = await offscreen<{ html: string; url: string }>(
      { op: 'fetch', url: task.url, fresh: true, purpose: 'result' },
      signal,
      runId,
    );
    const result = await offscreen<{ status: TaskStatus; grade?: string }>(
      { op: 'status', ...read },
      signal,
      runId,
    );
    if (['submitted', 'complete'].includes(result.status)) return result;
  } catch (error) {
    rethrowPlatformBlock(error);
    /* Ambiguous stays ambiguous. */
  }
  return { status: 'unknown' };
}
