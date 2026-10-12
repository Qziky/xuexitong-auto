import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
const mock = vi.hoisted(() => ({
  store: { state: undefined as any, log: vi.fn(), persist: vi.fn() },
  event: vi.fn(),
  heartbeat: vi.fn(),
  progress: vi.fn(),
}));
vi.mock('../src/background/store', () => mock.store);
vi.mock('../src/background/operations', () => ({
  operationEvent: mock.event,
  heartbeatOperation: mock.heartbeat,
  updateOperation: mock.progress,
}));
vi.mock('../src/background/platform', () => ({
  assertPlatformReady: vi.fn(),
  schedulePlatformDispatch: vi.fn(),
  holdPlatform: vi.fn(),
}));
import {
  offscreen,
  jobHeartbeat,
  finishJob,
} from '../src/background/transport';
let jobId = '';
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  jobId = '';
  mock.store.state = initialState();
  vi.stubGlobal('chrome', {
    offscreen: { hasDocument: vi.fn(async () => true) },
    runtime: {
      sendMessage: vi.fn(async (m) => {
        if (m.kind === 'job') jobId = m.id;
        return { ok: true };
      }),
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function dispatched() {
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(jobId).toBeTruthy();
}
describe('真实后台传输的心跳与迟到消息', () => {
  it('活跃心跳维持长请求，不把心跳写入步骤日志', async () => {
    const job = offscreen(
      { op: 'test', provider: {} as any },
      undefined,
      'run',
    );
    await dispatched();
    const n = mock.event.mock.calls.length;
    for (let i = 1; i <= 14; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      jobHeartbeat(jobId, '', undefined, i);
    }
    expect(mock.event).toHaveBeenCalledTimes(n);
    finishJob(jobId, { ok: true, value: 'done' });
    expect(await job).toBe('done');
    expect(mock.heartbeat).toHaveBeenCalledTimes(14);
    expect(jobHeartbeat(jobId, 'late', { done: 99 }, 15)).toBe(false);
  });
  it('60 秒缺失心跳取消相应作业，迟到响应和进度不会串到另一操作', async () => {
    const job = offscreen(
      { op: 'test', provider: {} as any },
      undefined,
      'old',
    );
    const result = job.catch((e) => e.message);
    await dispatched();
    const oldId = jobId;
    await vi.advanceTimersByTimeAsync(60000);
    expect(await result).toMatch(/心跳中断/);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      kind: 'cancel',
      id: oldId,
    });
    const other = offscreen(
      { op: 'test', provider: {} as any },
      undefined,
      'new',
    );
    await dispatched();
    expect(jobId).not.toBe(oldId);
    expect(jobHeartbeat(oldId, '迟到', { done: 10 }, 2)).toBe(false);
    finishJob(oldId, { ok: true, value: 'wrong' });
    finishJob(jobId, { ok: true, value: 'right' });
    expect(await other).toBe('right');
    expect(mock.progress).not.toHaveBeenCalled();
  });
  it('取消后拒绝消息，重复或逆序的序号不回滚进度', async () => {
    const controller = new AbortController();
    const job = offscreen(
      { op: 'test', provider: {} as any },
      controller.signal,
      'run',
    );
    const result = job.catch((e) => e.message);
    await dispatched();
    expect(jobHeartbeat(jobId, '步骤', { done: 2 }, 2)).toBe(true);
    expect(jobHeartbeat(jobId, '旧步骤', { done: 1 }, 1)).toBe(false);
    controller.abort();
    expect(await result).toMatch(/取消/);
    expect(jobHeartbeat(jobId, '迟到', { done: 3 }, 3)).toBe(false);
    expect(mock.progress).toHaveBeenCalledTimes(1);
  });
});
