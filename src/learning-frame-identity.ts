import { isChaoxingUrl } from './security';
import { attachmentCompletion } from './learning-completion';
import type { CompletionState } from './domain';
export interface LearningIdentity {
  objectId?: string;
  jobId?: string;
  completionState?: CompletionState;
}
export function identityFromFrame(
  frame: Element,
): LearningIdentity | undefined {
  try {
    const data = JSON.parse(frame.getAttribute('data') ?? 'null'),
      p = data?.property ?? data;
    const jobId = data?.jobid ?? data?._jobid ?? p?.jobid;
    const objectId =
      data?.objectid ?? data?.objectId ?? p?.objectid ?? p?.objectId;
    const completionState = attachmentCompletion(
      frame.closest('.ans-attach-ct'),
    );
    return jobId || objectId
      ? {
          jobId: jobId ? String(jobId) : undefined,
          objectId: objectId ? String(objectId) : undefined,
          ...(completionState !== 'unknown' ? { completionState } : {}),
        }
      : undefined;
  } catch {
    return;
  }
}
/** Resolve the physical iframe, including siblings sharing the same module URL.
 * Only DOM task IDs cross the parent/child bridge; it never grants execution authority. */
export function learningFrameIdentity(win: Window, changed: () => void) {
  const nonce = crypto.randomUUID(),
    children = new Map<Window, string>();
  let inherited: LearningIdentity | undefined,
    lastRequest = 0;
  const current = () => {
    try {
      return (
        (win.frameElement ? identityFromFrame(win.frameElement) : undefined) ??
        inherited
      );
    } catch {
      return inherited;
    }
  };
  const respond = (child: Window, token: string) => {
    const frame = [
      ...win.document.querySelectorAll<HTMLIFrameElement>('iframe'),
    ].find((f) => f.contentWindow === child);
    if (!frame) {
      children.delete(child);
      return;
    }
    child.postMessage(
      {
        source: 'cx-learning-frame',
        kind: 'identity',
        nonce: token,
        identity: identityFromFrame(frame) ?? current(),
      },
      '*',
    );
  };
  const listener = (event: MessageEvent) => {
    if (
      !isChaoxingUrl(event.origin) ||
      event.data?.source !== 'cx-learning-frame'
    )
      return;
    if (
      event.data.kind === 'request' &&
      typeof event.data.nonce === 'string' &&
      event.data.nonce.length < 100 &&
      event.source
    ) {
      const child = event.source as Window;
      if (
        ![...win.document.querySelectorAll<HTMLIFrameElement>('iframe')].some(
          (f) => f.contentWindow === child,
        )
      )
        return;
      children.set(child, event.data.nonce);
      respond(child, event.data.nonce);
    } else if (
      event.data.kind === 'identity' &&
      event.source === win.parent &&
      event.data.nonce === nonce
    ) {
      const value = event.data.identity;
      const next =
        value &&
        (typeof value.jobId === 'string' || typeof value.objectId === 'string')
          ? {
              jobId: typeof value.jobId === 'string' ? value.jobId : undefined,
              objectId:
                typeof value.objectId === 'string' ? value.objectId : undefined,
              ...(['confirmed', 'incomplete', 'conflict'].includes(
                value.completionState,
              )
                ? { completionState: value.completionState as CompletionState }
                : {}),
            }
          : undefined;
      if (JSON.stringify(next) !== JSON.stringify(inherited)) {
        inherited = next;
        changed();
      }
    }
  };
  const refresh = () => {
    if (win.parent !== win && Date.now() - lastRequest > 500) {
      lastRequest = Date.now();
      win.parent.postMessage(
        { source: 'cx-learning-frame', kind: 'request', nonce },
        '*',
      );
    }
    for (const [child, token] of children) respond(child, token);
  };
  win.addEventListener('message', listener);
  refresh();
  let retries = 0;
  const timer = setInterval(() => {
    refresh();
    if (win.parent === win || inherited || ++retries >= 10)
      clearInterval(timer);
  }, 1000);
  return {
    current,
    refresh,
    close: () => {
      clearInterval(timer);
      children.clear();
      win.removeEventListener('message', listener);
    },
  };
}
