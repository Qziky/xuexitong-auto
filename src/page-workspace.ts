import type {
  AppState,
  PageCapabilities,
  PageWorkspace,
  TaskRecord,
} from './domain';
import type { FrameInfo } from './messages';
import { openedTaskFromFrame } from './opened-task';
import { mergeTaskRecords } from './scan-cache';

export function taskCapabilities(task: TaskRecord): PageCapabilities {
  const analyze = task.type !== 'video';
  const writable =
    analyze &&
    !task.analysisOnly &&
    task.pageMode !== 'preview' &&
    ['pending', 'review'].includes(task.status) &&
    (!task.deadline || task.deadline > Date.now());
  return { analyze, fill: writable, save: writable, submit: writable };
}

export function workspaceFromFrame(
  ref: FrameInfo & { tabId: number; frameId: number },
  state: AppState,
): PageWorkspace | undefined {
  if (!state.accountId) return undefined;
  const opened = openedTaskFromFrame(
    ref,
    state.accountId,
    state.courses,
    state.tasks,
  );
  if (!opened) return undefined;
  const original = mergeTaskRecords(state.tasks, [opened]).find(
    (t) => t.id === opened.id,
  )!;
  const id = `page:${ref.tabId}:${ref.frameId}:${original.id}`;
  const capabilities = taskCapabilities(original);
  const task = capabilities.fill
    ? original
    : {
        ...original,
        id,
        analysisOnly: true,
        listed: false,
        note: '当前页仅提供识别、参考、核对和导出',
      };
  return {
    id,
    task,
    tabId: ref.tabId,
    frameId: ref.frameId,
    taskKey: ref.taskKey!,
    bindingRevision: ref.revision,
    capabilities: taskCapabilities(task),
    at: Date.now(),
  };
}

export function resolveWorkspace(
  state: AppState,
  id: string,
): PageWorkspace | undefined {
  const current = state.currentPage?.workspaceId
    ? state.workspaces[state.currentPage.workspaceId]
    : undefined;
  return current?.task.id === id
    ? current
    : Object.values(state.workspaces ?? {}).find((w) => w.task.id === id);
}

export function resolveTask(
  state: AppState,
  id: string,
): TaskRecord | undefined {
  return (
    resolveWorkspace(state, id)?.task ??
    state.tasks.find((task) => task.id === id)
  );
}

/** A server receipt must update both the current workspace and its listed copy. */
export function recordVerifiedSubmission(
  state: AppState,
  task: TaskRecord,
  grade?: string,
): void {
  const matches = (other: TaskRecord) =>
    other.accountId === task.accountId &&
    other.courseId === task.courseId &&
    other.type === task.type &&
    other.platformId === task.platformId;
  for (const copy of [
    task,
    ...state.tasks,
    ...Object.values(state.workspaces).map((w) => w.task),
  ]) {
    if (!matches(copy)) continue;
    copy.status = 'submitted';
    if (grade !== undefined) copy.grade = grade;
    copy.note = '平台已确认提交';
  }
  for (const workspace of Object.values(state.workspaces))
    if (matches(workspace.task))
      workspace.capabilities = taskCapabilities(workspace.task);
}

export function assertTaskCapability(
  task: TaskRecord,
  action: 'analyze' | 'fill' | 'save' | 'submit',
): void {
  if (!taskCapabilities(task)[action])
    throw new Error(
      action === 'analyze'
        ? '当前页面不支持题目分析'
        : '当前页为只读预览或已结束，只能查看参考和导出，不能填写、保存或提交',
    );
}
