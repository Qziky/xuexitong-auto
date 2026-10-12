import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialState, type LearningItem } from '../src/domain';
import { platformBlockFor } from '../src/platform-access';
let s = initialState();
let api: typeof import('../src/background/learning');
let doneOnServer = false,
  delay = vi.fn(),
  dispatch = vi.fn(),
  discovery = vi.fn(),
  hold = vi.fn();
const base =
  'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?knowledgeid=300';
const item = (
  id: string,
  type: LearningItem['type'] = 'video',
): LearningItem => ({
  id,
  courseId: 'c',
  chapterId: '300',
  title: id,
  url: base,
  type,
  jobId: id,
  objectId: id,
  phase: 'waiting',
});
let chapterItems: LearningItem[];
let queueStart: ReturnType<typeof vi.fn>;
let foregroundTarget: ReturnType<typeof vi.fn>;
let reads: ReturnType<typeof vi.fn>,
  useLoadedPage: boolean,
  snapshotStale: boolean,
  documentId: string;
function confirmStartup(ref: any, command: any) {
  if (command.op === 'video-play' || command.op === 'reader-start') {
    queueMicrotask(
      () =>
        void api.resourceStartup(
          command.binding,
          { state: 'started' },
          ref.tabId,
          ref.frameId,
          ref.documentId,
        ),
    );
    return { accepted: true, lease: command.binding.lease };
  }
  return {};
}
function binding() {
  const q = s.learning;
  return {
    learningId: q.id,
    runId: q.runId!,
    accountId: q.accountId,
    itemId: q.items[q.index]!.id,
    lease: q.lease,
    documentId: q.documentId,
  };
}
beforeEach(async () => {
  vi.resetModules();
  doneOnServer = false;
  queueStart = vi.fn(async () => {
    s.queue.phase = 'running';
  });
  foregroundTarget = vi.fn(async () => {});
  useLoadedPage = snapshotStale = false;
  documentId = 'card-document';
  chapterItems = [item('v')];
  s = initialState();
  s.accountId = 'a';
  s.courses = [
    {
      id: 'c',
      title: 'course',
      accountId: 'a',
      state: 'active',
      url: 'https://mooc1.chaoxing.com/course',
    } as any,
  ];
  delay = vi.fn(async () => {});
  discovery = vi.fn(async (q: any) => {
    q.items.push(...chapterItems);
    q.discovered = true;
  });
  dispatch = vi.fn(async (ref, command) => {
    if (command.op === 'html') {
      if (snapshotStale) documentId = 'replacement-document';
      return {
        html: 'loaded-card',
        url: base,
        info: { url: base, loginRequired: false, accountId: 'a' },
      };
    }
    return confirmStartup(ref, command);
  });
  hold = vi.fn(async (block) => {
    s.platformBlock = block;
  });
  vi.doMock('../src/background/store', () => ({
    state: s,
    persist: vi.fn(async () => {}),
    log: vi.fn(),
  }));
  vi.doMock('../src/background/operations', () => ({
    beginOperation: () => 'run',
    updateOperation: vi.fn(),
    heartbeatOperation: vi.fn(),
    finishOperation: vi.fn(async () => {}),
    resumeOperation: vi.fn(),
  }));
  vi.doMock('../src/background/workflows', () => ({
    cancelWorkflowAndWait: vi.fn(async () => {}),
    manualRunning: () => false,
  }));
  vi.doMock('../src/background/scan-control', () => ({
    cancelScanAndWait: vi.fn(async () => {}),
    checkFrames: vi.fn(),
  }));
  vi.doMock('../src/background/platform', () => ({
    accessPlatform: vi.fn(async (action: () => unknown) => action()),
    assertPlatformReady: vi.fn(),
    holdPlatform: hold,
  }));
  vi.doMock('../src/background/learning-discovery', () => ({
    discoverNextChapter: discovery,
    revalidateLearningDirectory: vi.fn(async () => {}),
    sameLearningItem: (a: LearningItem, b: LearningItem) => a.id === b.id,
  }));
  const frames = () => [
    {
      tabId: 10,
      frameId: 4,
      documentId: useLoadedPage ? documentId : undefined,
      accountId: 'a',
      url: base,
      loginRequired: false,
      top: false,
      media: [
        {
          kind: s.learning.items[s.learning.index]?.type,
          objectId: s.learning.items[s.learning.index]?.objectId,
          targetId: 'native',
        },
      ],
      reader: { currentPage: 0, totalPages: 2, finished: false },
    },
  ];
  reads = vi.fn(async (job: any) =>
    job.op === 'fetch'
      ? { html: 'server-card', url: job.url }
      : chapterItems.map((i) => ({
          ...i,
          platformComplete:
            doneOnServer && (!useLoadedPage || job.html === 'server-card'),
          completionEvidence: doneOnServer
            ? { at: Date.now(), source: 'configuration' }
            : undefined,
        })),
  );
  vi.doMock('../src/background/transport', () => ({
    delay,
    frameChangeOrTimeout: delay,
    discoverFrames: vi.fn(async () => frames()),
    waitForFrames: vi.fn(async () => frames()),
    frameCall: (...args: any[]) => dispatch(...args),
    offscreen: reads,
  }));
  vi.doMock('../src/background/executor', () => ({
    startQueue: queueStart,
    resumeQueue: vi.fn(async () => {}),
    pauseQueue: vi.fn(async () => {}),
    awaitQueueIdle: vi.fn(async () => {}),
  }));
  vi.doMock('../src/background/learning-foreground', () => ({
    retainLearningForeground: foregroundTarget,
    releaseLearningForeground: vi.fn(),
  }));
  vi.stubGlobal('chrome', {
    webNavigation: { getAllFrames: vi.fn(async () => []) },
    tabs: {
      get: vi.fn(async () => ({
        id: 10,
        url: useLoadedPage ? base : undefined,
        status: 'complete',
      })),
      create: vi.fn(async () => ({ id: 10 })),
      update: vi.fn(async (id: number) => ({ id })),
      query: vi.fn(async () => [{ id: 10 }]),
    },
  });
  api = await import('../src/background/learning');
});
afterEach(async () => {
  await api?.pauseLearning(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of [
    'store',
    'operations',
    'workflows',
    'scan-control',
    'platform',
    'learning-discovery',
    'learning-foreground',
    'transport',
    'executor',
  ])
    vi.doUnmock('../src/background/' + name);
});
async function start() {
  api.startLearning(['c'], 'both', 'submit', 'preserve', [
    'video',
    'audio',
    'document',
    'image',
    'quiz',
  ]);
  await vi.waitFor(() =>
    expect(s.learning.items[s.learning.index]?.phase).toMatch(
      /playing|reading|executing/,
    ),
  );
}
it('verifies an owning completion marker before video end and drops duplicate or old-lease events', async () => {
  useLoadedPage = true;
  await start();
  const active = binding();
  doneOnServer = true;
  const evidence = {
    state: 'confirmed' as const,
    source: 'card-marker' as const,
    at: Date.now(),
  };
  expect(
    await api.completionObserved(active, evidence, 10, 4, documentId),
  ).toBe(true);
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(s.learning.items[0]).toMatchObject({
    phase: 'done',
    platformComplete: true,
  });
  expect(
    reads.mock.calls.filter((c) => c[0].op === 'fetch' && c[0].fresh),
  ).toHaveLength(1);
  expect(
    await api.completionObserved(active, evidence, 10, 4, documentId),
  ).toBe(false);
});
it('does not repeat three fresh checks for the same unconfirmed marker while playback continues', async () => {
  await start();
  const before = reads.mock.calls.filter(
    (c) => c[0].op === 'fetch' && c[0].fresh,
  ).length;
  const active = binding(),
    evidence = {
      state: 'confirmed' as const,
      source: 'card-marker' as const,
      at: Date.now(),
    };
  await api.completionObserved(active, evidence, 10, 4);
  await vi.waitFor(() =>
    expect(s.learning.items[0]?.thresholdChecked).toBe(true),
  );
  expect(s.learning.items[0]?.phase).toBe('playing');
  const count = reads.mock.calls.filter(
    (c) => c[0].op === 'fetch' && c[0].fresh,
  ).length;
  expect(count - before).toBe(3);
  await api.completionObserved(active, evidence, 10, 4);
  expect(
    reads.mock.calls.filter((c) => c[0].op === 'fetch' && c[0].fresh),
  ).toHaveLength(count);
});
it('an early marker respects the explicitly required reading time before verification', async () => {
  chapterItems = [item('doc', 'document')];
  chapterItems[0]!.completion = { seconds: 10 };
  await start();
  const active = binding();
  const before = reads.mock.calls.filter(
    (c) => c[0].op === 'fetch' && c[0].fresh,
  ).length;
  doneOnServer = true;
  await api.completionObserved(
    active,
    { state: 'confirmed', source: 'card-marker', at: Date.now() },
    10,
    4,
  );
  expect(
    reads.mock.calls.filter((c) => c[0].op === 'fetch' && c[0].fresh),
  ).toHaveLength(before);
  s.learning.items[0]!.resourceStartedAt = Date.now() - 11000;
  await api.readingEvent(
    active,
    { currentPage: 0, totalPages: 8, finished: false },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(s.learning.items[0]?.currentPage).toBe(0);
});
it('keeps reading after three server checks fail to confirm an early marker', async () => {
  chapterItems = [item('doc', 'document')];
  await start();
  const active = binding();
  await api.completionObserved(
    active,
    { state: 'conflict', source: 'card-marker', at: Date.now() },
    10,
    4,
  );
  await vi.waitFor(() =>
    expect(s.learning.items[0]?.note).toBe('平台尚未确认，继续阅读'),
  );
  expect(s.learning.items[0]?.phase).toBe('reading');
  expect(s.learning.items[0]?.platformComplete).not.toBe(true);
  expect(s.learning.lease).toBe(active.lease);
});
it('rejects unrelated, stale and malformed completion notices', async () => {
  useLoadedPage = true;
  await start();
  const active = binding(),
    evidence = {
      state: 'confirmed' as const,
      source: 'card-marker' as const,
      at: Date.now(),
    };
  for (const [event, tab, frame, doc] of [
    [evidence, 11, 4, documentId],
    [evidence, 10, 5, documentId],
    [evidence, 10, 4, 'old-document'],
    [{ ...evidence, source: 'directory' }, 10, 4, documentId],
    [{ ...evidence, state: 'unknown' }, 10, 4, documentId],
  ] as any[])
    expect(await api.completionObserved(active, event, tab, frame, doc)).toBe(
      false,
    );
  expect(reads.mock.calls.filter((c) => c[0].fresh)).toHaveLength(0);
});
it('starts the first discovered chapter before discovering later chapters', async () => {
  discovery.mockImplementation(async (q) => {
    if (!q.items.length) q.items.push(...chapterItems);
    else q.discovered = true;
  });
  await start();
  expect(discovery).toHaveBeenCalledOnce();
  expect(s.learning.discovered).toBe(false);
  doneOnServer = true;
  await api.videoEvent(
    binding(),
    { position: 60, duration: 60, paused: true, ended: true, readyState: 4 },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(discovery).toHaveBeenCalledTimes(2);
  expect(s.learning.items[0]!.platformComplete).toBe(true);
});
it('starts a loaded card once and performs zero redundant HTML fetches before native startup', async () => {
  useLoadedPage = true;
  await start();
  expect(chrome.tabs.create).toHaveBeenCalledWith({ url: base, active: true });
  expect(foregroundTarget).toHaveBeenCalledWith(s.learning.id, 10);
  expect(reads.mock.calls.filter((c) => c[0].op === 'fetch')).toHaveLength(0);
  expect(chrome.tabs.create).toHaveBeenCalledOnce();
  expect(chrome.tabs.update).not.toHaveBeenCalled();
  expect(dispatch.mock.calls.filter((c) => c[1].op === 'html')).toHaveLength(1);
});
it('clears the startup waiting note after actual playback advances', async () => {
  await start();
  s.learning.items[0]!.note = '等待播放器实际启动';
  await api.videoEvent(
    binding(),
    { position: 3, duration: 120, paused: false, ended: false, readyState: 4 },
    10,
    4,
  );
  expect(s.learning.items[0]!.note).toBeUndefined();
});
function completeParsedItems(...ids: string[]) {
  const read = reads.getMockImplementation()! as (job: any) => Promise<any>;
  reads.mockImplementation(async (job: any) => {
    const result = await read(job);
    if (job.op !== 'learning-cards') return result;
    return (result as LearningItem[]).map((parsed) =>
      ids.includes(parsed.id)
        ? {
            ...parsed,
            phase: 'done',
            platformComplete: true,
            completionEvidence: { at: Date.now(), source: 'configuration' },
          }
        : parsed,
    );
  });
}
it.each(['video', 'audio', 'document', 'image'] as const)(
  'advances past a %s already complete on the loaded card without waiting for a player event',
  async (type) => {
    useLoadedPage = true;
    chapterItems = [
      item('already-done', type),
      item('next-document', 'document'),
    ];
    completeParsedItems('already-done');
    await start();
    expect(s.learning.index).toBe(1);
    expect(s.learning.items[0]).toMatchObject({
      phase: 'done',
      platformComplete: true,
      completionEvidence: { source: 'configuration' },
    });
    expect(s.learning.items[1]!.phase).toBe('reading');
    const starts = dispatch.mock.calls.filter((c) =>
      ['video-play', 'reader-start'].includes(c[1].op),
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]![1].binding.itemId).toBe('next-document');
    expect(reads.mock.calls.filter((c) => c[0].op === 'fetch')).toHaveLength(0);
  },
);
it('finishes a queue consisting of already-completed resources without startup or completion events', async () => {
  useLoadedPage = true;
  chapterItems = [
    item('video'),
    item('document', 'document'),
    item('image', 'image'),
  ];
  completeParsedItems(...chapterItems.map((i) => i.id));
  api.startLearning(['c'], 'both', 'submit', 'preserve');
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(s.learning.index).toBe(3);
  expect(s.learning.items.every((i) => i.phase === 'done')).toBe(true);
  expect(
    dispatch.mock.calls.filter((c) =>
      ['video-play', 'reader-start'].includes(c[1].op),
    ),
  ).toHaveLength(0);
  expect(reads.mock.calls.filter((c) => c[0].op === 'fetch')).toHaveLength(0);
  const operations = await import('../src/background/operations');
  expect(operations.finishOperation).toHaveBeenCalledWith(
    'run',
    'done',
    expect.stringContaining('3 项平台确认完成'),
  );
});
it('advances after a stale snapshot falls back to a fresh completed task record exactly once', async () => {
  useLoadedPage = snapshotStale = true;
  chapterItems = [item('already-done'), item('next-document', 'document')];
  completeParsedItems('already-done');
  await start();
  expect(s.learning.index).toBe(1);
  expect(s.learning.items[1]!.phase).toBe('reading');
  expect(reads.mock.calls.filter((c) => c[0].op === 'fetch')).toHaveLength(1);
  expect(
    dispatch.mock.calls.filter((c) => c[1].op === 'video-play'),
  ).toHaveLength(0);
});
it('discovers the next chapter after an already-completed resource without an external wakeup', async () => {
  useLoadedPage = true;
  chapterItems = [item('already-done'), item('next-document', 'document')];
  completeParsedItems('already-done');
  discovery.mockImplementation(async (q) => {
    if (!q.items.length) q.items.push(chapterItems[0]!);
    else {
      q.items.push(chapterItems[1]!);
      q.discovered = true;
    }
  });
  await start();
  expect(discovery).toHaveBeenCalledTimes(2);
  expect(s.learning.index).toBe(1);
  expect(s.learning.items[1]!.phase).toBe('reading');
});
it('honors a pause between recording completion and starting the next resource', async () => {
  useLoadedPage = true;
  chapterItems = [item('already-done'), item('next-document', 'document')];
  completeParsedItems('already-done');
  let interrupted = false;
  const store = await import('../src/background/store');
  vi.mocked(store.persist).mockImplementation(async () => {
    if (!interrupted && s.learning.items[0]?.phase === 'done') {
      interrupted = true;
      api.interruptLearning('用户暂停学习');
    }
  });
  api.startLearning(['c'], 'both', 'submit', 'preserve');
  await vi.waitFor(() => expect(s.learning.phase).toBe('paused'));
  expect(s.learning.items[0]!.phase).toBe('done');
  expect(s.learning.items[1]!.phase).toBe('waiting');
  expect(s.learning.index).toBe(0);
  expect(
    dispatch.mock.calls.filter((c) =>
      ['video-play', 'reader-start'].includes(c[1].op),
    ),
  ).toHaveLength(0);
});
it('continues after fresh server confirmation when the last resource is already complete in its loaded page', async () => {
  useLoadedPage = true;
  chapterItems = [
    item('playing-video'),
    item('completed-document', 'document'),
  ];
  completeParsedItems('completed-document');
  await start();
  doneOnServer = true;
  const q = s.learning;
  const old = { ...binding(), documentId: q.documentId };
  await api.videoEvent(
    old,
    {
      position: 60,
      duration: 60,
      paused: true,
      ended: true,
      readyState: 4,
    },
    10,
    4,
    q.documentId,
  );
  await vi.waitFor(() => expect(q.phase).toBe('done'));
  expect(q.index).toBe(2);
  expect(q.items.every((i) => i.phase === 'done')).toBe(true);
  expect(
    dispatch.mock.calls.filter((c) => c[1].op === 'video-play'),
  ).toHaveLength(1);
  expect(
    dispatch.mock.calls.filter((c) => c[1].op === 'reader-start'),
  ).toHaveLength(0);
  expect(reads.mock.calls.filter((c) => c[0].op === 'fetch')).toHaveLength(1);
  expect(
    await api.videoEvent(
      old,
      {
        position: 61,
        duration: 62,
        paused: false,
        ended: false,
        readyState: 4,
      },
      10,
      4,
      q.documentId,
    ),
  ).toBe(false);
});
it('falls back exactly once when a loaded snapshot is replaced, without reopening the card', async () => {
  useLoadedPage = snapshotStale = true;
  await start();
  expect(reads.mock.calls.filter((c) => c[0].op === 'fetch')).toHaveLength(1);
  expect(reads.mock.calls.find((c) => c[0].op === 'fetch')![0].fresh).toBe(
    true,
  );
  expect(chrome.tabs.create).toHaveBeenCalledOnce();
  expect(chrome.tabs.update).not.toHaveBeenCalled();
});
it('server verification bypasses a loaded card and never marks an ended video complete without evidence', async () => {
  useLoadedPage = true;
  await start();
  const q = s.learning;
  await api.videoEvent(
    { ...binding(), documentId: q.documentId },
    { position: 60, duration: 60, paused: true, ended: true, readyState: 4 },
    10,
    4,
    q.documentId,
  );
  await vi.waitFor(() => expect(q.phase).toBe('done'));
  const fetches = reads.mock.calls.filter((c) => c[0].op === 'fetch');
  expect(fetches).toHaveLength(3);
  expect(fetches.every((c) => c[0].fresh)).toBe(true);
  expect(dispatch.mock.calls.filter((c) => c[1].op === 'html')).toHaveLength(1);
  expect(delay.mock.calls.filter((c) => c[0] === 5000)).toHaveLength(0);
  expect(q.items[0]!.platformComplete).not.toBe(true);
});
it('starts a resource inside its loaded chapter shell without navigating away from the authenticated parent', async () => {
  useLoadedPage = true;
  discovery.mockImplementation(async (q) => {
    q.tabId = 10;
    q.items.push(...chapterItems);
    q.discovered = true;
  });
  const { ownedTabs } = await import('../src/background/owned-tabs');
  ownedTabs.add(10);
  vi.mocked(chrome.tabs.get).mockResolvedValue({
    id: 10,
    status: 'complete',
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy',
  } as any);
  await start();
  expect(s.learning.items[0]?.phase).toBe('playing');
  expect(foregroundTarget).toHaveBeenCalledWith(s.learning.id, 10);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});
it('reuses a valid owned card for its next resource and reloads once after user resume', async () => {
  useLoadedPage = true;
  chapterItems = [item('first'), item('second')];
  await start();
  doneOnServer = true;
  const q = s.learning;
  await api.videoEvent(
    { ...binding(), documentId: q.documentId },
    { position: 60, duration: 60, paused: true, ended: true, readyState: 4 },
    10,
    4,
    q.documentId,
  );
  await vi.waitFor(() => {
    expect(q.index).toBe(1);
    expect(q.items[1]!.phase).toBe('playing');
  });
  expect(chrome.tabs.create).toHaveBeenCalledOnce();
  expect(chrome.tabs.update).not.toHaveBeenCalled();
  expect(reads.mock.calls.filter((c) => c[0].op === 'fetch')).toHaveLength(1);
  await api.pauseLearning();
  api.resumeLearning();
  await vi.waitFor(() => expect(q.items[1]!.phase).toBe('playing'));
  const { revalidateLearningDirectory } =
    await import('../src/background/learning-discovery');
  expect(revalidateLearningDirectory).toHaveBeenCalledOnce();
  expect(chrome.tabs.update).toHaveBeenCalledOnce();
});
it('waits for the new top document after navigation, excluding the still responding old directory', async () => {
  useLoadedPage = true;
  await start();
  await api.pauseLearning();
  vi.mocked(chrome.webNavigation.getAllFrames).mockImplementation(
    async () => [{ frameId: 0, documentId: 'old-directory' }] as any,
  );
  const transport = await import('../src/background/transport');
  const tested = vi.fn();
  vi.mocked(transport.waitForFrames).mockImplementation(
    async (_tab, predicate) => {
      const old = {
        tabId: 10,
        frameId: 0,
        top: true,
        documentId: 'old-directory',
        url: base,
        loginRequired: false,
      };
      const fresh = { ...old, documentId: 'new-directory' };
      if (!tested.mock.calls.length) {
        expect(predicate(fresh)).toBe(true);
        tested();
        expect(predicate(old)).toBe(false);
        expect(
          predicate({ ...fresh, url: 'https://mooc1.chaoxing.com/other' }),
        ).toBe(false);
        expect(predicate({ ...fresh, top: false })).toBe(false);
        return [fresh];
      }
      return await transport.discoverFrames(10);
    },
  );
  api.resumeLearning();
  await vi.waitFor(() => expect(s.learning.items[0]!.phase).toBe('playing'));
  expect(tested).toHaveBeenCalledOnce();
  expect(chrome.tabs.update).toHaveBeenCalledOnce();
});
it('ended media without server confirmation is reviewed after three reads, never marked complete', async () => {
  await start();
  await api.videoEvent(
    binding(),
    { position: 60, duration: 60, paused: true, ended: true, readyState: 4 },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(s.learning.items[0]!.phase).toBe('review');
  expect(s.learning.items[0]!.platformComplete).not.toBe(true);
  expect(delay.mock.calls.filter((c) => c[0] === 5000)).toHaveLength(0);
  expect(
    reads.mock.calls.filter((c) => c[0].op === 'fetch' && c[0].fresh),
  ).toHaveLength(4);
});
it('ordinary failures recover at most twice and do not block the next item', async () => {
  chapterItems = [item('bad'), item('good')];
  dispatch.mockImplementation(async (ref, command) => {
    if (command.op === 'video-play' && command.binding.itemId === 'bad')
      throw Object.assign(new Error('network'), { code: 'media-network' });
    return confirmStartup(ref, command);
  });
  await start();
  expect(s.learning.items[0]).toMatchObject({ phase: 'failed', attempts: 3 });
  expect(s.learning.index).toBe(1);
  expect(s.learning.items[1]!.phase).toBe('playing');
  expect(
    dispatch.mock.calls.filter(
      (c) =>
        ['video-play', 'video-recover'].includes(c[1]?.op) &&
        c[1].binding.itemId === 'bad',
    ),
  ).toHaveLength(3);
});
it('recovers an active player in place first, reloads once next, and rejects the old lease', async () => {
  chapterItems = [item('bad'), item('good')];
  dispatch.mockImplementation(async (ref, command) => {
    if (command.op === 'video-recover') {
      queueMicrotask(
        () =>
          void api.resourceStartup(
            command.binding,
            { state: 'started' },
            ref.tabId,
            ref.frameId,
            ref.documentId,
          ),
      );
      return { accepted: true, lease: command.binding.lease };
    }
    return confirmStartup(ref, command);
  });
  await start();
  const old = { ...binding() };
  await api.videoEvent(
    old,
    { position: 1, duration: 60, paused: true, ended: false, readyState: 4 },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.items[0]?.attempts).toBe(1));
  await vi.waitFor(() =>
    expect(s.learning.items[0]?.note).toMatch(/原地恢复成功/),
  );
  expect(
    dispatch.mock.calls.filter((c) => c[1].op === 'video-recover'),
  ).toHaveLength(1);
  expect(
    dispatch.mock.calls.filter((c) => c[1].op === 'video-play'),
  ).toHaveLength(1);
  expect(
    await api.videoEvent(
      old,
      { position: 30, paused: false, ended: false, readyState: 4 },
      10,
      4,
    ),
  ).toBe(false);
  await api.videoEvent(
    binding(),
    { position: 2, paused: true, ended: false, readyState: 4 },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.items[0]?.attempts).toBe(2));
  await vi.waitFor(() => expect(s.learning.items[0]?.phase).toBe('playing'));
  expect(
    dispatch.mock.calls.filter((c) => c[1].op === 'video-play').at(-1)?.[1]
      .requireProgress,
  ).toBe(true);
  await api.videoEvent(
    binding(),
    { position: 3, paused: true, ended: false, readyState: 4 },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.index).toBe(1));
  expect(s.learning.items[0]?.phase).toBe('review');
  expect(
    dispatch.mock.calls.filter((c) => c[1].op === 'video-recover'),
  ).toHaveLength(1);
});
it('a rebuilt reader invalidates the old lease and verifies the server before replaying', async () => {
  chapterItems = [item('d', 'document')];
  await start();
  const old = binding();
  s.learning.documentId = 'old-reader';
  const before = reads.mock.calls.filter(
    (c) => c[0].op === 'fetch' && c[0].fresh,
  ).length;
  doneOnServer = true;
  api.observeLearningReader({
    tabId: 10,
    frameId: 9,
    documentId: 'new-reader',
    url: 'https://pan-yz.chaoxing.com/screen/v2/file_d',
    top: false,
    loginRequired: false,
    accountId: 'a',
    learningIdentity: { jobId: 'd', objectId: 'd' },
    reader: { currentPage: 0, totalPages: 1, finished: false },
  });
  expect(s.learning.lease).toBeUndefined();
  expect(
    await api.readingEvent(
      old,
      { currentPage: 1, totalPages: 1, finished: true },
      10,
      4,
      'old-reader',
    ),
  ).toBe(false);
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(s.learning.items[0]).toMatchObject({
    phase: 'done',
    platformComplete: true,
  });
  expect(
    dispatch.mock.calls.filter((c) => c[1].op === 'reader-start'),
  ).toHaveLength(1);
  expect(
    reads.mock.calls.filter((c) => c[0].op === 'fetch' && c[0].fresh),
  ).toHaveLength(before + 1);
});
it('sibling, stale and foreign reader frames cannot interrupt the current reader', async () => {
  chapterItems = [item('d', 'document')];
  await start();
  s.learning.documentId = 'current-reader';
  const lease = s.learning.lease;
  const ref = {
    tabId: 10,
    frameId: 4,
    documentId: 'new-reader',
    url: base,
    top: false,
    loginRequired: false,
    learningIdentity: { jobId: 'd', objectId: 'd' },
    reader: { currentPage: 0, totalPages: 1, finished: false },
  };
  for (const change of [
    { documentId: 'current-reader' },
    { tabId: 11 },
    { accountId: 'other' },
    { verificationRequired: true },
    { learningIdentity: { jobId: 'other', objectId: 'd' } },
    { learningIdentity: { jobId: 'd', objectId: 'other' } },
  ]) {
    api.observeLearningReader({ ...ref, ...change });
    expect(s.learning.lease).toBe(lease);
    expect(s.learning.items[0]?.errorCode).toBeUndefined();
  }
});
it('reader communication failure verifies completion and continues without restarting completed content', async () => {
  chapterItems = [item('d', 'document'), item('next', 'document')];
  await start();
  doneOnServer = true;
  await api.readingEvent(
    binding(),
    {
      currentPage: 0,
      totalPages: 1,
      finished: false,
      errorCode: 'reader-communication-timeout',
      waiting: 'lost response',
    },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(s.learning.items[0]).toMatchObject({
    phase: 'done',
    platformComplete: true,
  });
  expect(s.learning.items[0]?.attempts).toBeUndefined();
  expect(
    dispatch.mock.calls.filter((c) => c[1].op === 'reader-start'),
  ).toHaveLength(1);
});
it('an unconfirmed reader with lost replies recovers twice then continues to the next task', async () => {
  chapterItems = [item('bad', 'document'), item('good', 'document')];
  await start();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const old = binding();
    await api.readingEvent(
      old,
      {
        currentPage: 0,
        totalPages: 1,
        finished: false,
        errorCode: 'reader-communication-timeout',
        waiting: 'lost response',
      },
      10,
      4,
    );
    if (attempt < 3) {
      await vi.waitFor(() =>
        expect(s.learning.items[0]).toMatchObject({
          attempts: attempt,
          phase: 'reading',
        }),
      );
      expect(
        await api.readingEvent(
          old,
          { currentPage: 1, totalPages: 1, finished: true },
          10,
          4,
        ),
      ).toBe(false);
    }
  }
  await vi.waitFor(() => expect(s.learning.index).toBe(1));
  expect(s.learning.items[0]).toMatchObject({ phase: 'review', attempts: 3 });
  expect(s.learning.items[0]?.platformComplete).not.toBe(true);
  expect(s.learning.items[1]?.phase).toBe('reading');
  expect(
    dispatch.mock.calls.filter(
      (c) => c[1].op === 'reader-start' && c[1].binding.itemId === 'bad',
    ),
  ).toHaveLength(3);
});
it('structured reader error drives recovery; waiting text alone never does', async () => {
  chapterItems = [item('d', 'document')];
  await start();
  await api.readingEvent(
    binding(),
    {
      mode: 'scroll',
      currentPage: 0,
      scrollPosition: 100,
      scrollExtent: 400,
      finished: false,
      waiting: '等待加载，尚未失败',
    },
    10,
    4,
  );
  expect(s.learning.items[0]?.errorCode).toBeUndefined();
  expect(s.learning.items[0]?.scrollPosition).toBe(100);
  await api.readingEvent(
    binding(),
    {
      currentPage: 0,
      totalPages: 2,
      finished: false,
      errorCode: 'reader-page-timeout',
      waiting: '翻页无效',
    },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.items[0]?.attempts).toBe(1));
});
it('captcha stops the entire queue immediately without advancing to the next task', async () => {
  chapterItems = [item('bad'), item('good')];
  const block = platformBlockFor(
    'https://mooc1.chaoxing.com/antispiderShowVerify.ac',
  );
  const { PlatformAccessError } = await import('../src/platform-access');
  dispatch.mockImplementation(async (_ref, command) => {
    if (command.op === 'video-play') throw new PlatformAccessError(block);
    return {};
  });
  api.startLearning(['c'], 'video', 'draft', 'preserve');
  await vi.waitFor(() => expect(s.learning.phase).toBe('paused'));
  expect(hold).toHaveBeenCalledWith(block);
  expect(s.learning.index).toBe(0);
  expect(
    dispatch.mock.calls.filter((c) => c[1]?.op === 'video-play'),
  ).toHaveLength(1);
});
it('reader completion is server-verified and cancellation rejects late reports', async () => {
  chapterItems = [item('doc', 'document')];
  await start();
  const b = binding();
  doneOnServer = true;
  await api.readingEvent(
    b,
    { currentPage: 2, totalPages: 2, finished: true },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(s.learning.items[0]!.phase).toBe('done');
  expect(
    await api.readingEvent(
      b,
      { currentPage: 1, totalPages: 2, finished: false },
      10,
      4,
    ),
  ).toBe(false);
  expect(s.learning.items[0]!.currentPage).toBe(2);
});
it('a video question saved as draft does not count as a completed task point', async () => {
  chapterItems = [
    {
      ...item('quiz', 'quiz'),
      task: {
        id: 'q',
        accountId: 'a',
        courseId: 'c',
        platformId: '900',
        type: 'quiz',
        status: 'pending',
        title: 'q',
        url: base,
        source: { url: base, at: 1, label: 'test' },
      },
    },
  ];
  await start();
  s.queue.phase = 'done';
  s.queue.items = [
    { taskId: 'q', stage: 'draft-saved', note: '草稿已保存' } as any,
  ];
  api.continueLearning();
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(s.learning.items[0]!.phase).toBe('draft');
  expect(s.learning.items[0]!.platformComplete).not.toBe(true);
});
it('a threshold triggers checking; delayed platform confirmation succeeds without another play', async () => {
  chapterItems[0]!.completion = { ratio: 0.5 };
  await start();
  let verificationReads = 0;
  const read = reads.getMockImplementation()! as (job: any) => Promise<unknown>;
  reads.mockImplementation(async (job: any) => {
    if (job.op === 'fetch' && job.fresh && ++verificationReads === 2)
      doneOnServer = true;
    return read(job);
  });
  await api.videoEvent(
    binding(),
    { position: 30, duration: 60, paused: false, ended: false, readyState: 4 },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(s.learning.items[0]!.phase).toBe('done');
  expect(verificationReads).toBe(2);
  expect(
    dispatch.mock.calls.filter((c) => c[1]?.op === 'video-play'),
  ).toHaveLength(1);
});
it('starts playback in the foreground without temporarily returning to the original tab', async () => {
  let active = 1,
    attempts = 0;
  vi.mocked(chrome.tabs.query).mockImplementation(
    async () => [{ id: active }] as any,
  );
  vi.mocked(chrome.tabs.update).mockImplementation(
    async (id: any, options: any) => {
      if (options.active) active = id;
      return { id } as any;
    },
  );
  vi.mocked(chrome.tabs.create).mockImplementation(async () => {
    active = 10;
    return { id: 10 } as any;
  });
  dispatch.mockImplementation(async (ref, cmd) => {
    if (cmd.op === 'video-play') {
      expect(api.authorizeVideo(cmd.binding, 10, 4)).toBe(true);
      attempts++;
    }
    return confirmStartup(ref, cmd);
  });
  await start();
  expect(attempts).toBe(1);
  expect(active).toBe(10);
});
it('standard playback question drafts block that item without claiming its task point', async () => {
  await start();
  api.observeLearningQuestion({
    tabId: 10,
    frameId: 9,
    url: 'https://mooc1.chaoxing.com/work/doWork?workId=900',
    top: false,
    loginRequired: false,
    adapter: 'quiz',
    taskKind: 'quiz',
    taskKey: 'course:100:work:900',
    taskSummary: { title: 'quiz', questionCount: 1, status: 'pending' },
  } as any);
  await vi.waitFor(() => expect(s.learning.items[0]!.phase).toBe('executing'));
  const taskId = s.learning.items[0]!.embeddedTaskId!;
  expect(queueStart).toHaveBeenCalledWith(
    [taskId],
    s.learning.policy,
    s.learning.goal,
    undefined,
    { tabId: 10 },
    s.learning.id,
  );
  expect(s.tasks.find((t) => t.id === taskId)).toMatchObject({
    type: 'quiz',
    listed: false,
    discovery: 'opened',
  });
  s.queue.phase = 'done';
  s.queue.items = [{ taskId, stage: 'draft-saved' } as any];
  api.continueLearning();
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(s.learning.items[0]!.phase).toBe('review');
  expect(s.learning.items[0]!.platformComplete).not.toBe(true);
});
it('links chapter quiz work to the owning foreground learning queue', async () => {
  const quiz = {
    ...item('chapter-quiz', 'quiz'),
    task: {
      id: 'quiz-task',
      accountId: 'a',
      courseId: 'c',
      platformId: '900',
      type: 'quiz' as const,
      status: 'pending' as const,
      title: 'Chapter quiz',
      url: base,
      source: { url: base, at: 1, label: 'test' },
    },
  };
  chapterItems = [quiz];
  api.startLearning(['c'], 'both', 'submit', 'preserve');
  await vi.waitFor(() => expect(queueStart).toHaveBeenCalledOnce());
  expect(queueStart).toHaveBeenCalledWith(
    ['quiz-task'],
    s.learning.policy,
    s.learning.goal,
    undefined,
    undefined,
    s.learning.id,
  );
});
it('an expired lease cannot send events into a resumed verification phase', async () => {
  await start();
  const old = binding();
  s.learning.lease = undefined;
  s.learning.items[0]!.phase = 'verifying';
  expect(api.authorizeVideo(old, 10, 4)).toBe(false);
  expect(
    await api.videoEvent(
      old,
      { position: 55, paused: false, ended: false, readyState: 4 },
      10,
      4,
    ),
  ).toBe(false);
});
it('a startup receipt alone never claims that native playback has started', async () => {
  dispatch.mockImplementation(async (_ref, cmd) =>
    cmd.deferred ? { accepted: true, lease: cmd.binding.lease } : {},
  );
  delay.mockImplementation(
    async () => new Promise((resolve) => setTimeout(resolve, 1)),
  );
  api.startLearning(['c'], 'video', 'draft', 'preserve');
  await vi.waitFor(() =>
    expect(dispatch.mock.calls.some((c) => c[1]?.op === 'video-play')).toBe(
      true,
    ),
  );
  expect(s.learning.items[0]!.phase).toBe('preparing');
  const b = binding();
  expect(await api.resourceStartup(b, { state: 'started' }, 10, 4)).toBe(true);
  await vi.waitFor(() => expect(s.learning.items[0]!.phase).toBe('playing'));
  expect(
    dispatch.mock.calls.filter((c) => c[1]?.op === 'video-play'),
  ).toHaveLength(1);
});
it('a lost receipt is resolved by a bound actual startup event without replaying', async () => {
  dispatch.mockImplementation(async (ref, cmd) => {
    if (cmd.op === 'video-play') {
      confirmStartup(ref, cmd);
      throw Object.assign(new Error('message channel closed'), {
        code: 'frame-disconnected',
      });
    }
    return {};
  });
  await start();
  expect(
    dispatch.mock.calls.filter((c) => c[1]?.op === 'video-play'),
  ).toHaveLength(1);
});
it('actual media state can confirm startup when its separate ready notice is lost', async () => {
  dispatch.mockImplementation(async (_ref, cmd) =>
    cmd.deferred ? { accepted: true, lease: cmd.binding.lease } : {},
  );
  delay.mockImplementation(
    async () => new Promise((resolve) => setTimeout(resolve, 1)),
  );
  api.startLearning(['c'], 'video', 'draft', 'preserve');
  await vi.waitFor(() => expect(s.learning.lease).toBeTruthy());
  expect(s.learning.items[0]!.phase).toBe('preparing');
  await api.videoEvent(
    binding(),
    { position: 0.2, paused: false, ended: false, readyState: 4 },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.items[0]!.phase).toBe('playing'));
  expect(
    dispatch.mock.calls.filter((c) => c[1]?.op === 'video-play'),
  ).toHaveLength(1);
});
it('real reader state confirms initialization and retains its loading reason', async () => {
  chapterItems = [item('doc', 'document')];
  dispatch.mockImplementation(async (_ref, cmd) =>
    cmd.deferred ? { accepted: true, lease: cmd.binding.lease } : {},
  );
  delay.mockImplementation(
    async () => new Promise((resolve) => setTimeout(resolve, 1)),
  );
  api.startLearning(['c'], 'both', 'draft', 'preserve', ['document']);
  await vi.waitFor(() => expect(s.learning.lease).toBeTruthy());
  await api.readingEvent(
    binding(),
    {
      currentPage: 0,
      totalPages: 21,
      finished: false,
      waiting: '等待页面图片加载',
    },
    10,
    4,
  );
  await vi.waitFor(() => expect(s.learning.items[0]!.phase).toBe('reading'));
  expect(s.learning.items[0]).toMatchObject({
    totalPages: 21,
    currentPage: 0,
    note: '等待页面图片加载',
  });
});
it('late startup after cancellation is discarded without resuming the resource', async () => {
  dispatch.mockImplementation(async (_ref, cmd) =>
    cmd.deferred ? { accepted: true, lease: cmd.binding.lease } : {},
  );
  delay.mockImplementation(
    async () => new Promise((resolve) => setTimeout(resolve, 1)),
  );
  api.startLearning(['c'], 'video', 'draft', 'preserve');
  await vi.waitFor(() => expect(s.learning.lease).toBeTruthy());
  const old = binding();
  await api.pauseLearning(true);
  expect(await api.resourceStartup(old, { state: 'started' }, 10, 4)).toBe(
    false,
  );
  expect(s.learning.phase).toBe('stopped');
});
it('keeps the learning page active after an asynchronous autoplay failure', async () => {
  let active = 1;
  const leases: string[] = [];
  vi.mocked(chrome.tabs.create).mockImplementation(async () => {
    active = 10;
    return { id: 10 } as any;
  });
  vi.mocked(chrome.tabs.query).mockImplementation(
    async () => [{ id: active }] as any,
  );
  dispatch.mockImplementation(async (ref, cmd) => {
    if (cmd.op === 'video-play') {
      leases.push(cmd.binding.lease);
      queueMicrotask(
        () =>
          void api.resourceStartup(
            cmd.binding,
            {
              state: 'failed',
              errorCode: 'autoplay-blocked',
              error: 'autoplay',
            },
            10,
            4,
          ),
      );
      return { accepted: true, lease: cmd.binding.lease };
    }
    return confirmStartup(ref, cmd);
  });
  api.startLearning(['c'], 'both', 'submit', 'preserve');
  await vi.waitFor(() => expect(s.learning.phase).toBe('done'));
  expect(leases).toHaveLength(1);
  expect(active).toBe(10);
  expect(s.learning.items[0]).toMatchObject({
    phase: 'review',
    errorCode: 'autoplay-blocked',
  });
});
it('a new document reusing the frame ID cannot send progress with an old binding', async () => {
  await start();
  s.learning.documentId = 'current';
  const b = { ...binding(), documentId: 'current' };
  expect(
    await api.videoEvent(
      b,
      { position: 1, paused: false, ended: false, readyState: 4 },
      10,
      4,
      'old',
    ),
  ).toBe(false);
  expect(
    await api.videoEvent(
      b,
      { position: 2, paused: false, ended: false, readyState: 4 },
      10,
      4,
      'current',
    ),
  ).toBe(true);
});
it('accepted but never started resources time out, recover twice, and continue', async () => {
  vi.useFakeTimers();
  dispatch.mockImplementation(async (_ref, cmd) =>
    cmd.deferred ? { accepted: true, lease: cmd.binding.lease } : {},
  );
  delay.mockImplementation(
    async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  );
  api.startLearning(['c'], 'video', 'draft', 'preserve');
  await vi.advanceTimersByTimeAsync(95000);
  expect(s.learning.phase).toBe('done');
  expect(s.learning.items[0]).toMatchObject({
    phase: 'review',
    errorCode: 'startup-timeout',
    attempts: 3,
  });
  expect(
    dispatch.mock.calls.filter((c) =>
      ['video-play', 'video-recover'].includes(c[1]?.op),
    ),
  ).toHaveLength(3);
});

it('identity recovery waits for the failed runner to finish pausing its old resource', async () => {
  useLoadedPage = true;
  await start();
  let releasePause!: () => void;
  const originalDispatch = dispatch.getMockImplementation()!;
  dispatch.mockImplementation(async (ref, command) => {
    if (command.op === 'video-pause')
      return new Promise<void>((resolve) => {
        releasePause = resolve;
      });
    return originalDispatch(ref, command);
  });
  reads.mockRejectedValue(
    new Error('当前页面尚未提供账号信息，请保持已登录的个人中心打开后继续'),
  );
  await api.videoEvent(
    binding(),
    { position: 60, duration: 60, paused: true, ended: true, readyState: 4 },
    10,
    4,
    documentId,
  );
  await vi.waitFor(() => expect(releasePause).toBeTypeOf('function'));
  expect(s.learning.phase).toBe('paused');
  const idle = vi.fn();
  const pending = api.awaitLearningIdle().then(idle);
  await Promise.resolve();
  expect(idle).not.toHaveBeenCalled();
  dispatch.mockImplementation(originalDispatch);
  releasePause();
  await pending;
  expect(idle).toHaveBeenCalledOnce();
});
