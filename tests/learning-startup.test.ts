import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LearningStarter } from '../src/learning-startup';
import type { VideoBinding } from '../src/video-player';
import { PlatformAccessError, platformBlockFor } from '../src/platform-access';
const binding: VideoBinding = {
  learningId: 'l',
  runId: 'r',
  accountId: 'a',
  itemId: 'i',
  lease: 'one',
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('acknowledges before initialization and reports actual startup separately', async () => {
  let release!: () => void;
  const notify = vi.fn(async () => {});
  const work = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const starter = new LearningStarter(notify);
  expect(starter.launch(binding, work)).toEqual({
    accepted: true,
    lease: 'one',
  });
  expect(work).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(notify).not.toHaveBeenCalled();
  release();
  await vi.advanceTimersByTimeAsync(1);
  expect(notify).toHaveBeenCalledWith(binding, { state: 'started' });
});
it('duplicate delivery cannot restart a native resource', async () => {
  const work = vi.fn(async () => {});
  const starter = new LearningStarter(vi.fn(async () => {}));
  starter.launch(binding, work);
  starter.launch({ ...binding }, work);
  await vi.advanceTimersByTimeAsync(1);
  expect(work).toHaveBeenCalledOnce();
});
it('cancelling before deferred activation performs no platform action', async () => {
  const work = vi.fn(async () => {}),
    notify = vi.fn(async () => {});
  const starter = new LearningStarter(notify);
  starter.launch(binding, work);
  starter.cancel();
  await vi.advanceTimersByTimeAsync(1);
  expect(work).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});
it('an old initialization completing after a new lease sends no stale result', async () => {
  let release!: () => void;
  const notify = vi.fn(async () => {}),
    starter = new LearningStarter(notify);
  starter.launch(
    binding,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(1);
  const next = { ...binding, lease: 'two' };
  starter.launch(next, async () => {});
  await vi.advanceTimersByTimeAsync(1);
  release();
  await vi.advanceTimersByTimeAsync(1);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(next, { state: 'started' });
});
it('channel closure is reported as a recoverable Chinese error', async () => {
  const notify = vi.fn(async () => {}),
    starter = new LearningStarter(notify);
  starter.launch(binding, async () => {
    throw new Error(
      'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
    );
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(notify).toHaveBeenCalledWith(
    binding,
    expect.objectContaining({
      state: 'failed',
      errorCode: 'frame-disconnected',
      error: expect.stringContaining('重新连接'),
    }),
  );
});
it('platform verification remains a fatal stop condition', async () => {
  const block = platformBlockFor(
    'https://mooc1.chaoxing.com/antispiderShowVerify.ac',
  );
  const notify = vi.fn(async () => {}),
    starter = new LearningStarter(notify);
  starter.launch(binding, async () => {
    throw new PlatformAccessError(block);
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(notify).toHaveBeenCalledWith(
    binding,
    expect.objectContaining({ state: 'failed', block }),
  );
});
