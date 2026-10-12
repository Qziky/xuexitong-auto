import { state } from './store';
import { assertPlatformReady } from './platform';
import { PlatformAccessError, platformBlockFor } from '../platform-access';
import type { FrameRef } from './transport';
import { FrameAccountError } from './frame-account';
import {
  beginOperation,
  updateOperation,
  finishOperation,
  heartbeatOperation,
} from './operations';

let active: AbortController | undefined;
let idle: Promise<void> = Promise.resolve();
let resolveIdle: (() => void) | undefined;
let runId: string | undefined;
export function scanOperationId(): string | undefined {
  return runId;
}
export function beginScan(title = '刷新课程进度和作业'): AbortController {
  assertPlatformReady();
  if (active) throw new Error('已有扫描正在进行，请等待完成或取消');
  if (state.queue.phase === 'running')
    throw new Error('请先暂停答题队列，再读取课程');
  if (
    Object.values(state.operations ?? {}).some(
      (r) => r.kind === 'manual' && r.phase === 'running',
    )
  )
    throw new Error('请先结束当前任务步骤，再读取课程');
  active = new AbortController();
  runId = beginOperation('scan', title);
  idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  return active;
}
export function scanRunning(): boolean {
  return Boolean(active);
}
export function cancelScan(reason = '扫描已取消'): void {
  active?.abort(new Error(reason));
}
export function endScan(controller: AbortController): void {
  if (active === controller) {
    void finishOperation(
      runId,
      state.scan.phase === 'done'
        ? 'done'
        : state.scan.phase === 'blocked'
          ? 'paused'
          : controller.signal.aborted
            ? 'cancelled'
            : 'error',
      state.scan.note,
    );
    runId = undefined;
    active = undefined;
    resolveIdle?.();
    resolveIdle = undefined;
  }
}
export async function cancelScanAndWait(): Promise<void> {
  cancelScan('开始执行任务，已停止只读刷新');
  await idle;
}
export function checkScan(signal: AbortSignal, accountId?: string): void {
  heartbeatOperation(runId);
  updateOperation(runId, state.scan.note, {
    code: 'scan-progress',
    done: state.scan.completed,
    total: state.scan.total,
  });
  assertPlatformReady();
  if (signal.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('扫描已取消');
  if (accountId && state.accountId !== accountId)
    throw new Error('登录账号已变化，请重新刷新进度');
}
export function checkFrames(all: FrameRef[], expected?: string): void {
  const challenge = all.find((frame) => frame.verificationRequired);
  if (challenge)
    throw new PlatformAccessError({
      ...platformBlockFor(challenge.url),
      tabId: challenge.tabId,
    });
  const identities = [
    ...new Set(
      all
        .filter((frame) => !frame.loginRequired)
        .map((frame) => frame.accountId)
        .filter(Boolean),
    ),
  ];
  if (
    all.some((frame) => frame.loginRequired) &&
    (expected || !identities.length)
  )
    throw new FrameAccountError(
      'login-required',
      '登录已失效，请重新登录后继续',
    );
  if (identities.length > 1)
    throw new FrameAccountError(
      'multiple-accounts',
      '检测到多个登录账号，请仅保留目标账号的学习通页面',
    );
  if (!identities.length)
    throw new FrameAccountError(
      'account-unconfirmed',
      '当前页面尚未提供账号信息，请保持已登录的个人中心打开后继续',
    );
  if (expected && identities[0] !== expected)
    throw new FrameAccountError(
      'account-changed',
      '登录账号已变化，请重新刷新课程后继续',
    );
}
