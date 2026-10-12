import type { FrameRef } from './transport';

export class FrameAccountError extends Error {
  constructor(
    public readonly code:
      | 'account-unconfirmed'
      | 'account-changed'
      | 'multiple-accounts'
      | 'login-required',
    message: string,
  ) {
    super(message);
  }
}

/** Retry only when no frame identity is visible during a transient refresh. */
export async function discoverFramesWithIdentity(
  discover: (fresh: boolean) => Promise<FrameRef[]>,
  verify: (frames: FrameRef[]) => void,
  signal?: AbortSignal,
  attempts = 4,
  retryDelayMs = 250,
  liveWitnesses?: () => Promise<FrameRef[]>,
): Promise<FrameRef[]> {
  let frames: FrameRef[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted)
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('操作已取消');
    // Retrying a sub-second cached probe otherwise returns the same empty
    // registration on every attempt, even after the page has finished loading.
    frames = await discover(attempt > 0);
    const identities = new Set(
      frames.map((frame) => frame.accountId).filter(Boolean),
    );
    if (
      identities.size ||
      frames.some((frame) => frame.verificationRequired || frame.loginRequired)
    ) {
      verify(frames);
      return frames;
    }
    if (attempt + 1 < attempts && retryDelayMs > 0)
      await wait(retryDelayMs, signal);
  }
  if (frames.length && liveWitnesses) {
    const witnesses = await liveWitnesses();
    if (signal?.aborted)
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('操作已取消');
    if (witnesses.length) {
      // The target may have navigated while describing the personal center.
      // Validate the current document and return only its own resource frames.
      frames = await discover(true);
      verify(frames.length ? [...frames, ...witnesses] : frames);
      return frames;
    }
  }
  verify(frames);
  return frames;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('操作已取消'),
      );
      return;
    }
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve();
    };
    const cancel = () =>
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('操作已取消'),
      );
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
