import type { PlatformBlock } from './domain';
import { isChaoxingUrl } from './security';
import { summaryText } from './dom-summary';

export const PLATFORM_REQUEST_INTERVAL = 1000;
export const VERIFY_MESSAGE =
  '超星要求人工验证码验证，扫描和答题已暂停。请在平台完成验证后主动继续。';

export class PlatformAccessError extends Error {
  constructor(public readonly block: PlatformBlock) {
    super(block.message);
    this.name = 'PlatformAccessError';
  }
}
export function platformBlockFor(
  url: string,
  kind: PlatformBlock['kind'] = 'captcha',
  retryAfter?: number,
): PlatformBlock {
  return {
    kind,
    at: Date.now(),
    message:
      kind === 'captcha'
        ? VERIFY_MESSAGE
        : '超星返回访问限流，扫描和答题已暂停。请等待后主动继续。',
    // Navigation tokens and user identifiers are unnecessary for the verification entry.
    url: isChaoxingUrl(url)
      ? new URL(url).origin + new URL(url).pathname
      : undefined,
    retryAfter,
  };
}
export function detectVerification(
  url: string,
  doc?: Document,
): PlatformBlock | undefined {
  if (!isChaoxingUrl(url)) return undefined;
  if (/\/antispider(?:ShowVerify)?(?:\.|\/|$)/i.test(new URL(url).pathname))
    return platformBlockFor(url);
  const text = doc?.body ? summaryText(doc.body, 10000) : '';
  return /(?:\[|【)?9010(?:\]|】)?/.test(text) &&
    /操作异常/.test(text) &&
    /验证码/.test(text)
    ? platformBlockFor(url)
    : undefined;
}
export function assertPlatformPage(url: string, doc?: Document): void {
  const block = detectVerification(url, doc);
  if (block) throw new PlatformAccessError(block);
}
export function retryAfterTime(
  header: string | null,
  now = Date.now(),
): number {
  const seconds =
    header && /^\d+$/.test(header.trim()) ? Number(header.trim()) : NaN;
  const date = header ? Date.parse(header) : NaN;
  return Math.max(
    now + 30000,
    Number.isFinite(seconds)
      ? now + seconds * 1000
      : Number.isFinite(date)
        ? date
        : now + 600000,
  );
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('操作已取消'));
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error('操作已取消'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
export class RequestPacer {
  private previousStart = -Infinity;
  private tail = Promise.resolve();
  constructor(private readonly interval = PLATFORM_REQUEST_INTERVAL) {}
  dispatch<T>(
    action: (started: (at?: number) => void) => T | Promise<T>,
    signal?: AbortSignal,
    hooks: {
      check?: () => void | Promise<void>;
      waiting?: (until: number | undefined, elapsedMs: number) => void;
    } = {},
  ): Promise<T> {
    const turn = this.tail.then(async () => {
      const check = async () => {
        if (signal?.aborted) throw new Error('操作已取消');
        await hooks.check?.();
        if (signal?.aborted) throw new Error('操作已取消');
      };
      await check();
      const until = this.previousStart + this.interval;
      const remaining = until - Date.now();
      if (remaining > 0) {
        const began = Date.now();
        hooks.waiting?.(until, 0);
        try {
          // A browser timer can wake slightly early. Recheck the actual clock
          // instead of dispatching early or adding another complete interval.
          while (until > Date.now()) {
            await wait(until - Date.now(), signal);
            await check();
          }
        } finally {
          hooks.waiting?.(undefined, Date.now() - began);
        }
      } else await check();
      return action((at = Date.now()) => {
        // Only a dispatched action consumes a turn, never cache work or cancellation.
        this.previousStart = Math.max(this.previousStart, at);
      });
    });
    this.tail = turn.then(
      () => {},
      () => {},
    );
    if (!signal) return turn;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(new Error('操作已取消'));
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      turn
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', cancel));
    });
  }
  wait(signal?: AbortSignal): Promise<void> {
    return this.dispatch((started) => started(), signal);
  }
}
