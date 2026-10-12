import { afterEach, expect, it, vi } from 'vitest';
import {
  ReadingAdapter,
  describeReader,
  type ReaderDescription,
} from '../src/learning-adapters';
import { readerContentReady, readerView } from '../src/reader-view';
import {
  learningSettingsDefaults,
  validateLearningSettings,
  readingIntervalFromSeconds,
} from '../src/learning-settings';
import { migrateState } from '../src/state-migration';
import { initialState } from '../src/domain';
const binding = {
  learningId: 'l',
  runId: 'r',
  itemId: 'i',
  accountId: 'cx:1',
  lease: 'lease',
};
it('bounds a lost progress reply and ignores its late result instead of losing heartbeats for 60 seconds', async () => {
  vi.useFakeTimers();
  const { page } = scrollDoc();
  let late!: (accepted: boolean) => void;
  const send = vi.fn(async (_b: unknown, _s: ReaderDescription) => true);
  send.mockImplementationOnce(() => new Promise((r) => (late = r)));
  const reader = new ReadingAdapter(page, async () => true, send);
  const start = reader.start(binding);
  await vi.advanceTimersByTimeAsync(3000);
  await start;
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
    errorCode: 'reader-communication-timeout',
    finished: false,
  });
  const count = send.mock.calls.length;
  late(true);
  await vi.advanceTimersByTimeAsync(7000);
  expect(send).toHaveBeenCalledTimes(count);
  expect(reader.readCompletion()).toBe(false);
});
it('bounds a lost authorization reply without further reading or waiting 60 seconds', async () => {
  vi.useFakeTimers();
  const { page, root } = scrollDoc();
  let calls = 0;
  const authorize = vi.fn(() =>
    ++calls <= 2 ? Promise.resolve(true) : new Promise<boolean>(() => {}),
  );
  const send = vi.fn(async (_b: unknown, _s: ReaderDescription) => true);
  const reader = new ReadingAdapter(page, authorize, send);
  await reader.start(binding);
  await vi.advanceTimersByTimeAsync(3500);
  expect(send.mock.calls.at(-1)?.[1].errorCode).toBe(
    'reader-communication-timeout',
  );
  const offset = root.scrollTop;
  await vi.advanceTimersByTimeAsync(7000);
  expect(root.scrollTop).toBe(offset);
  expect(authorize).toHaveBeenCalledTimes(3);
});
it('cancellation interrupts a pending reader message immediately and does not send late progress', async () => {
  vi.useFakeTimers();
  const { page } = scrollDoc();
  let resolve!: (value: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
  const reader = new ReadingAdapter(page, async () => true, send);
  const start = reader.start(binding);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledOnce();
  reader.pause();
  await start;
  resolve(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(send).toHaveBeenCalledOnce();
});
it('scrolls a long single DOCX page in its own viewport while the outer window stays still', async () => {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<div style="overflow-y:auto"><li id="anchor1">one long page</li></div>';
  const viewport = document.querySelector<HTMLElement>('div')!,
    page = document.querySelector<HTMLElement>('li')!;
  Object.defineProperties(viewport, {
    clientHeight: { value: 400 },
    scrollHeight: { value: 1400 },
  });
  viewport.getBoundingClientRect = () =>
    ({ top: 100, bottom: 500, height: 400 }) as DOMRect;
  page.getBoundingClientRect = () =>
    ({
      top: 100 - viewport.scrollTop,
      bottom: 1500 - viewport.scrollTop,
      height: 1400,
    }) as DOMRect;
  page.scrollIntoView = vi.fn(
    (options: any) => (viewport.scrollTop = options.block === 'end' ? 1000 : 0),
  );
  const outer = vi.spyOn(window, 'scrollBy').mockImplementation(() => {
    throw new Error('wrong scroll target');
  });
  const send = vi.fn(async (_b: unknown, _d: ReaderDescription) => true);
  const reader = new ReadingAdapter(document, async () => true, send);
  await reader.start(binding);
  await vi.advanceTimersByTimeAsync(7500);
  expect(outer).not.toHaveBeenCalled();
  expect(viewport.scrollTop).toBe(1000);
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
    currentPage: 1,
    totalPages: 1,
    finished: true,
  });
  expect(
    send.mock.calls.some(([, state]) => (state.scrollPosition ?? 0) > 0),
  ).toBe(true);
  reader.pause();
  outer.mockRestore();
  document.body.innerHTML = '';
});
it('a sole reader with a different explicit task id cannot be taken over', () => {
  const page = doc(
    '<div class="ans-attach-ct"><iframe data-jobid="other"></iframe><li id="anchor1">content</li></div>',
  );
  expect(readerView(page, { ...binding, jobId: 'selected' })).toBeUndefined();
  expect(readerView(page, { ...binding, jobId: 'other' })?.mode).toBe('pages');
});
function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}
it('reads the lower part of the last page and reaches the native document bottom before finishing', async () => {
  vi.useFakeTimers();
  const page = document;
  page.body.innerHTML = '<li id="anchor1">long last page</li>';
  const row = page.querySelector<HTMLElement>('li')!;
  let offset = 0;
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => offset);
  vi.spyOn(window, 'scrollBy').mockImplementation((arg: any) => {
    offset += arg.top;
  });
  const entered = vi.fn((arg: any) => {
    if (arg.block === 'end') offset = 1200;
  });
  row.scrollIntoView = entered;
  row.getBoundingClientRect = () =>
    ({ top: -offset, bottom: 1800 - offset, height: 1800 }) as DOMRect;
  const send = vi.fn(async () => true);
  const reader = new ReadingAdapter(page, async () => true, send);
  await reader.start(binding);
  expect(offset).toBe(600);
  expect(reader.readCompletion()).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(entered).toHaveBeenCalledWith({ block: 'end', behavior: 'instant' });
  expect(reader.readCompletion()).toBe(true);
  reader.pause();
  vi.restoreAllMocks();
  page.body.innerHTML = '';
});
it('a page scroll that never moves fails instead of resetting the timeout forever', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<li id="anchor1">long page</li>';
  const row = document.querySelector<HTMLElement>('li')!;
  row.scrollIntoView = vi.fn();
  row.getBoundingClientRect = () =>
    ({ top: 0, bottom: 1800, height: 1800 }) as DOMRect;
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(0);
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  const send = vi.fn(async (_b: unknown, _d: ReaderDescription) => true);
  const reader = new ReadingAdapter(document, async () => true, send);
  await reader.start(binding);
  await vi.advanceTimersByTimeAsync(31000);
  expect(send.mock.calls.at(-1)?.[1].errorCode).toBe('reader-scroll-timeout');
  expect(reader.readCompletion()).toBe(false);
  reader.pause();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
});
it('enters a page to activate lazy images before waiting and never counts it until loaded', async () => {
  vi.useFakeTimers();
  const page = doc('<li id="anchor1"><img loading="lazy"></li>');
  const row = page.querySelector<HTMLElement>('li')!,
    image = page.querySelector('img')!;
  let loaded = false;
  Object.defineProperties(image, {
    complete: { get: () => loaded },
    naturalWidth: { get: () => (loaded ? 1024 : 0) },
  });
  row.scrollIntoView = vi.fn(() => {
    setTimeout(() => {
      loaded = true;
    }, 50);
  });
  const send = vi.fn(async (_b: unknown, _s: ReaderDescription) => true);
  const reader = new ReadingAdapter(page, async () => true, send);
  await reader.start(binding);
  expect(row.scrollIntoView).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[1].currentPage).toBe(0);
  expect(reader.readCompletion()).toBe(false);
  await vi.advanceTimersByTimeAsync(250);
  expect(reader.readCompletion()).toBe(true);
  expect(row.scrollIntoView).toHaveBeenCalledOnce();
  expect(send.mock.calls.at(-1)?.[1].currentPage).toBe(1);
});
it('unloaded images outside the scroll viewport do not deadlock earlier readable content', () => {
  const page = doc('<div data-reader-scroll><img></div>');
  const root = page.querySelector<HTMLElement>('div')!,
    image = page.querySelector('img')!;
  root.getBoundingClientRect = () =>
    ({ top: 0, bottom: 100, height: 100 }) as DOMRect;
  image.getBoundingClientRect = () =>
    ({ top: 150, bottom: 200, height: 50 }) as DOMRect;
  expect(readerContentReady(root, true)).toBe(true);
  image.getBoundingClientRect = () =>
    ({ top: 30, bottom: 70, height: 40 }) as DOMRect;
  expect(readerContentReady(root, true)).toBe(false);
  expect(readerContentReady(root)).toBe(false);
});
it('seconds input preserves integer milliseconds despite floating-point conversion', () => {
  expect(readingIntervalFromSeconds('1.001')).toBe(1001);
  expect(
    validateLearningSettings({
      readingIntervalMs: readingIntervalFromSeconds('1.001'),
    }),
  ).toMatchObject({ readingIntervalMs: 1001 });
  for (const value of ['', '1.0001', '0.249', '5.001'])
    expect(() =>
      validateLearningSettings({
        readingIntervalMs: readingIntervalFromSeconds(value),
      }),
    ).toThrow();
});
it.each([250, 1000, 5000])(
  'pace %i controls actions independently from heartbeat',
  async (ms) => {
    vi.useFakeTimers();
    const page = doc('<li id="anchor1">1</li><li id="anchor2">2</li>');
    const visits = vi.fn();
    page
      .querySelectorAll<HTMLElement>('li')
      .forEach((n) => (n.scrollIntoView = visits));
    const reader = new ReadingAdapter(
      page,
      async () => true,
      async () => true,
    );
    await reader.start(binding, undefined, { readingIntervalMs: ms });
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(visits).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(visits).toHaveBeenCalledTimes(2);
    reader.pause();
  },
);
it('upgrades settings and pauses queues with no stale directory or frame binding', () => {
  const old = initialState();
  delete (old as any).learningSettings;
  Object.assign(old.learning, {
    phase: 'running',
    lease: 'old',
    frameId: 7,
    documentId: 'old',
    cursor: { course: 0, chapter: 2, chapters: [{ id: '1' }] },
  });
  const next = migrateState(old);
  expect(next.learningSettings.readingIntervalMs).toBe(250);
  expect(next.learning).toMatchObject({
    phase: 'paused',
    frameId: undefined,
    documentId: undefined,
    lease: undefined,
  });
  expect(next.learning.cursor?.chapters).toBeUndefined();
  expect(learningSettingsDefaults({ readingIntervalMs: 3 })).toEqual({
    readingIntervalMs: 250,
    preferredPlaybackRate: 2,
    settingsVersion: 1,
  });
});
it.each([0, 249, 5001, 1000.1, NaN, Infinity, '1000', null])(
  'rejects invalid pace %s without clamping',
  (value) => {
    expect(() =>
      validateLearningSettings({ readingIntervalMs: value }),
    ).toThrow(/250/);
  },
);
it('PDF.js returns to page one using native page input and then checks next-page changes', async () => {
  vi.useFakeTimers();
  const page = doc(
    '<input id="pageNumber" value="2"><span id="numPages">of 3</span><button id="next">Next</button><div id="viewerContainer"><div class="page" data-page-number="2">page</div></div>',
  );
  const input = page.querySelector<HTMLInputElement>('input')!,
    content = page.querySelector<HTMLElement>('.page')!;
  content.scrollIntoView = vi.fn();
  const change = () => content.setAttribute('data-page-number', input.value);
  input.addEventListener('change', change);
  page.querySelector('button')!.addEventListener('click', () => {
    input.value = String(Number(input.value) + 1);
    change();
  });
  const send = vi.fn(async (_b: unknown, _s: ReaderDescription) => true);
  const reader = new ReadingAdapter(page, async () => true, send);
  await reader.start(binding);
  expect(input.value).toBe('1');
  await vi.advanceTimersByTimeAsync(500);
  expect(send.mock.calls.at(-1)?.[1].currentPage).toBe(2);
  await vi.advanceTimersByTimeAsync(3500);
  expect(reader.readCompletion()).toBe(true);
  expect(input.value).toBe('3');
  reader.pause();
});
function scrollDoc() {
  const page = doc('<div data-reader-scroll><article>readable</article></div>');
  const root = page.querySelector<HTMLElement>('[data-reader-scroll]')!;
  let height = 300;
  Object.defineProperties(root, {
    clientHeight: { value: 100 },
    scrollHeight: { get: () => height },
  });
  return {
    page,
    root,
    grow: () => {
      height = 400;
    },
  };
}
it('scrolls by real viewports and resets stable-bottom timer when lazy content grows', async () => {
  vi.useFakeTimers();
  const { page, root, grow } = scrollDoc();
  const send = vi.fn(async (_b: unknown, _s: ReaderDescription) => true);
  const reader = new ReadingAdapter(page, async () => true, send);
  expect(describeReader(page)).toMatchObject({
    mode: 'scroll',
    totalPages: undefined,
  });
  await reader.start(binding, undefined, { readingIntervalMs: 1000 });
  await vi.advanceTimersByTimeAsync(1500);
  expect(root.scrollTop).toBe(200);
  expect(reader.readCompletion()).toBe(false);
  grow();
  await vi.advanceTimersByTimeAsync(1000);
  expect(root.scrollTop).toBe(300);
  expect(reader.readCompletion()).toBe(false);
  await vi.advanceTimersByTimeAsync(1500);
  expect(reader.readCompletion()).toBe(true);
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
    totalPages: undefined,
    currentPage: 0,
    scrollPosition: 300,
    finished: true,
  });
  reader.pause();
});
it('a scroll action without actual displacement fails with a structured timeout', async () => {
  vi.useFakeTimers();
  const { page, root } = scrollDoc();
  Object.defineProperty(root, 'scrollTop', { get: () => 0, set: () => {} });
  const send = vi.fn(async (_b: unknown, _s: ReaderDescription) => true);
  const reader = new ReadingAdapter(page, async () => true, send);
  await reader.start(binding);
  await vi.advanceTimersByTimeAsync(31000);
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
    errorCode: 'reader-scroll-timeout',
    finished: false,
  });
  reader.pause();
});
it('native pagination with an ineffective button times out, never counts the next page', async () => {
  vi.useFakeTimers();
  const page = doc(
    '<div class="document-page">1</div><nav data-reader-pages="2" data-reader-page="1"><button>下一页</button></nav>',
  );
  page.querySelector<HTMLElement>('.document-page')!.scrollIntoView = vi.fn();
  const send = vi.fn(async (_b: unknown, _s: ReaderDescription) => true);
  const reader = new ReadingAdapter(page, async () => true, send);
  await reader.start(binding);
  await vi.advanceTimersByTimeAsync(32000);
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
    currentPage: 1,
    errorCode: 'reader-page-timeout',
    finished: false,
  });
});
it('explicit duration sends independent heartbeats without reporting stalled or premature completion', async () => {
  vi.useFakeTimers();
  const { page } = scrollDoc();
  const send = vi.fn(async (_b: unknown, _s: ReaderDescription) => true);
  const reader = new ReadingAdapter(page, async () => true, send);
  await reader.start(binding, { seconds: 40 });
  await vi.advanceTimersByTimeAsync(35000);
  expect(reader.readCompletion()).toBe(false);
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
    waiting: '等待平台要求的阅读时长',
    errorCode: undefined,
  });
  expect(send.mock.calls.length).toBeGreaterThan(7);
  await vi.advanceTimersByTimeAsync(5000);
  expect(reader.readCompletion()).toBe(true);
});
it('multiple reader task containers cannot be chosen arbitrarily', async () => {
  const page = doc(
    '<div class="ans-attach-ct"><iframe data="{&quot;jobid&quot;:&quot;a&quot;}"></iframe><div class="document-page">a</div></div><div class="ans-attach-ct"><iframe data="{&quot;jobid&quot;:&quot;b&quot;}"></iframe><div class="document-page">b</div></div>',
  );
  page
    .querySelectorAll<HTMLElement>('.document-page')
    .forEach((n) => (n.scrollIntoView = vi.fn()));
  expect(describeReader(page)).toBeUndefined();
  const reader = new ReadingAdapter(
    page,
    async () => true,
    async () => true,
  );
  await reader.start({ ...binding, jobId: 'b' });
  expect(
    page.querySelectorAll<HTMLElement>('.document-page')[0]!.scrollIntoView,
  ).not.toHaveBeenCalled();
  expect(
    page.querySelectorAll<HTMLElement>('.document-page')[1]!.scrollIntoView,
  ).toHaveBeenCalledOnce();
  reader.pause();
});
it('cancel during authorization prevents all subsequent reader actions', async () => {
  const { page, root } = scrollDoc();
  let resolve!: (x: boolean) => void;
  const reader = new ReadingAdapter(
    page,
    () => new Promise((r) => (resolve = r)),
    async () => true,
  );
  const pending = reader.start(binding);
  reader.pause();
  resolve(true);
  await expect(pending).rejects.toThrow(/失效/);
  expect(root.scrollTop).toBe(0);
});
it('a PDF module toolbar containing a nested reader and icon images is not itself a reader', () => {
  const page = doc(
    '<div id="docContainer"><iframe id="panView" src="about:blank"></iframe><img width="22" height="22"></div>',
  );
  const root = page.querySelector<HTMLElement>('#docContainer')!;
  Object.defineProperties(root, {
    clientHeight: { value: 594 },
    scrollHeight: { value: 594 },
  });
  expect(describeReader(page)).toBeUndefined();
});
