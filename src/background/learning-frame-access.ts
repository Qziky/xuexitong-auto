import {
  discoverFrames as probe,
  waitForFrames as wait,
  assertFramesAccessible,
  type FrameRef,
} from './transport';
import { discoverFramesWithIdentity } from './frame-account';
import { checkFrames } from './scan-control';
import { isChaoxingUrl } from '../security';
/** Learning reuses verified frame registrations; a full probe is bounded to once/sec. */
export const discoverFrames = (
  tabId?: number,
  signal?: AbortSignal,
  cached = true,
) => probe(tabId, signal, cached);

/** A freshly described personal center can identify anonymous resource frames
 * in this browser session. Saved account state alone is never sufficient. */
export function isLiveAccountWitness(ref: FrameRef): boolean {
  if (
    !ref.top ||
    !ref.documentId ||
    !ref.accountId ||
    ref.loginRequired ||
    ref.verificationRequired ||
    !isChaoxingUrl(ref.url)
  )
    return false;
  const url = new URL(ref.url);
  return (
    url.hostname === 'i.chaoxing.com' &&
    (url.pathname === '/' ||
      /^\/(?:base|visit\/interaction)(?:\/|$)/.test(url.pathname))
  );
}

export const discoverAccountFrames = (
  tabId: number,
  expected: string,
  signal?: AbortSignal,
) =>
  discoverFramesWithIdentity(
    (fresh) => probe(tabId, signal, !fresh),
    (all) => checkFrames(all, expected),
    signal,
    4,
    250,
    async () => {
      const all = await probe(undefined, signal, false);
      assertFramesAccessible(all);
      return all.filter(isLiveAccountWitness);
    },
  );
export const waitForFrames = (
  tabId: number,
  predicate: (ref: FrameRef) => boolean,
  signal?: AbortSignal,
  timeout = 30000,
) => wait(tabId, predicate, signal, timeout, true);
