import { afterEach, expect, it, vi } from 'vitest';
import { ReadingAdapter } from '../src/learning-adapters';
import { applyPlaybackPreference, VideoPlayer } from '../src/video-player';
import {
  upgradeLearningSettings,
  validateLearningSettings,
} from '../src/learning-settings';
import {
  learningFrameIdentity,
  identityFromFrame,
} from '../src/learning-frame-identity';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
const binding = {
  learningId: 'l',
  runId: 'r',
  itemId: 'i',
  accountId: 'a',
  lease: 'lease',
};
function scrollReader() {
  const doc = new DOMParser().parseFromString(
    '<div data-reader-scroll><article>read</article></div>',
    'text/html',
  );
  const root = doc.querySelector<HTMLElement>('div')!;
  let position = 0;
  const actions: number[] = [];
  Object.defineProperties(root, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 500 },
    scrollTop: {
      get: () => position,
      set: (v: number) => {
        position = v;
        actions.push(Date.now());
      },
    },
  });
  return { doc, root, actions };
}
it.each([250, 1000, 5000])(
  'does not add an acknowledgment interval to %s ms viewport actions',
  async (ms) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { doc, actions } = scrollReader();
    const reader = new ReadingAdapter(
      doc,
      async () => true,
      async () => true,
    );
    await reader.start(binding, undefined, { readingIntervalMs: ms });
    await vi.advanceTimersByTimeAsync(ms * 2);
    expect(actions.slice(0, 3)).toEqual([0, ms, ms * 2]);
    reader.pause();
  },
);
it('does not renew the reading deadline after a slow progress response', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { doc, actions } = scrollReader();
  const reader = new ReadingAdapter(
    doc,
    async () => true,
    async () => {
      await new Promise((r) => setTimeout(r, 100));
      return true;
    },
  );
  const start = reader.start(binding);
  await vi.advanceTimersByTimeAsync(100);
  await start;
  await vi.advanceTimersByTimeAsync(1200);
  expect(actions[1]! - actions[0]!).toBeLessThanOrEqual(350);
  reader.pause();
});
it('issues native page controls continuously instead of adding a second interval after acknowledgment', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const doc = new DOMParser().parseFromString(
    '<div class="pdfViewer"><input id="pageNumber" value="1"><span id="numPages">4</span><button id="next">next</button><div class="page" data-page-number="1">page</div></div>',
    'text/html',
  );
  const input = doc.querySelector<HTMLInputElement>('input')!,
    page = doc.querySelector<HTMLElement>('.page')!;
  page.scrollIntoView = vi.fn();
  const actions: number[] = [];
  doc.querySelector('button')!.addEventListener('click', () => {
    input.value = String(Number(input.value) + 1);
    page.dataset.pageNumber = input.value;
    actions.push(Date.now());
  });
  const reader = new ReadingAdapter(
    doc,
    async () => true,
    async () => true,
  );
  await reader.start(binding, undefined, { readingIntervalMs: 250 });
  await vi.advanceTimersByTimeAsync(750);
  expect(actions).toEqual([0, 250, 500]);
  expect(reader.readCompletion()).toBe(true);
  reader.pause();
});
it('skips idle authorizations and messages during a long explicit dwell', async () => {
  vi.useFakeTimers();
  const doc = new DOMParser().parseFromString(
    '<li id="anchor1">one</li>',
    'text/html',
  );
  doc.querySelector<HTMLElement>('li')!.scrollIntoView = vi.fn();
  const authorize = vi.fn(async () => true),
    send = vi.fn(async () => true);
  const reader = new ReadingAdapter(doc, authorize, send);
  await reader.start(binding, { seconds: 20 });
  await vi.advanceTimersByTimeAsync(4500);
  expect(authorize.mock.calls.length).toBeLessThan(5);
  expect(reader.readCompletion()).toBe(false);
  await vi.advanceTimersByTimeAsync(16500);
  expect(reader.readCompletion()).toBe(true);
  reader.pause();
});
it('upgrades only the old default and preserves a later explicit one second preference', () => {
  expect(upgradeLearningSettings(undefined)).toMatchObject({
    readingIntervalMs: 250,
    preferredPlaybackRate: 2,
    settingsVersion: 1,
  });
  expect(
    upgradeLearningSettings({ readingIntervalMs: 1000 }).readingIntervalMs,
  ).toBe(250);
  expect(
    upgradeLearningSettings({ readingIntervalMs: 1234 }).readingIntervalMs,
  ).toBe(1234);
  expect(
    upgradeLearningSettings(
      validateLearningSettings({
        readingIntervalMs: 1000,
        preferredPlaybackRate: 1,
      }),
    ),
  ).toMatchObject({ readingIntervalMs: 1000, preferredPlaybackRate: 1 });
});
it.each([0, 1.5, 3, '2'])('rejects unsupported speed preference %s', (value) =>
  expect(() =>
    validateLearningSettings({
      readingIntervalMs: 250,
      preferredPlaybackRate: value,
    }),
  ).toThrow(/播放速度/),
);
it('selects the native advertised two times control without seeking', () => {
  document.body.innerHTML =
    '<div class="video-js"><video></video><button class="vjs-playback-rate-menu-item"><span class="vjs-menu-item-text">2x</span></button></div>';
  const media = document.querySelector('video')!;
  media.currentTime = 17;
  document.querySelector('button')!.addEventListener('click', () => {
    media.playbackRate = 2;
  });
  expect(applyPlaybackPreference(media, 2)).toBe('applied');
  expect(media.playbackRate).toBe(2);
  expect(media.currentTime).toBe(17);
});
it('falls back to normal speed when no native two times control is advertised', () => {
  document.body.innerHTML = '<video></video>';
  const media = document.querySelector('video')!;
  media.playbackRate = 1.5;
  expect(applyPlaybackPreference(media, 2)).toBe('unsupported');
  expect(media.playbackRate).toBe(1);
});
it('falls back when an advertised native control refuses the requested rate', () => {
  document.body.innerHTML =
    '<div class="video-js"><video></video><button data-playback-rate="2">2x</button></div>';
  const media = document.querySelector('video')!;
  document.querySelector('button')!.addEventListener('click', () => {
    media.playbackRate = 1.5;
  });
  expect(applyPlaybackPreference(media, 2)).toBe('unsupported');
  expect(media.playbackRate).toBe(1);
});
it('keeps platform speed changes and restores original rate when releasing the owned media', async () => {
  document.body.innerHTML =
    '<div class="video-js"><video></video><button data-playback-rate="2">2倍速</button></div>';
  const media = document.querySelector('video')!;
  document.querySelector('button')!.addEventListener('click', () => {
    media.playbackRate = 2;
  });
  media.play = vi.fn(async () => {
    Object.defineProperty(media, 'paused', {
      configurable: true,
      value: false,
    });
  });
  media.pause = vi.fn();
  const player = new VideoPlayer(
    document,
    () => document.URL,
    async () => true,
    async () => true,
  );
  await player.play(binding);
  expect(player.describe()).toMatchObject({
    actualPlaybackRate: 2,
    speedStatus: 'applied',
  });
  media.playbackRate = 1;
  expect(player.describe()).toMatchObject({
    actualPlaybackRate: 1,
    speedStatus: 'overridden',
  });
  player.pause();
  expect(media.playbackRate).toBe(1);
});
it('completion identity is restricted to the attachment owning the physical frame', () => {
  document.body.innerHTML =
    '<div class="ans-attach-ct"><iframe data=\'{"jobid":"j","objectid":"o"}\'></iframe><div class="ans-attach-ct ans-job-finished"><i class="ans-job-icon">任务点已完成</i></div></div>';
  const frame = document.querySelector('iframe')!;
  expect(identityFromFrame(frame)?.completionState).toBeUndefined();
  frame.closest('.ans-attach-ct')!.classList.add('ans-job-finished');
  expect(identityFromFrame(frame)?.completionState).toBe('confirmed');
});
