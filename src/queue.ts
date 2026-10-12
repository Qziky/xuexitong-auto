import type {
  AppState,
  ExecutionQueue,
  QueueItem,
  DraftPolicy,
  TaskRecord,
} from './domain';

export const TERMINAL = new Set([
  'submitted',
  'draft-saved',
  'review',
  'failed',
  'skipped',
]);
export function createQueue(
  tasks: TaskRecord[],
  accountId: string,
  policy: DraftPolicy,
  goal: 'submit' | 'draft' = 'submit',
): ExecutionQueue {
  const selected = tasks.filter(
    (t) =>
      t.accountId === accountId &&
      t.type !== 'video' &&
      (t.type !== 'quiz' || t.discovery === 'opened') &&
      !t.analysisOnly &&
      (t.listed !== false || (t.type === 'quiz' && t.discovery === 'opened')) &&
      ['pending', 'unknown', 'review'].includes(t.status),
  );
  if (!selected.length) throw new Error('请选择尚未提交的测验或作业');
  return {
    id: crypto.randomUUID(),
    accountId,
    policy,
    goal,
    phase: 'running',
    items: selected.map((t) => ({ taskId: t.id, stage: 'waiting' })),
    index: 0,
    startedAt: Date.now(),
  };
}
export function recoverQueue(queue: ExecutionQueue): ExecutionQueue {
  if (queue.phase !== 'running') return queue;
  const items = queue.items.map((item) => {
    if (TERMINAL.has(item.stage)) return item;
    if (item.draftAttempted && item.draftSnapshot)
      return {
        ...item,
        stage: 'verifying' as const,
        note: '恢复后先核验上次草稿，不重复保存',
      };
    if (
      item.submitAttempted ||
      ['submitting', 'verifying'].includes(item.stage)
    )
      return {
        ...item,
        stage: 'verifying' as const,
        submitAttempted: true,
        note: '恢复后先核验上次提交结果',
      };
    return {
      ...item,
      stage: 'waiting' as const,
      snapshot: undefined,
      proposals: undefined,
      note: '恢复后重新读取题目及草稿',
    };
  });
  return {
    ...queue,
    items,
    phase: 'paused',
    note: '执行已中断，请检查登录账号后点击继续',
  };
}
export function canSubmit(item: QueueItem): boolean {
  return !item.submitAttempted && item.stage === 'readback';
}
export function accountGuard(
  state: AppState,
  actualAccount: string | undefined,
): void {
  if (!actualAccount)
    throw new Error('无法确认当前账号，请回到个人中心重新扫描');
  if (
    state.queue.accountId !== actualAccount ||
    state.accountId !== actualAccount
  )
    throw new Error('登录账号已变化，执行已暂停');
}
