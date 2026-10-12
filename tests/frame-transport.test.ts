import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
import { assertPlatformReady } from '../src/background/platform';
const mock = vi.hoisted(() => ({
  store: { state: undefined as any },
  event: vi.fn(),
}));
vi.mock('../src/background/store', () => mock.store);
vi.mock('../src/background/platform', () => ({
  assertPlatformReady: vi.fn(),
  holdPlatform: vi.fn(),
}));
vi.mock('../src/background/operations', () => ({
  operationEvent: mock.event,
  heartbeatOperation: vi.fn(),
}));
import {
  frameCall,
  discoverFrames,
  FrameCommunicationError,
  frames,
  invalidateLearningFrames,
  notifyFrameRegistry,
  waitForFrames,
} from '../src/background/transport';
const info = {
  url: 'https://mooc1.chaoxing.com/reader',
  top: false,
  loginRequired: false,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(assertPlatformReady).mockImplementation(() => {});
  mock.store.state = initialState();
  invalidateLearningFrames(1);
  vi.stubGlobal('chrome', {
    tabs: { sendMessage: vi.fn(async () => ({ ok: true, value: info })) },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('targets the original document rather than a reused frame ID', async () => {
  await frameCall(
    { tabId: 1, frameId: 4, documentId: 'original' },
    { op: 'describe' },
  );
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.anything(), {
    documentId: 'original',
  });
});
it('channel closure is classified without blindly repeating a write', async () => {
  vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(
    new Error(
      'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
    ),
  );
  await expect(
    frameCall({ tabId: 1, frameId: 4 }, { op: 'submit', binding: {} as any }),
  ).rejects.toMatchObject({
    code: 'frame-disconnected',
    message: expect.stringContaining('页面通信中断'),
  });
  expect(chrome.tabs.sendMessage).toHaveBeenCalledOnce();
});
it('a stalled description has a short timeout and releases its timers', async () => {
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(
    () => new Promise(() => {}) as any,
  );
  const response = frameCall(
    { tabId: 1, frameId: 4 },
    { op: 'describe' },
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await response).toBeInstanceOf(FrameCommunicationError);
  expect(vi.getTimerCount()).toBe(0);
});
it('verification blocking still permits immediate native pause commands', async () => {
  vi.mocked(assertPlatformReady).mockImplementation(() => {
    throw new Error('验证码暂停');
  });
  await expect(
    frameCall({ tabId: 1, frameId: 4 }, { op: 'video-pause' }),
  ).resolves.toBeDefined();
  await expect(
    frameCall({ tabId: 1, frameId: 4 }, { op: 'reader-pause' }),
  ).resolves.toBeDefined();
  await expect(
    frameCall(
      { tabId: 1, frameId: 4 },
      { op: 'video-play', binding: {} as any },
    ),
  ).rejects.toThrow('验证码');
  expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
});
it('cancellation aborts the pending startup receipt immediately', async () => {
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(
    () => new Promise(() => {}) as any,
  );
  const control = new AbortController();
  const response = frameCall(
    { tabId: 1, frameId: 4 },
    { op: 'video-play', binding: {} as any, deferred: true },
    { signal: control.signal },
  ).catch((error) => error);
  control.abort();
  expect(await response).toMatchObject({
    message: expect.stringContaining('取消'),
  });
  expect(vi.getTimerCount()).toBe(0);
});
it('one navigating iframe does not serially delay every loaded sibling', async () => {
  const send = vi.fn((_id, _message, options) =>
    options.documentId === 'loading'
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, value: info }),
  );
  vi.stubGlobal('chrome', {
    tabs: { sendMessage: send },
    webNavigation: {
      getAllFrames: vi.fn(async () => [
        { frameId: 1, documentId: 'loading', url: info.url },
        { frameId: 2, documentId: 'loaded-1', url: info.url },
        { frameId: 3, documentId: 'loaded-2', url: info.url },
      ]),
    },
  });
  const result = discoverFrames(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(2999);
  expect((await result).map((f) => f.documentId)).toEqual([
    'loaded-1',
    'loaded-2',
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
it('reuses trusted frame-ready data and falls back at most once a second', async () => {
  const enumerate = vi.fn(async () => [
    { frameId: 4, documentId: 'current', url: info.url },
  ]);
  vi.stubGlobal('chrome', {
    tabs: { sendMessage: vi.fn(async () => ({ ok: true, value: info })) },
    webNavigation: { getAllFrames: enumerate },
  });
  frames.set('1:4', { ...info, tabId: 1, frameId: 4, documentId: 'current' });
  notifyFrameRegistry(1);
  expect(await discoverFrames(1, undefined, true)).toHaveLength(1);
  expect(enumerate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  await discoverFrames(1, undefined, true);
  await discoverFrames(1, undefined, true);
  expect(enumerate).toHaveBeenCalledOnce();
});
it('wakes immediately on a matching document event without a full frame probe', async () => {
  const enumerate = vi.fn(async () => []);
  vi.stubGlobal('chrome', {
    tabs: { sendMessage: vi.fn() },
    webNavigation: { getAllFrames: enumerate },
  });
  const pending = waitForFrames(
    1,
    (f) => f.documentId === 'new',
    undefined,
    30000,
    true,
  );
  await vi.advanceTimersByTimeAsync(10);
  frames.set('1:9', { ...info, tabId: 1, frameId: 9, documentId: 'new' });
  notifyFrameRegistry(1);
  expect((await pending)[0]?.documentId).toBe('new');
  expect(enumerate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('discards pending probe results after navigation and invalidates nested documents', async () => {
  let finish!: (value: any) => void;
  vi.stubGlobal('chrome', {
    tabs: {
      sendMessage: vi.fn(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      ),
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => [
        { frameId: 4, documentId: 'old', url: info.url },
      ]),
    },
  });
  frames.set('1:4', { ...info, tabId: 1, frameId: 4, documentId: 'old' });
  frames.set('1:9', {
    ...info,
    tabId: 1,
    frameId: 9,
    parentFrameId: 4,
    documentId: 'nested-old',
  });
  const pending = discoverFrames(1, undefined, true);
  await vi.advanceTimersByTimeAsync(0);
  invalidateLearningFrames(1, 4);
  finish({ ok: true, value: info });
  expect(await pending).toEqual([]);
  expect([...frames.values()].filter((f) => f.tabId === 1)).toEqual([]);
});
it('cancels event waiting without a late probe', async () => {
  const enumerate = vi.fn(async () => []);
  vi.stubGlobal('chrome', {
    tabs: { sendMessage: vi.fn() },
    webNavigation: { getAllFrames: enumerate },
  });
  const control = new AbortController();
  const pending = waitForFrames(
    1,
    () => true,
    control.signal,
    30000,
    true,
  ).catch((e) => e);
  await vi.advanceTimersByTimeAsync(10);
  control.abort();
  expect(await pending).toMatchObject({ message: '操作已取消' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(enumerate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
