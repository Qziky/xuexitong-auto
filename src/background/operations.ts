import type {
  LogEvent,
  OperationPhase,
  OperationProgress,
  WorkflowStage,
} from '../domain';
import type { ProgressDetail } from '../progress';
import { STAGE_LABEL } from '../progress';
import {
  appendEvent,
  putRun,
  safeLogText,
  pruneJournal,
  flushJournal,
} from './journal';
import { state, persist } from './store';

export function notifyProgress(run: OperationProgress): void {
  void persist(run.phase !== 'running');
}
export function beginOperation(
  kind: OperationProgress['kind'],
  title: string,
  taskId?: string,
  goal?: 'submit' | 'draft',
): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  state.operations ??= {};
  state.workflows ??= {};
  state.operations[id] = {
    id,
    kind,
    title: safeLogText(title),
    taskId,
    accountId: state.accountId,
    goal,
    phase: 'running',
    stage: 'checking',
    startedAt: now,
    stageStartedAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    lastProgressAt: now,
    note: '正在检查任务',
    seq: 0,
  };
  const old = Object.values(state.operations)
    .filter((r) => !['running', 'waiting-user'].includes(r.phase))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(100);
  for (const r of old) delete state.operations[r.id];
  void putRun(state.operations[id]!);
  operationEvent(id, '运行开始', { code: 'run-start' });
  notifyProgress(state.operations[id]!);
  return id;
}
export function operationEvent(
  id: string | undefined,
  message: string,
  detail: ProgressDetail = {},
  level: LogEvent['level'] = 'info',
): void {
  const run = id ? state.operations?.[id] : undefined;
  if (!run) return;
  run.seq++;
  const event: LogEvent = {
    id: `${run.id}:${String(run.seq).padStart(9, '0')}`,
    runId: run.id,
    at: Date.now(),
    seq: run.seq,
    taskId: run.taskId,
    stage: detail.stage ?? run.stage,
    level,
    message: safeLogText(message),
    code: detail.code ?? 'progress',
    questionNumber: detail.questionNumber,
    questionId: detail.questionId,
    part: detail.part,
    engine: detail.engine,
    confidence: detail.confidence,
    attempt: detail.attempt,
    durationMs: detail.durationMs,
    done: detail.done,
    total: detail.total,
    readSource: detail.readSource,
  };
  void appendEvent(event);
}
export function updateOperation(
  id: string | undefined,
  note: string,
  detail: ProgressDetail = {},
  taskId?: string,
): void {
  const run = id ? state.operations?.[id] : undefined;
  if (!run || run.phase !== 'running') return;
  const now = Date.now();
  if (
    (detail.stage && detail.stage !== run.stage) ||
    (taskId && taskId !== run.taskId)
  ) {
    operationEvent(id, `${STAGE_LABEL[run.stage]}结束`, {
      code: 'stage-end',
      durationMs: now - run.stageStartedAt,
    });
    const workflow = run.taskId ? state.workflows?.[run.taskId] : undefined;
    if (workflow && workflow.runId === id) {
      workflow.steps[run.stage] = {
        ...workflow.steps[run.stage],
        status: 'done',
        finishedAt: now,
        note: run.note,
      };
    }
    if (taskId) run.taskId = taskId;
    run.stage = detail.stage ?? run.stage;
    run.stageStartedAt = now;
    run.done =
      run.total =
      run.success =
      run.review =
      run.queued =
      run.active =
      run.globalActive =
      run.globalQueued =
      run.globalLimit =
      run.questionNumber =
        undefined;
    run.part = run.engine = run.waiting = undefined;
    run.questionId = undefined;
    run.requestStartedAt = run.timeoutSec = run.attempt = undefined;
    run.platformWaitUntil = undefined;
    run.readSource = undefined;
    operationEvent(id, `${STAGE_LABEL[run.stage]}开始`, {
      code: 'stage-start',
    });
  }
  const keys = [
    'questionNumber',
    'questionId',
    'part',
    'engine',
    'done',
    'total',
    'success',
    'review',
    'queued',
    'active',
    'globalActive',
    'globalQueued',
    'globalLimit',
    'requestStartedAt',
    'timeoutSec',
    'attempt',
    'waiting',
    'platformWaitUntil',
    'readSource',
    'platformRequests',
  ] as const;
  for (const key of keys) if (key in detail) (run as any)[key] = detail[key];
  run.note = safeLogText(note);
  run.updatedAt = run.lastProgressAt = now;
  const workflow = run.taskId ? state.workflows?.[run.taskId] : undefined;
  if (workflow && workflow.runId === id) {
    workflow.stage = run.stage;
    workflow.phase = 'running';
    workflow.note = run.note;
    workflow.steps[run.stage] = {
      ...workflow.steps[run.stage],
      status: 'running',
      startedAt: run.stageStartedAt,
      note: run.note,
    };
  }
  operationEvent(id, note, detail);
  void putRun(run);
  notifyProgress(run);
}
export function heartbeatOperation(id: string | undefined): void {
  const run = id ? state.operations?.[id] : undefined;
  if (!run || run.phase !== 'running') return;
  run.lastHeartbeatAt = Date.now();
  if (
    run.kind === 'queue' &&
    state.learning.phase === 'running' &&
    state.learning.runId
  )
    if (state.operations[state.learning.runId])
      state.operations[state.learning.runId]!.lastHeartbeatAt = Date.now();
  notifyProgress(run);
}
export async function finishOperation(
  id: string | undefined,
  phase: OperationPhase,
  note: string,
): Promise<void> {
  const run = id ? state.operations?.[id] : undefined;
  if (!run) return;
  if (run.phase === 'running')
    operationEvent(id, `${STAGE_LABEL[run.stage]}结束`, {
      code: 'stage-end',
      durationMs: Date.now() - run.stageStartedAt,
    });
  run.phase = phase;
  run.note = safeLogText(note);
  run.updatedAt = Date.now();
  if (phase !== 'waiting-user') run.finishedAt = run.updatedAt;
  run.waiting = undefined;
  run.platformWaitUntil = undefined;
  run.queued = undefined;
  run.active = undefined;
  run.requestStartedAt = undefined;
  const workflow = run.taskId ? state.workflows?.[run.taskId] : undefined;
  if (workflow && workflow.runId === id) {
    workflow.phase = phase;
    workflow.note = run.note;
    workflow.steps[run.stage] = {
      ...workflow.steps[run.stage],
      finishedAt: run.updatedAt,
      note: run.note,
      status:
        phase === 'waiting-user'
          ? 'waiting-user'
          : phase === 'review'
            ? 'review'
            : phase === 'done'
              ? 'done'
              : 'interrupted',
    };
  }
  operationEvent(
    id,
    note,
    { code: phase },
    phase === 'error'
      ? 'error'
      : ['review', 'paused', 'cancelled'].includes(phase)
        ? 'warn'
        : 'info',
  );
  // Telemetry must not hold the execution mutex or prevent cancellation.
  void putRun(run);
  notifyProgress(run);
  await persist(true);
  void flushJournal();
  void pruneJournal().catch(() => {});
}
export function resumeOperation(id: string, stage?: WorkflowStage): void {
  const run = state.operations[id];
  if (!run) return;
  const now = Date.now();
  run.phase = 'running';
  run.finishedAt = undefined;
  run.stage = stage ?? run.stage;
  run.stageStartedAt =
    run.updatedAt =
    run.lastHeartbeatAt =
    run.lastProgressAt =
      now;
  run.done =
    run.total =
    run.success =
    run.review =
    run.queued =
    run.active =
    run.questionNumber =
      undefined;
  run.part = run.engine = run.waiting = undefined;
  run.platformWaitUntil = undefined;
  run.requestStartedAt = run.timeoutSec = run.attempt = undefined;
  operationEvent(id, '用户继续执行', { code: 'user-action' });
  operationEvent(id, `${STAGE_LABEL[run.stage]}开始`, { code: 'stage-start' });
}
