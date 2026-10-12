import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
import { PlatformReader } from '../src/platform-reader';
import {
  PlatformAdmissionClient,
  type PlatformAdmissionRequest,
} from '../src/platform-admission';
import { RequestPacer } from '../src/platform-access';

const URL =
  'https://mooc1.chaoxing.com/mooc2/work/list?courseId=100&classId=200';
const NEXT = URL + '&page=2';
let state = initialState();
let transport: typeof import('../src/background/transport');
let platform: typeof import('../src/background/platform');
let starts: number[], admissions: PlatformAdmissionRequest[];
let fetcher: ReturnType<typeof vi.fn>;
let client: PlatformAdmissionClient;
let progress: ReturnType<typeof vi.fn>;
let controllers: Map<string, AbortController>;
function response(
  url = URL,
  html = '<div>作业列表</div>',
  status = 200,
): Response {
  return {
    url,
    status,
    ok: status === 200,
    headers: new Headers(),
    text: async () => html,
  } as Response;
}
function read(url = URL, signal?: AbortSignal, fresh = false) {
  return transport.offscreen<{ html: string; source?: string }>(
    { op: 'fetch', url, purpose: 'homework-list', fresh },
    signal,
  );
}
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  state = initialState();
  state.accountId = 'a';
  starts = [];
  admissions = [];
  controllers = new Map();
  progress = vi.fn();
  vi.doMock('../src/background/store', () => ({
    state,
    persist: vi.fn(async () => {}),
    log: vi.fn(),
  }));
  vi.doMock('../src/background/operations', () => ({
    updateOperation: progress,
    operationEvent: vi.fn(),
    heartbeatOperation: vi.fn(),
  }));
  transport = await import('../src/background/transport');
  platform = await import('../src/background/platform');
  const reader = new PlatformReader();
  client = new PlatformAdmissionClient((message) =>
    chrome.runtime.sendMessage(message),
  );
  fetcher = vi.fn(async (url: string) => {
    starts.push(Date.now());
    return response(url);
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('chrome', {
    offscreen: { hasDocument: async () => true },
    runtime: {
      sendMessage: vi.fn(async (message) => {
        if (message.kind === 'platform-request') {
          admissions.push(message);
          return { ok: transport.requestPlatformAdmission(message) };
        }
        if (message.kind === 'platform-cancel') {
          transport.cancelPlatformAdmission(message.id);
          return { ok: true };
        }
        if (
          message.kind === 'platform-check' ||
          message.kind === 'platform-grant'
        )
          return client.receive(message);
        if (message.kind === 'cancel') {
          controllers.get(message.id)?.abort();
          return { ok: true };
        }
        if (message.kind === 'job') {
          const controller = new AbortController();
          controllers.set(message.id, controller);
          let seq = 0;
          void reader
            .read(
              message.job.url,
              controller.signal,
              message.job.scope,
              !!message.job.fresh,
              message.job.purpose,
              {
                jobId: message.id,
                network: (context, start) => client.request(context, start),
                progress: (note, detail) =>
                  transport.jobHeartbeat(message.id, note, detail, ++seq),
              },
            )
            .then(
              (value) => transport.finishJob(message.id, { ok: true, value }),
              (error) =>
                transport.finishJob(message.id, {
                  ok: false,
                  error: error.message,
                  block: error.block,
                }),
            )
            .finally(() => controllers.delete(message.id));
          return { ok: true };
        }
        return { ok: true };
      }),
    },
  });
});
afterEach(() => {
  for (const controller of controllers.values()) controller.abort();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/background/store');
  vi.doUnmock('../src/background/operations');
});
it('shares the actual one-second clock across offscreen network reads and native navigation', async () => {
  const first = read();
  await vi.advanceTimersByTimeAsync(0);
  await first;
  const second = platform.accessPlatform(() => {
    starts.push(Date.now());
  });
  const third = read(NEXT);
  await vi.advanceTimersByTimeAsync(999);
  expect(starts).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  await second;
  expect(starts).toEqual([0, 1000]);
  await vi.advanceTimersByTimeAsync(1000);
  await third;
  expect(starts).toEqual([0, 1000, 2000]);
});
it('cache hits return immediately without admission or changing the remaining 300ms wait', async () => {
  const first = read();
  await vi.advanceTimersByTimeAsync(0);
  await first;
  await vi.advanceTimersByTimeAsync(700);
  progress.mockClear();
  expect((await read()).source).toBe('cache');
  expect(admissions).toHaveLength(1);
  expect(starts).toEqual([0]);
  expect(progress.mock.calls.some((c) => c[2]?.code === 'platform-wait')).toBe(
    false,
  );
  const second = read(NEXT);
  await vi.advanceTimersByTimeAsync(299);
  expect(starts).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  await second;
  expect(starts).toEqual([0, 1000]);
});
it('does not wait when natural work has already exceeded the interval', async () => {
  const first = read();
  await vi.advanceTimersByTimeAsync(0);
  await first;
  await vi.advanceTimersByTimeAsync(1500);
  progress.mockClear();
  const second = read(NEXT);
  await vi.advanceTimersByTimeAsync(0);
  await second;
  expect(starts).toEqual([0, 1500]);
  expect(progress.mock.calls.some((c) => c[2]?.code === 'platform-wait')).toBe(
    false,
  );
});
it('merges a queued read, transfers live owners, and cancels just one subscriber', async () => {
  await platform.accessPlatform(() => {
    starts.push(Date.now());
  });
  const owner = new AbortController();
  const first = read(URL, owner.signal);
  const cancelled = first.catch((e) => e.message);
  await vi.advanceTimersByTimeAsync(100);
  const second = read();
  await vi.advanceTimersByTimeAsync(0);
  owner.abort();
  expect(await cancelled).toMatch(/取消/);
  await vi.advanceTimersByTimeAsync(900);
  expect((await second).source).toBe('shared');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(admissions).toHaveLength(1);
  expect(starts).toEqual([0, 1000]);
});
it('all subscribers cancelling prevents dispatch, discards late grants, and does not consume another interval', async () => {
  await platform.accessPlatform(() => {
    starts.push(Date.now());
  });
  const a = new AbortController(),
    b = new AbortController();
  const first = read(URL, a.signal).catch((e) => e.message);
  const second = read(URL, b.signal).catch((e) => e.message);
  await vi.advanceTimersByTimeAsync(200);
  expect(admissions).toHaveLength(1);
  a.abort();
  b.abort();
  expect(await first).toMatch(/取消/);
  expect(await second).toMatch(/取消/);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    client.receive({ kind: 'platform-grant', id: admissions[0]!.id, ok: true }),
  ).toEqual({ ok: false });
  const next = read(NEXT);
  await vi.advanceTimersByTimeAsync(800);
  await next;
  expect(starts).toEqual([0, 1000]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('sequential fresh verification performs three distinct reads with no fixed extra wait', async () => {
  const startsRead = async () => {
    for (let i = 0; i < 3; i++) await read(URL, undefined, true);
  };
  const done = startsRead();
  await vi.advanceTimersByTimeAsync(2000);
  await done;
  expect(starts).toEqual([0, 1000, 2000]);
  expect(admissions).toHaveLength(3);
});
it.each(['captcha', '9010', '429'])(
  '%s stops already queued dispatch and cannot be bypassed by a cached result',
  async (kind) => {
    const first = read();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    fetcher.mockImplementationOnce(async () => {
      starts.push(Date.now());
      return kind === '429'
        ? response(NEXT, '限流', 429)
        : kind === '9010'
          ? response(NEXT, '【9010】操作异常，请输入图片中的验证码')
          : response('https://mooc1.chaoxing.com/antispiderShowVerify.ac');
    });
    const blocked = read(NEXT).catch((e) => e.message);
    const queued = read(NEXT + '&more=1').catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await blocked).toMatch(/暂停/);
    expect(await queued).toMatch(/暂停/);
    expect(state.platformBlock).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(read()).rejects.toThrow(/暂停/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
it('account changes invalidate a queued permission and never dispatch its old URL', async () => {
  await platform.accessPlatform(() => {});
  const old = read().catch((e) => e.message);
  await vi.advanceTimersByTimeAsync(200);
  state.accountId = 'b';
  await vi.advanceTimersByTimeAsync(800);
  expect(await old).toMatch(/账号已变化/);
  expect(fetcher).not.toHaveBeenCalled();
});
it('pausing the owning run revokes a queued grant without opening a response channel', async () => {
  state.operations.run = { phase: 'running' } as any;
  await platform.accessPlatform(() => {});
  const job = transport
    .offscreen(
      { op: 'fetch', url: URL, purpose: 'homework-list' },
      undefined,
      'run',
    )
    .catch((e) => e.message);
  await vi.advanceTimersByTimeAsync(100);
  expect(admissions).toHaveLength(1);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'platform-request' }),
  );
  state.operations.run!.phase = 'paused';
  await vi.advanceTimersByTimeAsync(900);
  expect(await job).toMatch(/绑定失效/);
  expect(fetcher).not.toHaveBeenCalled();
});
it('waiting progress is emitted only for the actual remainder and cleared on dispatch', async () => {
  const first = read();
  await vi.advanceTimersByTimeAsync(0);
  await first;
  expect(progress.mock.calls.some((c) => c[2]?.code === 'platform-wait')).toBe(
    false,
  );
  await vi.advanceTimersByTimeAsync(700);
  progress.mockClear();
  const next = read(NEXT);
  await vi.advanceTimersByTimeAsync(0);
  expect(progress).toHaveBeenCalledWith(
    undefined,
    '等待访问间隔',
    expect.objectContaining({ platformWaitUntil: 1000 }),
  );
  await vi.advanceTimersByTimeAsync(300);
  await next;
  const final = progress.mock.calls.at(-1)![2];
  expect(final.waiting).toBeUndefined();
  expect(final.platformWaitUntil).toBeUndefined();
  expect(final.readSource).toBe('network');
});
it('a cancelled non-dispatched action does not advance the pacer clock', async () => {
  const pacer = new RequestPacer(),
    controller = new AbortController();
  const times: number[] = [];
  await pacer.dispatch((started) => {
    started();
    times.push(Date.now());
  });
  const abandoned = pacer
    .dispatch(() => {
      throw new Error('must not dispatch');
    }, controller.signal)
    .catch((e) => e.message);
  await vi.advanceTimersByTimeAsync(700);
  controller.abort();
  expect(await abandoned).toMatch(/取消/);
  const next = pacer.dispatch((started) => {
    started();
    times.push(Date.now());
  });
  await vi.advanceTimersByTimeAsync(300);
  await next;
  expect(times).toEqual([0, 1000]);
});

it('an early browser timer only waits the remaining millisecond before dispatch', async () => {
  const pacer = new RequestPacer();
  const starts: number[] = [];
  const action = (started: (at?: number) => void) => {
    started();
    starts.push(Date.now());
  };
  await pacer.dispatch(action);
  const schedule = globalThis.setTimeout.bind(globalThis);
  let early = true;
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    const delay = early ? ms - 1 : ms;
    early = false;
    return schedule(callback, delay);
  }) as typeof setTimeout);
  try {
    const next = pacer.dispatch(action);
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(starts).toEqual([0, 1000]);
  } finally {
    timer.mockRestore();
  }
});
