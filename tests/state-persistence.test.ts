import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function isolatedStore() {
  vi.resetModules();
  vi.useFakeTimers();
  const local = vi.fn(async (_value: unknown) => {});
  const session = vi.fn(async (_value: unknown) => {});
  const notify = vi.fn(async (_value: unknown) => {});
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: notify },
    storage: { local: { set: local }, session: { set: session } },
  });
  return {
    store: await import('../src/background/store'),
    local,
    session,
    notify,
  };
}
it('coalesces ordinary updates within one second while critical checkpoints persist immediately', async () => {
  const { store, local, session, notify } = await isolatedStore();
  for (let n = 0; n < 20; n++) {
    store.state.scan.note = String(n);
    await store.persist();
    await vi.advanceTimersByTimeAsync(45);
  }
  expect(local).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(local).toHaveBeenCalledTimes(1);
  expect(session).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls.length).toBeLessThan(20);
  store.state.queue.phase = 'paused';
  await store.persist(true);
  expect(local).toHaveBeenCalledTimes(2);
  expect((local.mock.calls[1]![0] as any).app.queue.phase).toBe('paused');
});
it('saves reading pace without changing OCR settings, candidate revisions, or the active snapshot', async () => {
  const { store, local } = await isolatedStore();
  const recognition = structuredClone(store.state.recognition);
  store.state.learning.items = [
    { id: 'doc', readingSettings: { readingIntervalMs: 1000 } },
  ] as any;
  await store.saveLearningSettings({ readingIntervalMs: 250 });
  expect(store.state.learningSettings.readingIntervalMs).toBe(250);
  expect(store.state.recognition).toEqual(recognition);
  expect(store.state.answerRevision).toBe(0);
  expect(
    store.state.learning.items[0]?.readingSettings?.readingIntervalMs,
  ).toBe(1000);
  expect(local).toHaveBeenCalled();
  await expect(
    store.saveLearningSettings({ readingIntervalMs: 200 }),
  ).rejects.toThrow(/250/);
  expect(store.state.learningSettings.readingIntervalMs).toBe(250);
});
it('a queued critical snapshot stores its original page binding instead of a later page', async () => {
  const { store, local, session } = await isolatedStore();
  let release!: () => void;
  local.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  store.state.currentPage = {
    kind: 'home',
    tabId: 1,
    url: 'https://i.chaoxing.com/base',
  };
  const pending = store.persist(true);
  await Promise.resolve();
  await Promise.resolve();
  store.state.currentPage = {
    kind: 'questions',
    tabId: 2,
    workspaceId: 'new-page',
    url: 'https://mooc1.chaoxing.com/work/2',
  };
  release();
  await pending;
  expect((session.mock.calls[0]![0] as any).currentPage).toEqual({
    kind: 'home',
    tabId: 1,
    url: 'https://i.chaoxing.com/base',
  });
});
