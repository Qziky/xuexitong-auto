import { state, persist, log } from './store';
import type { PlatformBlock } from '../domain';
import { operationEvent, updateOperation } from './operations';
import { releaseLearningForeground } from './learning-foreground';
import {
  detectVerification,
  PlatformAccessError,
  RequestPacer,
} from '../platform-access';

const pacer = new RequestPacer();
export function assertPlatformReady(): void {
  if (state.platformBlock) throw new PlatformAccessError(state.platformBlock);
}
export interface PlatformActionOptions {
  signal?: AbortSignal;
  runId?: string;
  accountId?: string;
  check?: () => void | Promise<void>;
  note?: string;
  waiting?: (until: number | undefined, elapsedMs: number) => void;
}
export function schedulePlatformDispatch<T>(
  action: (started: (at?: number) => void) => T | Promise<T>,
  options: PlatformActionOptions = {},
): Promise<T> {
  const accountId = options.accountId ?? state.accountId;
  return pacer.dispatch(action, options.signal, {
    check: async () => {
      assertPlatformReady();
      if (accountId !== state.accountId)
        throw new Error('登录账号已变化，平台访问已取消');
      const run = options.runId ? state.operations?.[options.runId] : undefined;
      if (run && run.phase !== 'running') throw new Error('运行已暂停或结束');
      await options.check?.();
      assertPlatformReady();
      if (accountId !== state.accountId)
        throw new Error('登录账号已变化，平台访问已取消');
    },
    waiting:
      options.waiting ??
      ((until, elapsedMs) => {
        if (until !== undefined)
          updateOperation(options.runId, '等待访问间隔', {
            code: 'platform-wait',
            waiting: 'platform',
            platformWaitUntil: until,
          });
        else {
          operationEvent(options.runId, '访问间隔等待结束', {
            code: 'platform-wait-end',
            durationMs: elapsedMs,
          });
          updateOperation(options.runId, options.note ?? '正在读取平台页面', {
            waiting: undefined,
            platformWaitUntil: undefined,
          });
        }
      }),
  });
}
export function accessPlatform<T>(
  action: () => T | Promise<T>,
  options: PlatformActionOptions = {},
): Promise<T> {
  return schedulePlatformDispatch((started) => {
    started();
    recordPlatformRequest(options.runId, options.note);
    return action();
  }, options);
}
export function recordPlatformRequest(
  runId?: string,
  note = '正在读取平台页面',
): void {
  const run = runId ? state.operations?.[runId] : undefined;
  updateOperation(runId, note, {
    code: 'platform-dispatch',
    waiting: 'page',
    platformWaitUntil: undefined,
    readSource: 'network',
    platformRequests: (run?.platformRequests ?? 0) + 1,
  });
}
export async function holdPlatform(block: PlatformBlock): Promise<void> {
  // Platform gates stop work immediately, even before the learning runner's
  // asynchronous interruption handler gets a chance to run.
  releaseLearningForeground(state.learning.id);
  if (state.learning.phase === 'running') {
    state.learning.phase = 'paused';
    state.learning.note = block.message;
    void import('./learning').then((m) => m.interruptLearning(block.message));
    if (
      state.learning.tabId !== undefined &&
      state.learning.frameId !== undefined
    )
      void import('./transport').then((m) =>
        m
          .frameCall(
            { tabId: state.learning.tabId!, frameId: state.learning.frameId! },
            { op: 'video-pause' },
          )
          .catch(() => {}),
      );
  }
  const previous = state.platformBlock;
  state.platformBlock = previous
    ? {
        ...(block.kind === 'captcha' && previous.kind !== 'captcha'
          ? block
          : previous),
        url:
          previous.url && detectVerification(previous.url)
            ? previous.url
            : block.kind === 'captcha'
              ? (block.url ?? previous.url)
              : previous.url,
        tabId: block.tabId ?? previous.tabId,
        retryAfter:
          Math.max(block.retryAfter ?? 0, previous.retryAfter ?? 0) ||
          undefined,
      }
    : block;
  if (state.queue.phase === 'running') {
    state.queue.phase = 'paused';
    state.queue.note = state.platformBlock.message;
    const item = state.queue.items[state.queue.index];
    if (item) {
      item.stage = item.submitAttempted ? 'verifying' : 'waiting';
      item.note = state.platformBlock.message;
    }
  }
  if (!previous) log(block.message, 'warn');
  await persist(true);
}
export function rethrowPlatformBlock(error: unknown): void {
  if (error instanceof PlatformAccessError) {
    void holdPlatform(error.block);
    throw error;
  }
  assertPlatformReady();
}
export async function releasePlatformHold(): Promise<void> {
  if (
    state.platformBlock?.retryAfter &&
    Date.now() < state.platformBlock.retryAfter
  ) {
    throw new Error(
      `平台要求等待至 ${new Date(state.platformBlock.retryAfter).toLocaleTimeString('zh-CN')}，请稍后继续`,
    );
  }
  state.platformBlock = undefined;
  if (state.scan.phase === 'blocked') state.scan.phase = 'idle';
  log('用户确认恢复平台访问');
  await persist(true);
}
