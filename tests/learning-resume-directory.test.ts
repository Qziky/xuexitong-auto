import { afterEach, expect, it, vi } from 'vitest';
import { initialState, type LearningItem } from '../src/domain';
afterEach(() => {
  for (const name of [
    'store',
    'operations',
    'scan-control',
    'transport',
    'chapter-access',
  ])
    vi.doUnmock('../src/background/' + name);
  vi.resetModules();
});
it('resume reads the live directory, binds stable ids after reordering and rejects missing chapters', async () => {
  vi.resetModules();
  const state = initialState();
  state.accountId = 'a';
  state.courses = [
    {
      id: 'c',
      accountId: 'a',
      state: 'active',
      title: 'course',
      url: 'https://mooc1.chaoxing.com/course',
    },
  ] as any;
  const queue = state.learning;
  Object.assign(queue, {
    phase: 'running',
    accountId: 'a',
    courseIds: ['c'],
    cursor: { course: 0, chapter: 0, nextChapterId: 'next' },
  });
  const item = {
    courseId: 'c',
    chapterId: 'current',
    url: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?knowledgeid=current&num=1',
    card: {
      id: 'previous-header',
      url: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?knowledgeid=current&num=1',
    },
  } as LearningItem;
  const ref = {
    tabId: 10,
    frameId: 0,
    documentId: 'new-document',
    url: state.courses[0]!.url,
    accountId: 'a',
    hasLearningMenu: true,
  };
  let chapters = [{ id: 'next' }, { id: 'current' }];
  const card = {
    ...ref,
    frameId: 1,
    hasLearningMenu: false,
    url: item.url.replace('num=1', 'num=0'),
  };
  const frameCall = vi.fn(async (_ref, command) => {
    if (command.op === 'learning-card-menu')
      return {
        chapterId: 'current',
        fingerprint: 'live',
        cards: [
          { id: 'video', number: '0' },
          { id: 'doc', number: '1', actionId: 'read-doc' },
        ],
      };
    if (command.op === 'learning-card-open') {
      card.url = item.url;
      return true;
    }
    return { chapters };
  });
  vi.doMock('../src/background/chapter-access', () => ({
    chapterCardEntry: vi.fn(async () => ({
      url: item.url,
      tabId: 10,
      openedTabIds: [],
    })),
  }));
  vi.doMock('../src/background/store', () => ({ state, persist: vi.fn() }));
  vi.doMock('../src/background/operations', () => ({
    updateOperation: vi.fn(),
  }));
  vi.doMock('../src/background/scan-control', () => ({ checkFrames: vi.fn() }));
  vi.doMock('../src/background/transport', () => ({
    frameCall,
    waitForFrames: vi.fn(async () => [ref]),
    discoverFrames: vi.fn(async () => [ref, card]),
  }));
  const { revalidateLearningDirectory } =
    await import('../src/background/learning-discovery');
  const io = {
    guard: vi.fn(),
    ensureTab: vi.fn(async () => 10),
    readCards: vi.fn(),
  };
  const signal = new AbortController().signal;
  await revalidateLearningDirectory(queue, item, signal, io);
  expect(io.ensureTab).toHaveBeenCalledWith(
    queue,
    state.courses[0]!.url,
    signal,
  );
  expect(queue.cursor?.chapters).toEqual(chapters);
  expect(queue.cursor?.chapter).toBe(0);
  expect(io.readCards).not.toHaveBeenCalled();
  expect(item.card?.id).toBe('doc');
  expect(
    frameCall.mock.calls.some(
      ([, c]) => c.op === 'learning-card-open' && c.actionId === 'read-doc',
    ),
  ).toBe(true);
  chapters = [{ id: 'next' }];
  await expect(
    revalidateLearningDirectory(queue, item, signal, io),
  ).rejects.toThrow('所属章节');
});
