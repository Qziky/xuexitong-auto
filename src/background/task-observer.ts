import { workspaceFromFrame } from '../page-workspace';
import { mergeTaskRecords } from '../scan-cache';
import { PlatformAccessError } from '../platform-access';
import { discoverFrames } from './transport';
import { checkFrames } from './scan-control';
import { ownedTabs } from './owned-tabs';
import { holdPlatform } from './platform';
import { state, persist, log } from './store';

let scheduled: ReturnType<typeof setTimeout> | undefined;
let version = 0;

export function cancelTaskObservation(): void {
  version++;
  clearTimeout(scheduled);
  scheduled = undefined;
}

export function scheduleActiveTaskObservation(): void {
  cancelTaskObservation();
  scheduled = setTimeout(() => {
    scheduled = undefined;
    void observeActiveTask().catch((error) => {
      log(`当前任务识别失败：${String(error)}`, 'warn');
    });
  }, 250);
}

/** Passive discovery uses describe messages only, with no platform fetch or solving. */
export async function observeActiveTask(): Promise<void> {
  const selection = ++version;
  const accountId = state.accountId;
  const allowed = () =>
    selection === version &&
    state.accountId === accountId &&
    !state.platformBlock &&
    state.queue.phase !== 'running';
  if (!accountId || !allowed()) return;
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!allowed()) return;
  if (tab?.id === undefined || ownedTabs.has(tab.id)) return;
  const all = await discoverFrames(tab.id);
  if (!allowed()) return;
  try {
    checkFrames(all, accountId);
  } catch (error) {
    state.currentTaskId = undefined;
    if (error instanceof PlatformAccessError) await holdPlatform(error.block);
    await persist();
    return;
  }
  const candidates = all
    .filter((ref) => ref.taskKind !== 'exam' && !ref.loginRequired)
    .flatMap((ref) => {
      const w = workspaceFromFrame(ref, state);
      return w ? [w] : [];
    });
  const oldContext = state.currentPage;
  let contentChanged = false;
  if (all.some((ref) => ref.taskKind === 'exam' || ref.loginRequired))
    candidates.length = 0;
  const taskIds = new Set(candidates.map((w) => w.task.platformId));
  if (candidates.length && taskIds.size === 1) {
    const workspace = candidates[0]!;
    const previous = state.workspaces[workspace.id];
    if (
      previous?.task.id === workspace.task.id &&
      previous.bindingRevision === workspace.bindingRevision
    )
      workspace.at = previous.at;
    const comparable = previous
      ? {
          ...workspace,
          task: {
            ...workspace.task,
            source: { ...workspace.task.source, at: previous.task.source.at },
          },
        }
      : workspace;
    contentChanged = JSON.stringify(comparable) !== JSON.stringify(previous);
    state.workspaces[workspace.id] = workspace;
    if (!workspace.task.analysisOnly)
      state.tasks = mergeTaskRecords(state.tasks, [workspace.task]);
    state.currentTaskId = workspace.task.id;
    state.currentPage = {
      kind: 'questions',
      tabId: tab.id,
      url: tab.url ?? workspace.task.url,
      courseId: workspace.task.courseId,
      workspaceId: workspace.id,
    };
  } else {
    state.currentTaskId = undefined;
    const course = state.courses.find((c) =>
      all.some((ref) => {
        try {
          const u = new URL(ref.url);
          return (
            u.searchParams.get('courseid') === c.courseId ||
            u.searchParams.get('courseId') === c.courseId
          );
        } catch {
          return false;
        }
      }),
    );
    state.currentPage = {
      kind: course
        ? 'course'
        : all.some((ref) => /^https:\/\/i\.chaoxing\.com/.test(ref.url))
          ? 'home'
          : 'unsupported',
      tabId: tab.id,
      url: tab.url ?? '',
      courseId: course?.id,
    };
  }
  // Retain a small set of opened page bindings; preparation content has a separate byte budget.
  const older = Object.values(state.workspaces)
    .sort((a, b) => b.at - a.at)
    .slice(20);
  for (const workspace of older)
    if (workspace.id !== state.currentPage.workspaceId)
      delete state.workspaces[workspace.id];
  if (
    JSON.stringify(oldContext) !== JSON.stringify(state.currentPage) ||
    contentChanged
  )
    await persist();
}
