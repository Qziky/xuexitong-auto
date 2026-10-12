import { afterEach, expect, it, vi } from 'vitest';

function event<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => listeners.add(listener)),
    removeListener: vi.fn((listener: T) => listeners.delete(listener)),
    emit: (...args: Parameters<T>) =>
      listeners.forEach((listener) => listener(...args)),
  };
}

let api: typeof import('../src/background/learning-foreground');
let stop: (() => void) | undefined;
let tabs: Map<number, { id: number; windowId: number; active: boolean }>;
let windows: Map<number, { id: number; focused: boolean; state: string }>;
let activated: ReturnType<typeof event<(...args: any[]) => void>>;
let focused: ReturnType<typeof event<(...args: any[]) => void>>;

async function setup(
  options: { rejectFocus?: boolean; focusFailures?: number } = {},
) {
  vi.useFakeTimers();
  tabs = new Map([
    [1, { id: 1, windowId: 10, active: false }],
    [2, { id: 2, windowId: 10, active: true }],
  ]);
  windows = new Map([[10, { id: 10, focused: false, state: 'normal' }]]);
  activated = event();
  focused = event();
  vi.stubGlobal('chrome', {
    tabs: {
      onActivated: activated,
      get: vi.fn(async (id: number) => tabs.get(id)),
      update: vi.fn(async (id: number, update: { active?: boolean }) => {
        const tab = tabs.get(id)!;
        if (update.active) {
          for (const other of tabs.values())
            if (other.windowId === tab.windowId) other.active = false;
          tab.active = true;
          activated.emit({ tabId: id, windowId: tab.windowId });
        }
        return tab;
      }),
    },
    windows: {
      onFocusChanged: focused,
      get: vi.fn(async (id: number) => windows.get(id)),
      update: vi.fn(
        async (id: number, update: { focused?: boolean; state?: string }) => {
          if (update.focused && options.focusFailures) {
            options.focusFailures--;
            throw new Error('transient focus failure');
          }
          const win = windows.get(id)!;
          if (update.state) win.state = update.state;
          if (update.focused && !options.rejectFocus) {
            for (const other of windows.values()) other.focused = false;
            win.focused = true;
            focused.emit(id);
          }
          return win;
        },
      ),
    },
  });
  vi.resetModules();
  api = await import('../src/background/learning-foreground');
  stop = api.installLearningForegroundController(() => true, vi.fn());
}

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('activates a learning tab and focuses its non-minimized window', async () => {
  await setup();
  const pending = api.retainLearningForeground('learning-1', 1);
  await vi.runAllTimersAsync();
  await pending;
  expect(tabs.get(1)?.active).toBe(true);
  expect(windows.get(10)?.focused).toBe(true);
});

it('restores a minimized window and reclaims the task after a tab switch', async () => {
  await setup();
  windows.get(10)!.state = 'minimized';
  const pending = api.retainLearningForeground('learning-1', 1);
  await vi.runAllTimersAsync();
  await pending;
  expect(windows.get(10)?.state).toBe('normal');

  tabs.get(1)!.active = false;
  tabs.get(2)!.active = true;
  windows.get(10)!.focused = false;
  focused.emit(-1);
  await vi.runAllTimersAsync();
  expect(tabs.get(1)?.active).toBe(true);
  expect(windows.get(10)?.focused).toBe(true);
});

it('retries a transient focus API failure before reporting success', async () => {
  await setup({ focusFailures: 1 });
  const pending = api.retainLearningForeground('learning-1', 1);
  await vi.runAllTimersAsync();
  await pending;
  expect(tabs.get(1)?.active).toBe(true);
  expect(windows.get(10)?.focused).toBe(true);
  expect(chrome.windows.update).toHaveBeenCalledTimes(2);
});

it('pauses after three failed focus attempts and releases the lock', async () => {
  await setup({ rejectFocus: true });
  const failed = vi.fn();
  stop?.();
  stop = api.installLearningForegroundController(() => true, failed);
  const pending = api
    .retainLearningForeground('learning-1', 1)
    .catch((error) => error);
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toMatchObject({
    code: 'foreground-unavailable',
  });
  expect(failed).toHaveBeenCalledOnce();
  focused.emit(-1);
  await vi.runAllTimersAsync();
  expect(failed).toHaveBeenCalledOnce();
});

it('does not reactivate a tab after the learning queue releases its lock', async () => {
  await setup();
  const pending = api.retainLearningForeground('learning-1', 1);
  await vi.runAllTimersAsync();
  await pending;
  api.releaseLearningForeground('learning-1');
  tabs.get(1)!.active = false;
  tabs.get(2)!.active = true;
  activated.emit({ tabId: 2, windowId: 10 });
  await vi.runAllTimersAsync();
  expect(tabs.get(2)?.active).toBe(true);
});

it('discards a pending activation callback after the queue pauses', async () => {
  await setup();
  let complete!: (tab: {
    id: number;
    windowId: number;
    active: boolean;
  }) => void;
  vi.mocked(chrome.tabs.get).mockImplementationOnce(
    () => new Promise((resolve) => (complete = resolve)) as any,
  );
  const pending = api.retainLearningForeground('learning-1', 1);
  api.releaseLearningForeground('learning-1');
  complete({ id: 1, windowId: 10, active: false });
  await pending;
  await vi.runAllTimersAsync();
  expect(chrome.windows.update).not.toHaveBeenCalled();
  expect(chrome.tabs.update).not.toHaveBeenCalled();
});
