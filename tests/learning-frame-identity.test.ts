import { expect, it, vi } from 'vitest';
import {
  identityFromFrame,
  learningFrameIdentity,
} from '../src/learning-frame-identity';
it('physical iframe identity includes task IDs without depending on a unique URL', () => {
  const f = document.createElement('iframe');
  f.setAttribute('data', '{"jobid":"job2","property":{"objectid":"object2"}}');
  expect(identityFromFrame(f)).toEqual({ jobId: 'job2', objectId: 'object2' });
  f.setAttribute('data', 'invalid');
  expect(identityFromFrame(f)).toBeUndefined();
});
it('parent handshake ignores unrecognized origins and windows that are not its own child', () => {
  const frame = document.createElement('iframe');
  frame.setAttribute('data', '{"jobid":"job2","objectid":"object2"}');
  document.body.append(frame);
  const child = frame.contentWindow!,
    post = vi.spyOn(child, 'postMessage').mockImplementation(() => {});
  const identity = learningFrameIdentity(window, vi.fn());
  const data = { source: 'cx-learning-frame', kind: 'request', nonce: 'known' };
  try {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.test',
        source: child,
        data,
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://mooc1.chaoxing.com',
        source: window,
        data,
      }),
    );
    expect(post).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://mooc1.chaoxing.com',
        source: child,
        data,
      }),
    );
    expect(post).toHaveBeenCalledWith(
      {
        source: 'cx-learning-frame',
        kind: 'identity',
        nonce: 'known',
        identity: { jobId: 'job2', objectId: 'object2' },
      },
      '*',
    );
    frame.setAttribute('data', '{"jobid":"new","objectid":"next"}');
    identity.refresh();
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({
      identity: { jobId: 'new', objectId: 'next' },
    });
  } finally {
    identity.close();
    post.mockRestore();
    frame.remove();
  }
});
