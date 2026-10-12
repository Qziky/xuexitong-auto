import { afterEach, expect, it, vi } from 'vitest';
import { inertDocument } from '../src/scan-parser';
import {
  VideoPlayer,
  playbackFailure,
  type VideoBinding,
} from '../src/video-player';
import {
  ReadingAdapter,
  type ReaderDescription,
} from '../src/learning-adapters';
import { learningTarget } from '../src/background/learning-target';
const url = 'https://mooc1.chaoxing.com/ananas/modules/video/index.html';
const binding: VideoBinding = {
  learningId: 'l',
  runId: 'r',
  itemId: 'i',
  accountId: 'cx:1',
  lease: 'lease',
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function playable(tag = 'video') {
  const doc = inertDocument(
    '<' +
      tag +
      ' id="target" src="https://media.test/movie.mp4"></' +
      tag +
      '>',
  );
  const media = doc.querySelector<HTMLMediaElement>(tag)!;
  Object.defineProperties(media, {
    paused: { value: false, configurable: true },
    readyState: { value: 4 },
    play: { value: vi.fn(async () => {}), configurable: true },
    pause: { value: vi.fn() },
    duration: { value: 60 },
    currentTime: { value: 1, writable: true },
  });
  return { doc, media };
}
it('audio uses the native media pipeline, muted at normal speed', async () => {
  const { doc, media } = playable('audio');
  const player = new VideoPlayer(
    doc,
    () => url,
    async () => true,
    async () => true,
  );
  expect(await player.play({ ...binding, targetId: 'target' })).toMatchObject({
    kind: 'audio',
    position: 1,
  });
  expect(media.muted).toBe(true);
  expect(media.playbackRate).toBe(1);
  player.pause();
});
it('multiple players require an exact target; starting one leaves the other unchanged', async () => {
  const { doc, media } = playable();
  const other = doc.createElement('video');
  other.id = 'other';
  doc.body.append(other);
  const player = new VideoPlayer(
    doc,
    () => url,
    async () => true,
    async () => true,
  );
  await expect(player.play(binding)).rejects.toThrow('定位');
  await player.play({ ...binding, targetId: 'target' });
  expect(media.play).toHaveBeenCalledOnce();
  expect(other.muted).toBe(false);
  player.pause();
});
it.each([
  ['NotAllowedError', 'autoplay-blocked'],
  ['NotSupportedError', 'unsupported-source'],
  ['AbortError', 'media-aborted'],
])('classifies %s separately', (name, code) => {
  expect(playbackFailure(new DOMException('blocked', name)).code).toBe(code);
});
it('a late unbound-player guard cannot pause an authorized player', async () => {
  const { doc, media } = playable();
  let active = true;
  const player = new VideoPlayer(
    doc,
    () => url,
    async () => active,
    async () => true,
  );
  await player.play(binding);
  await player.pauseUnbound();
  expect(media.pause).not.toHaveBeenCalled();
  active = false;
  await player.pauseUnbound();
  expect(media.pause).toHaveBeenCalled();
});
it('cancel interrupts a pending native play promise immediately', async () => {
  const { doc, media } = playable();
  Object.defineProperty(media, 'play', {
    value: vi.fn(() => new Promise(() => {})),
  });
  const player = new VideoPlayer(
    doc,
    () => url,
    async () => true,
    async () => true,
  );
  const promise = player.play(binding);
  const rejected = expect(promise).rejects.toThrow('取消');
  await vi.waitFor(() => expect(media.play).toHaveBeenCalledOnce());
  player.pause();
  await rejected;
});
it('late authorization after cancel cannot start native playback', async () => {
  const { doc, media } = playable();
  let resolve!: (active: boolean) => void;
  const player = new VideoPlayer(
    doc,
    () => url,
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    async () => true,
  );
  const result = player.play(binding);
  const rejected = expect(result).rejects.toThrow('取消');
  player.pause();
  resolve(true);
  await rejected;
  expect(media.play).not.toHaveBeenCalled();
});
it('resolves a nested reader through its actual parent module job', () => {
  const frames = [
    {
      tabId: 1,
      frameId: 0,
      learningTargets: [
        { src: 'https://cx.test/pdf', objectId: 'doc1', jobId: 'd' },
      ],
    },
    { tabId: 1, frameId: 4, parentFrameId: 0, url: 'https://cx.test/pdf' },
    {
      tabId: 1,
      frameId: 5,
      parentFrameId: 4,
      url: 'https://cx.test/viewer',
      reader: {},
    },
    {
      tabId: 1,
      frameId: 6,
      parentFrameId: 0,
      url: 'https://cx.test/other',
      reader: {},
    },
  ] as any;
  expect(
    learningTarget(
      { type: 'document', objectId: 'doc1', jobId: 'd' } as any,
      frames,
    )?.ref.frameId,
  ).toBe(5);
});
it('sibling module frames sharing a URL are located by physical iframe identity', () => {
  const frames = [1, 2].map((id) => ({
    tabId: 1,
    frameId: id,
    parentFrameId: 0,
    url,
    learningIdentity: { jobId: 'job' + id, objectId: 'object' + id },
    media: [{ kind: 'video', targetId: 'video_html5_api' }],
  })) as any;
  expect(
    learningTarget(
      { type: 'video', jobId: 'job2', objectId: 'object2' } as any,
      frames,
    )?.ref.frameId,
  ).toBe(2);
});
it('reader visits actual viewer pages in order and stops after cancellation', async () => {
  vi.useFakeTimers();
  const doc = inertDocument(
    '<li id="anchor1">one</li><li id="anchor2">two</li><li id="anchor3">three</li>',
  );
  const visits: string[] = [];
  doc.querySelectorAll<HTMLElement>('li').forEach(
    (p) =>
      (p.scrollIntoView = () => {
        visits.push(p.id);
      }),
  );
  const adapter = new ReadingAdapter(
    doc,
    async () => true,
    async () => true,
  );
  await adapter.start(binding);
  expect(visits).toEqual(['anchor1']);
  await vi.advanceTimersByTimeAsync(250);
  expect(visits).toEqual(['anchor1', 'anchor2']);
  adapter.pause();
  await vi.advanceTimersByTimeAsync(10000);
  expect(visits).toHaveLength(2);
});
it('reader honors explicit reading time and reports local completion only', async () => {
  vi.useFakeTimers();
  const doc = inertDocument('<li id="anchor1">one</li>');
  doc.querySelector<HTMLElement>('li')!.scrollIntoView = vi.fn();
  const send = vi.fn(async (_b: VideoBinding, _s: ReaderDescription) => true);
  const adapter = new ReadingAdapter(doc, async () => true, send);
  await adapter.start(binding, { seconds: 10 });
  expect(adapter.readCompletion()).toBe(false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(adapter.readCompletion()).toBe(true);
  expect(send.mock.calls.at(-1)?.[1].finished).toBe(true);
  adapter.pause();
});
it('paginated reader clicks its native next button and waits for the displayed page number', async () => {
  vi.useFakeTimers();
  const doc = inertDocument(
    '<div class="document-page">page</div><nav data-reader-pages="3" data-reader-page="1"><button>下一页</button></nav>',
  );
  doc.querySelector<HTMLElement>('.document-page')!.scrollIntoView = vi.fn();
  const nav = doc.querySelector('nav')!;
  const next = vi.fn(() =>
    nav.setAttribute(
      'data-reader-page',
      String(Number(nav.getAttribute('data-reader-page')) + 1),
    ),
  );
  doc.querySelector('button')!.addEventListener('click', next);
  const send = vi.fn(async (_b: VideoBinding, _s: ReaderDescription) => true);
  const reader = new ReadingAdapter(doc, async () => true, send);
  await reader.start(binding);
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
    currentPage: 1,
    totalPages: 3,
    finished: false,
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(next).toHaveBeenCalledTimes(2);
  expect(reader.readCompletion()).toBe(false);
  await vi.advanceTimersByTimeAsync(15000);
  expect(next).toHaveBeenCalledTimes(2);
  expect(reader.readCompletion()).toBe(true);
  reader.pause();
});
it('an unloaded image is never counted as read and reports its actual loading failure', async () => {
  vi.useFakeTimers();
  const doc = inertDocument(
    '<div class="document-page"><img src="https://media.test/page.png"></div>',
  );
  doc.querySelector<HTMLElement>('.document-page')!.scrollIntoView = vi.fn();
  const send = vi.fn(async (_b: VideoBinding, _s: ReaderDescription) => true);
  const reader = new ReadingAdapter(doc, async () => true, send);
  await reader.start(binding);
  await vi.advanceTimersByTimeAsync(35000);
  expect(reader.readCompletion()).toBe(false);
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
    currentPage: 0,
    finished: false,
    waiting: '页面图片加载失败',
  });
  reader.pause();
});
