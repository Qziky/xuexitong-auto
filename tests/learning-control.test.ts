import { afterEach, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
afterEach(() => vi.unstubAllGlobals());
it('cancelling during directory loading preserves the stopped checkpoint and cancellation reason', async () => {
  const state = initialState();
  state.accountId = 'a';
  state.courses = [
    {
      id: 'c',
      accountId: 'a',
      title: 'course',
      url: 'https://mooc1.chaoxing.com/course',
      state: 'active',
      scannedAt: 1,
      warnings: [],
    } as any,
  ];
  const finish = vi.fn(async () => {});
  const frames = vi.fn(
    (_tab: unknown, _predicate: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new Error('读取已取消')),
          { once: true },
        ),
      ),
  );
  vi.doMock('../src/background/store', () => ({
    state,
    persist: vi.fn(async () => {}),
    log: vi.fn(),
  }));
  vi.doMock('../src/background/operations', () => ({
    beginOperation: () => 'run',
    updateOperation: vi.fn(),
    heartbeatOperation: vi.fn(),
    finishOperation: finish,
    resumeOperation: vi.fn(),
  }));
  vi.doMock('../src/background/scan-control', () => ({
    cancelScanAndWait: vi.fn(async () => {}),
    checkFrames: vi.fn(),
  }));
  vi.doMock('../src/background/workflows', () => ({
    cancelWorkflowAndWait: vi.fn(async () => {}),
    manualRunning: () => false,
  }));
  vi.doMock('../src/background/platform', () => ({
    accessPlatform: vi.fn(async (action: () => unknown) => action()),
    assertPlatformReady: vi.fn(),
    holdPlatform: vi.fn(),
  }));
  vi.doMock('../src/background/transport', () => ({
    frameCall: vi.fn(),
    discoverFrames: vi.fn(),
    waitForFrames: frames,
    offscreen: vi.fn(),
  }));
  vi.doMock('../src/background/executor', () => ({
    startQueue: vi.fn(),
    resumeQueue: vi.fn(),
    pauseQueue: vi.fn(),
    awaitQueueIdle: vi.fn(),
  }));
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(), create: vi.fn(async () => ({ id: 10 })) },
  });
  const learning = await import('../src/background/learning');
  learning.startLearning(['c'], 'video', 'draft', 'preserve');
  await vi.waitFor(() => expect(frames).toHaveBeenCalledOnce());
  await learning.pauseLearning(true);
  expect(state.learning.phase).toBe('stopped');
  expect(state.learning.note).toBe('学习已停止');
  expect(finish).toHaveBeenLastCalledWith('run', 'cancelled', '学习已停止');
});
