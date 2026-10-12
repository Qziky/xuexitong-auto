import { afterEach, expect, it, vi } from 'vitest';
import { VideoPlayer, type VideoDescription } from '../src/video-player';
import { inertDocument } from '../src/scan-parser';
const url = 'https://mooc1.chaoxing.com/ananas/modules/video/index.html';
const binding = {
  learningId: 'l',
  runId: 'r',
  itemId: 'i',
  accountId: 'a',
  lease: 'one',
};
afterEach(() => vi.useRealTimers());
function fixture() {
  const doc = inertDocument(
    '<video id="player" src="https://media.test/a.mp4"></video>',
  );
  const video = doc.querySelector('video')!;
  video.setAttribute('src', 'https://media.test/a.mp4');
  Object.defineProperties(video, {
    play: { value: vi.fn(async () => {}) },
    pause: { value: vi.fn() },
    load: { value: vi.fn() },
    currentTime: { value: 1, writable: true },
    paused: { value: false, writable: true },
    readyState: { value: 4, writable: true },
    duration: { value: 60 },
  });
  const send = vi.fn(async (_b: unknown, _state: VideoDescription) => true);
  const player = new VideoPlayer(
    doc,
    () => url,
    async () => true,
    send,
  );
  return { doc, video, send, player };
}
it('recovery only completes after actual playback advances; play resolution is insufficient', async () => {
  vi.useFakeTimers();
  const { player, video } = fixture();
  await player.play(binding);
  let completed = false;
  const work = player
    .recover({ ...binding, lease: 'two' })
    .then(() => (completed = true));
  await vi.advanceTimersByTimeAsync(1000);
  expect(completed).toBe(false);
  video.currentTime = 1.3;
  video.dispatchEvent(new Event('timeupdate'));
  await vi.advanceTimersByTimeAsync(250);
  await work;
  expect(completed).toBe(true);
  player.pause();
});
it('a stalled recovery has a bounded timeout even when play() succeeds', async () => {
  vi.useFakeTimers();
  const { player } = fixture();
  await player.play(binding);
  const work = expect(
    player.recover({ ...binding, lease: 'two' }),
  ).rejects.toThrow(/无实际进展/);
  await vi.advanceTimersByTimeAsync(29000);
  await work;
  player.pause();
});
it('temporary empty src during reload keeps binding but a real source change requires rebinding', async () => {
  const { player, video } = fixture();
  await player.play(binding);
  video.removeAttribute('src');
  expect(player.describe()?.errorCode).toBeUndefined();
  video.setAttribute('src', 'https://media.test/b.mp4');
  expect(player.describe()?.errorCode).toBe('media-source-changed');
  await expect(player.recover({ ...binding, lease: 'two' })).rejects.toThrow(
    /变化/,
  );
  player.pause();
});
it('player replacement with the same HTML id cannot take over an old authorized lease', async () => {
  const { player, video, doc, send } = fixture();
  await player.play(binding);
  video.remove();
  const other = doc.createElement('video');
  other.id = 'player';
  doc.body.append(other);
  expect(player.describe()?.errorCode).toBe('player-replaced');
  await expect(player.recover({ ...binding, lease: 'two' })).rejects.toThrow(
    /变化/,
  );
  expect(send.mock.calls[0]?.[1].errorCode).toBeUndefined();
  player.pause();
});
it('media reload is attempted locally for loading errors and cancellation rejects late recovery', async () => {
  vi.useFakeTimers();
  const { player, video } = fixture();
  await player.play(binding);
  Object.defineProperty(video, 'readyState', { value: 0, writable: true });
  const rejected = expect(
    player.recover({ ...binding, lease: 'two' }),
  ).rejects.toThrow(/取消/);
  await vi.advanceTimersByTimeAsync(250);
  expect(video.load).toHaveBeenCalledOnce();
  player.pause();
  video.currentTime = 2;
  await vi.advanceTimersByTimeAsync(250);
  await rejected;
});
it('a title change does not pause or restart the original player', async () => {
  const { player, video, doc } = fixture();
  await player.play(binding);
  doc.title = 'new title';
  expect(player.describe()?.errorCode).toBeUndefined();
  expect(video.play).toHaveBeenCalledOnce();
  player.pause();
});
