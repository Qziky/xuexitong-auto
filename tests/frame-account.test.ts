import { expect, it, vi } from 'vitest';
import { discoverFramesWithIdentity } from '../src/background/frame-account';
import type { FrameRef } from '../src/background/transport';

const frame = (accountId?: string, verificationRequired = false) =>
  ({ accountId, verificationRequired }) as FrameRef;

it('retries empty transient probes until the expected identity is available', async () => {
  const discover = vi
    .fn<() => Promise<FrameRef[]>>()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([frame('cx:expected')]);
  const verify = vi.fn((frames: FrameRef[]) => {
    expect(frames[0]?.accountId).toBe('cx:expected');
  });

  const result = await discoverFramesWithIdentity(
    discover,
    verify,
    undefined,
    3,
    0,
  );

  expect(discover).toHaveBeenCalledTimes(2);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(result[0]?.accountId).toBe('cx:expected');
});

it('fails immediately on a different identity instead of retrying it away', async () => {
  const discover = vi.fn(async () => [frame('cx:other')]);
  const verify = vi.fn(() => {
    throw new Error('account mismatch');
  });

  await expect(
    discoverFramesWithIdentity(discover, verify, undefined, 4, 0),
  ).rejects.toThrow('account mismatch');
  expect(discover).toHaveBeenCalledTimes(1);
});

it('fails after the bounded retries when no frame can confirm an account', async () => {
  const discover = vi.fn(async () => []);
  const verify = vi.fn(() => {
    throw new Error('account unconfirmed');
  });

  await expect(
    discoverFramesWithIdentity(discover, verify, undefined, 3, 0),
  ).rejects.toThrow('account unconfirmed');
  expect(discover).toHaveBeenCalledTimes(3);
});

it('does not retry a verification frame', async () => {
  const discover = vi.fn(async () => [frame(undefined, true)]);
  const verify = vi.fn(() => {
    throw new Error('verification required');
  });

  await expect(
    discoverFramesWithIdentity(discover, verify, undefined, 4, 0),
  ).rejects.toThrow('verification required');
  expect(discover).toHaveBeenCalledTimes(1);
});
