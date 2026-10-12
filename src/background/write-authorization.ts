import type { Binding } from '../messages';
import { state } from './store';
import { assertPlatformReady } from './platform';
import { resolveTask, assertTaskCapability } from '../page-workspace';

export type WriteAction = 'fill' | 'draft' | 'submit' | 'confirm';
export function assertWriteOperation(
  binding: Binding,
  tabId: number,
  frameId: number,
  action: WriteAction,
): void {
  assertPlatformReady();
  const run = binding?.operationId
    ? state.operations[binding.operationId]
    : undefined;
  const expectedStage = {
    fill: 'filling',
    draft: 'saving',
    submit: 'submitting',
    confirm: 'submitting',
  }[action];
  if (
    !run ||
    run.phase !== 'running' ||
    run.stage !== expectedStage ||
    run.accountId !== state.accountId ||
    binding.accountId !== state.accountId
  )
    throw new Error('写入操作已取消、暂停或阶段已变化');
  const task = resolveTask(state, run.taskId ?? '');
  if (!task) throw new Error('当前任务绑定已失效');
  assertTaskCapability(
    task,
    action === 'draft' ? 'save' : action === 'confirm' ? 'submit' : action,
  );
  const workflow = run.taskId ? state.workflows[run.taskId] : undefined;
  if (
    !workflow ||
    workflow.runId !== run.id ||
    workflow.phase !== 'running' ||
    workflow.tabId !== tabId ||
    (action !== 'confirm' && workflow.frameId !== frameId)
  )
    throw new Error('写入页面绑定已失效');
  if (run.kind === 'queue') {
    const item = state.queue.items[state.queue.index];
    if (
      state.queue.phase !== 'running' ||
      state.queue.runId !== run.id ||
      !item ||
      item.taskId !== run.taskId ||
      item.snapshot?.taskKey !== binding.taskKey ||
      item.snapshot?.fingerprint !== binding.fingerprint
    )
      throw new Error('执行队列已停止或任务已变化');
  } else if (run.kind === 'manual') {
    const prepared = state.preparations[run.taskId!];
    if (
      prepared?.taskKey !== binding.taskKey ||
      prepared?.fingerprint !== binding.fingerprint ||
      prepared.providerRevision !== state.providerRevision
    )
      throw new Error('候选或模型配置已变化');
  } else throw new Error('当前操作不允许写入页面');
}
