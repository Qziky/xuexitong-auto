export interface LearningForegroundTarget {
  learningId: string;
  tabId: number;
}

export class ForegroundUnavailableError extends Error {
  readonly code = 'foreground-unavailable';

  constructor(message = '无法保持学习页面在前台，学习已暂停') {
    super(message);
  }
}

type ForegroundSession = LearningForegroundTarget & { generation: number };
type FailureHandler = (
  learningId: string,
  error: ForegroundUnavailableError,
) => void | Promise<void>;

let session: ForegroundSession | undefined;
let generation = 0;
let scheduled: ReturnType<typeof setTimeout> | undefined;
let drain: Promise<void> | undefined;
let requested = false;
let isRunning: (learningId: string) => boolean = () => true;
let onFailure: FailureHandler = () => {};
let removeListeners: (() => void) | undefined;

export function installLearningForegroundController(
  active: (learningId: string) => boolean,
  failure: FailureHandler,
): () => void {
  if (removeListeners) return removeListeners;
  isRunning = active;
  onFailure = failure;
  const reconcile = () => scheduleReconcile();
  chrome.tabs.onActivated?.addListener(reconcile);
  chrome.windows.onFocusChanged?.addListener(reconcile);
  removeListeners = () => {
    chrome.tabs.onActivated?.removeListener(reconcile);
    chrome.windows.onFocusChanged?.removeListener(reconcile);
    releaseLearningForeground();
    removeListeners = undefined;
  };
  return removeListeners;
}

export async function retainLearningForeground(
  learningId: string,
  tabId: number,
): Promise<void> {
  // Unit environments without the browser windows API exercise queue behavior
  // separately; the production extension always provides these APIs.
  if (
    typeof chrome === 'undefined' ||
    !chrome.tabs?.get ||
    !chrome.tabs?.update ||
    !chrome.windows?.get ||
    !chrome.windows?.update
  )
    return;
  if (!isRunning(learningId))
    throw new ForegroundUnavailableError('学习已暂停，取消前台切换');
  session = { learningId, tabId, generation: ++generation };
  await requestReconcile();
}

export function releaseLearningForeground(learningId?: string): void {
  if (learningId && session?.learningId !== learningId) return;
  session = undefined;
  generation++;
  requested = false;
  if (scheduled) clearTimeout(scheduled);
  scheduled = undefined;
}

function scheduleReconcile(): void {
  if (scheduled || !session) return;
  scheduled = setTimeout(() => {
    scheduled = undefined;
    void requestReconcile().catch(() => {});
  }, 40);
}

function requestReconcile(): Promise<void> {
  requested = true;
  if (!drain) {
    drain = (async () => {
      while (requested) {
        requested = false;
        const current = session;
        if (!current) continue;
        try {
          await focusTarget(current);
        } catch (error) {
          if (session !== current) continue;
          session = undefined;
          generation++;
          const unavailable =
            error instanceof ForegroundUnavailableError
              ? error
              : new ForegroundUnavailableError();
          await onFailure(current.learningId, unavailable);
          throw unavailable;
        }
      }
    })().finally(() => {
      drain = undefined;
      if (requested) void requestReconcile().catch(() => {});
    });
  }
  return drain;
}

async function focusTarget(target: ForegroundSession): Promise<void> {
  if (!isRunning(target.learningId)) {
    if (session === target) releaseLearningForeground(target.learningId);
    return;
  }
  let lastError: ForegroundUnavailableError | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (session !== target) return;
    try {
      const tab = await chrome.tabs.get(target.tabId).catch(() => undefined);
      if (session !== target) return;
      if (tab?.windowId === undefined)
        throw new ForegroundUnavailableError('学习标签页或所属窗口已关闭');
      let window = await chrome.windows
        .get(tab.windowId)
        .catch(() => undefined);
      if (session !== target) return;
      if (!window) throw new ForegroundUnavailableError('学习窗口已关闭');
      if (window.state === 'minimized') {
        await chrome.windows.update(tab.windowId, { state: 'normal' });
        if (session !== target) return;
        window = await chrome.windows.get(tab.windowId).catch(() => undefined);
        if (session !== target) return;
        if (!window) throw new ForegroundUnavailableError('学习窗口恢复失败');
      }
      if (!window.focused)
        await chrome.windows.update(tab.windowId, { focused: true });
      if (session !== target) return;
      if (!tab.active) await chrome.tabs.update(target.tabId, { active: true });
      if (session !== target) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      if (session !== target) return;
      const [currentTab, currentWindow] = await Promise.all([
        chrome.tabs.get(target.tabId).catch(() => undefined),
        chrome.windows.get(tab.windowId).catch(() => undefined),
      ]);
      if (session !== target) return;
      if (currentTab?.active && currentWindow?.focused) return;
      lastError = new ForegroundUnavailableError();
    } catch (error) {
      if (session !== target) return;
      lastError =
        error instanceof ForegroundUnavailableError
          ? error
          : new ForegroundUnavailableError('激活学习页面失败');
    }
    if (attempt < 2)
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
  }
  throw lastError ?? new ForegroundUnavailableError();
}
