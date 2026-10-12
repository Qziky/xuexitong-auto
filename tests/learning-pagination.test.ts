import { expect, it, vi } from 'vitest';
import { initialState, type LearningTaskType } from '../src/domain';
it.each([['video', 'document', 'image'], ['document']])(
  'yields each card for selected types %j without returning to skipped cards or prefetching',
  async (...types) => {
    vi.resetModules();
    const s = initialState();
    s.accountId = 'a';
    s.courses = [
      {
        id: 'c',
        accountId: 'a',
        state: 'active',
        title: 'course',
        url: 'https://mooc1.chaoxing.com/course',
      } as any,
    ];
    s.learning = {
      ...s.learning,
      id: 'l',
      phase: 'running',
      accountId: 'a',
      courseIds: ['c'],
      selectedTypes: types as Exclude<LearningTaskType, 'unknown'>[],
      cursor: {
        course: 0,
        chapter: 0,
        nextChapterId: '300',
        nextCardId: 'stale-card',
        cardIds: ['stale-card'],
      },
    };
    let num = '0';
    const url = () =>
      'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?knowledgeid=300&num=' +
      num;
    const menu = {
      fingerprint: 'dir',
      chapters: [
        { id: '300', title: 'first', actionId: 'c300', complete: false },
        { id: '301', title: 'next', actionId: 'c301', complete: false },
      ],
    };
    const cardMenu = {
      fingerprint: 'cards',
      cards: ['0', '1', '2'].map((n) => ({
        id: n,
        title: n,
        actionId: 'card' + n,
        number: n,
      })),
    };
    const frames = () => [
      {
        tabId: 10,
        frameId: 0,
        documentId: 'menu-' + num,
        url: 'https://mooc1.chaoxing.com/course',
        top: true,
        accountId: 'a',
        hasLearningMenu: true,
      },
      { tabId: 10, frameId: 1, url: url(), top: false },
    ];
    let headerReads = 0;
    const dispatch = vi.fn(async (_ref, command) => {
      if (_ref.frameId === 0 && _ref.documentId !== 'menu-' + num)
        throw new Error('stale menu document');
      if (command.op === 'learning-menu') return menu;
      if (command.op === 'learning-card-menu') {
        if (_ref.frameId !== 0) return { cards: [] };
        return ++headerReads === 1
          ? {
              ...cardMenu,
              chapterId: '299',
              cards: cardMenu.cards.map((c) => ({ ...c, id: 'old' + c.id })),
            }
          : { ...cardMenu, chapterId: '300' };
      }
      if (command.op === 'learning-card-open') {
        num = command.actionId.slice(-1);
        return true;
      }
    });
    vi.doMock('../src/background/store', () => ({
      state: s,
      persist: vi.fn(async () => {}),
    }));
    vi.doMock('../src/background/operations', () => ({
      updateOperation: vi.fn(),
      operationEvent: vi.fn(),
    }));
    vi.doMock('../src/background/scan-control', () => ({
      checkFrames: vi.fn((all) => {
        if (!all.length) throw new Error('empty frame identity');
      }),
    }));
    vi.doMock('../src/background/platform', () => ({
      accessPlatform: vi.fn(async (action: () => unknown) => action()),
    }));
    vi.doMock('../src/background/transport', () => ({
      discoverFrames: vi.fn(async () => frames()),
      frameCall: dispatch,
      frameChangeOrTimeout: vi.fn(async () => {}),
      waitForFrames: vi.fn(async (_tab, predicate) =>
        frames().filter(predicate),
      ),
    }));
    const open = vi.fn(async () => {
      return { url: url(), tabId: 10, openedTabIds: [] };
    });
    vi.doMock('../src/background/chapter-access', () => ({
      chapterCardEntry: open,
      closeChapterTabs: vi.fn(async () => {}),
    }));
    try {
      const { discoverNextChapter } =
        await import('../src/background/learning-discovery');
      const readCards = vi.fn(async (marker: any) => {
        const n = new URL(marker.url).searchParams.get('num');
        return [
          {
            ...marker,
            id: 'job' + n,
            jobId: 'job' + n,
            type: n === '0' ? 'video' : n === '1' ? 'document' : 'image',
          },
        ];
      });
      await discoverNextChapter(s.learning, new AbortController().signal, {
        guard: vi.fn(),
        ensureTab: vi.fn(async () => 10),
        readCards,
      });
      expect(
        readCards.mock.calls.map((c) =>
          new URL(c[0].url).searchParams.get('num'),
        ),
      ).toEqual(['0']);
      expect(s.learning.cursor?.nextCardId).toBe('1');
      expect(s.learning.cursor?.chapter).toBe(0);
      expect(
        dispatch.mock.calls.filter((c) => c[1].op === 'learning-card-open'),
      ).toHaveLength(0);
      if (s.learning.items[0]) s.learning.items[0].phase = 'done';
      await discoverNextChapter(s.learning, new AbortController().signal, {
        guard: vi.fn(),
        ensureTab: vi.fn(async () => 10),
        readCards,
      });
      expect(
        readCards.mock.calls.map((c) =>
          new URL(c[0].url).searchParams.get('num'),
        ),
      ).toEqual(['0', '1']);
      expect(s.learning.cursor?.nextCardId).toBe('2');
      for (const i of s.learning.items) i.phase = 'done';
      await discoverNextChapter(s.learning, new AbortController().signal, {
        guard: vi.fn(),
        ensureTab: vi.fn(async () => 10),
        readCards,
      });
      expect(
        readCards.mock.calls.map((c) =>
          new URL(c[0].url).searchParams.get('num'),
        ),
      ).toEqual(['0', '1', '2']);
      expect(
        dispatch.mock.calls
          .filter((c) => c[1].op === 'learning-card-open')
          .map((c) => c[1].actionId),
      ).toEqual(['card1', 'card2']);
      expect(
        readCards.mock.calls.every(
          (call: any) => call[3] === false && call[4]?.url === call[0].url,
        ),
      ).toBe(true);
      expect(s.learning.items.map((i) => i.type)).toEqual(
        ['video', 'document', 'image'].filter((type) => types.includes(type)),
      );
      expect(s.learning.cursor?.chapter).toBe(1);
      expect(s.learning.discovered).toBe(false);
      expect(open).toHaveBeenCalledTimes(4);
    } finally {
      for (const m of [
        'store',
        'operations',
        'scan-control',
        'platform',
        'transport',
        'chapter-access',
      ])
        vi.doUnmock('../src/background/' + m);
    }
  },
);
