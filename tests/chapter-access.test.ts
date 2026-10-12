import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  discover: vi.fn(),
  accessible: vi.fn(),
  listener: undefined as any,
}));
vi.mock('../src/background/transport', () => ({
  frameCall: mocks.call,
  discoverFrames: mocks.discover,
  assertFramesAccessible: mocks.accessible,
  frameChangeOrTimeout: async () => {},
}));
vi.mock('../src/background/platform', () => ({
  accessPlatform: vi.fn(async (action: () => unknown) => action()),
}));
import {
  chapterCardEntry,
  closeChapterTabs,
} from '../src/background/chapter-access';
import { ownedTabs } from '../src/background/owned-tabs';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  ownedTabs.clear();
});
it('reuses the exact loaded chapter without a second navigation; waits for stale content to be replaced', async () => {
  vi.stubGlobal('chrome', {
    tabs: { query: async () => [] },
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
  const url = 'https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=301';
  mocks.discover.mockResolvedValue([
    {
      url,
      tabId: 2,
      frameId: 8,
      documentId: 'new',
      learningCardIdentity: { chapterId: '301', cardNumber: '0', ready: true },
    },
  ]);
  const ref = { tabId: 2, frameId: 3 } as any,
    chapter = { id: '301', actionId: 'a', title: 'c', complete: false };
  await chapterCardEntry(ref, chapter, 'fp', new AbortController().signal);
  expect(mocks.call).not.toHaveBeenCalled();
  mocks.discover
    .mockResolvedValueOnce([
      {
        url,
        tabId: 2,
        frameId: 8,
        learningCardIdentity: {
          chapterId: '301',
          cardNumber: '0',
          ready: false,
        },
      },
    ])
    .mockResolvedValueOnce([
      {
        url,
        tabId: 2,
        frameId: 8,
        learningCardIdentity: {
          chapterId: '301',
          cardNumber: '0',
          ready: false,
        },
      },
    ])
    .mockResolvedValueOnce([
      {
        url,
        tabId: 2,
        frameId: 8,
        learningCardIdentity: {
          chapterId: '301',
          cardNumber: '0',
          ready: true,
        },
      },
    ]);
  mocks.call.mockResolvedValue(true);
  const result = await chapterCardEntry(
    ref,
    chapter,
    'fp',
    new AbortController().signal,
  );
  expect(result.url).toBe(url);
  expect(mocks.call).toHaveBeenCalledOnce();
});
it('真实导航产生的子标签页按章节绑定读取，后台回收标签且不猜链接', async () => {
  const remove = vi.fn(async () => {}),
    update = vi.fn(async () => ({})),
    removeListener = vi.fn();
  vi.stubGlobal('chrome', {
    tabs: {
      query: async () => [{ id: 1 }],
      get: async () => ({ active: true }),
      update,
      remove,
    },
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: vi.fn((fn) => {
          mocks.listener = fn;
        }),
        removeListener,
      },
    },
  });
  mocks.call.mockImplementation(async () => {
    mocks.listener({
      sourceTabId: 2,
      sourceFrameId: 3,
      tabId: 5,
      url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=301',
    });
    mocks.listener({
      sourceTabId: 999,
      tabId: 6,
      url: 'https://mooc1.chaoxing.com/other',
    });
  });
  mocks.discover.mockImplementation(async (id) =>
    id === 5
      ? [
          {
            url: 'https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=301',
            tabId: 5,
            frameId: 8,
          },
        ]
      : [],
  );
  const card = await chapterCardEntry(
    { tabId: 2, frameId: 3 } as any,
    { id: '301', actionId: 'action', title: '章节', complete: false },
    'fp',
    new AbortController().signal,
  );
  expect(card.tabId).toBe(5);
  expect(card.openedTabIds).toEqual([5]);
  expect(ownedTabs.has(5)).toBe(true);
  expect(ownedTabs.has(6)).toBe(false);
  expect(mocks.call).toHaveBeenCalledWith(
    { tabId: 2, frameId: 3 },
    { op: 'learning-open', actionId: 'action', fingerprint: 'fp' },
    { signal: expect.any(AbortSignal) },
  );
  expect(removeListener).toHaveBeenCalled();
  await closeChapterTabs(card.openedTabIds);
  expect(remove).toHaveBeenCalledWith(5);
  expect(ownedTabs.has(5)).toBe(false);
});
it('学习期间接管平台新建的章节页，不恢复到原标签页', async () => {
  const update = vi.fn(async () => ({}));
  vi.stubGlobal('chrome', {
    tabs: {
      query: async () => [{ id: 1 }],
      get: async () => ({ active: true }),
      update,
      remove: vi.fn(async () => {}),
    },
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: vi.fn((fn) => {
          mocks.listener = fn;
        }),
        removeListener: vi.fn(),
      },
    },
  });
  const foregroundTarget = vi.fn(async () => {});
  mocks.call.mockImplementation(async () => {
    mocks.listener({
      sourceTabId: 2,
      tabId: 5,
      url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=301',
    });
  });
  mocks.discover.mockImplementation(async (id) =>
    id === 5
      ? [
          {
            url: 'https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=301',
            tabId: 5,
            frameId: 8,
          },
        ]
      : [],
  );
  await chapterCardEntry(
    { tabId: 2, frameId: 3 } as any,
    { id: '301', actionId: 'action', title: '章节', complete: false },
    'fp',
    new AbortController().signal,
    { foregroundTarget },
  );
  expect(foregroundTarget).toHaveBeenCalledWith(5);
  expect(update).not.toHaveBeenCalled();
});
it('取消导航后关闭本轮子页并清理事件监听，不处理其他标签', async () => {
  const remove = vi.fn(async () => {}),
    removeListener = vi.fn(),
    controller = new AbortController();
  vi.stubGlobal('chrome', {
    tabs: {
      query: async () => [],
      get: async () => ({ active: false }),
      remove,
    },
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: vi.fn((fn) => {
          mocks.listener = fn;
        }),
        removeListener,
      },
    },
  });
  mocks.call.mockImplementation(async () => {
    mocks.listener({ sourceTabId: 2, tabId: 5, url: 'about:blank' });
    controller.abort();
  });
  await expect(
    chapterCardEntry(
      { tabId: 2, frameId: 3 } as any,
      { id: '301', actionId: 'action', title: '章节', complete: false },
      'fp',
      controller.signal,
    ),
  ).rejects.toThrow('暂停');
  expect(remove).toHaveBeenCalledWith(5);
  expect(removeListener).toHaveBeenCalled();
});
it('accepts the exact new card after a navigation closes the reply channel, without clicking twice', async () => {
  vi.stubGlobal('chrome', {
    tabs: { query: async () => [] },
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
  const url = 'https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=301';
  mocks.discover.mockResolvedValueOnce([]).mockResolvedValue([
    {
      url,
      tabId: 2,
      frameId: 8,
      documentId: 'new',
      learningCardIdentity: {
        chapterId: '301',
        cardNumber: '0',
        ready: true,
      },
    },
  ]);
  mocks.call.mockRejectedValue(
    Object.assign(new Error('channel closed'), { code: 'frame-disconnected' }),
  );
  const check = vi.fn();
  const result = await chapterCardEntry(
    { tabId: 2, frameId: 3 } as any,
    { id: '301', actionId: 'a', title: 'chapter', complete: false },
    'fp',
    new AbortController().signal,
    { check },
  );
  expect(result.url).toBe(url);
  expect(mocks.call).toHaveBeenCalledOnce();
  expect(check).toHaveBeenCalledOnce();
});
it('does not recover a navigation reply when the run has been cancelled or platform blocked', async () => {
  vi.stubGlobal('chrome', {
    tabs: { query: async () => [] },
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
  mocks.discover.mockResolvedValue([]);
  mocks.call.mockRejectedValue(
    Object.assign(new Error('9010'), { code: 'captcha' }),
  );
  await expect(
    chapterCardEntry(
      { tabId: 2, frameId: 3 } as any,
      { id: '301', actionId: 'a', title: 'chapter', complete: false },
      'fp',
      new AbortController().signal,
    ),
  ).rejects.toThrow('9010');
  expect(mocks.discover).toHaveBeenCalledOnce();
  mocks.discover.mockClear();
  const controller = new AbortController();
  mocks.call.mockImplementation(async () => {
    controller.abort();
    throw Object.assign(new Error('cancelled'), { code: 'frame-disconnected' });
  });
  await expect(
    chapterCardEntry(
      { tabId: 2, frameId: 3 } as any,
      { id: '301', actionId: 'a', title: 'chapter', complete: false },
      'fp',
      controller.signal,
    ),
  ).rejects.toThrow('cancelled');
  expect(mocks.discover).toHaveBeenCalledOnce();
});
