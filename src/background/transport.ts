import type { FrameCommand, FrameInfo, OffscreenJob } from '../messages';
import type { PageSnapshot, PlatformBlock } from '../domain';
import { isChaoxingUrl } from '../security';
import { log, state, persist } from './store';
import {
  assertPlatformReady,
  holdPlatform,
  schedulePlatformDispatch,
  recordPlatformRequest,
} from './platform';
import {
  PlatformAccessError,
  platformBlockFor,
  detectVerification,
} from '../platform-access';
import type { ProgressDetail } from '../progress';
import {
  updateOperation,
  heartbeatOperation,
  operationEvent,
} from './operations';
import type { PlatformAdmissionRequest } from '../platform-admission';
import { matchesTaskFrameKey } from '../task-context';

export interface FrameRef extends FrameInfo {
  parentFrameId?: number;
  documentId?: string;
  tabId: number;
  frameId: number;
}
export const frames = new Map<string, FrameRef>();
const frameProbedAt = new Map<number, number>();
const frameEpoch = new Map<number, number>();
const frameWaiters = new Set<() => void>();
export function notifyFrameRegistry(tabId?: number): void {
  if (tabId !== undefined) frameProbedAt.set(tabId, Date.now());
  for (const wake of [...frameWaiters]) wake();
}
export function invalidateLearningFrames(tabId: number, frameId = 0): void {
  frameEpoch.set(tabId, (frameEpoch.get(tabId) ?? 0) + 1);
  frameProbedAt.delete(tabId);
  const invalid = new Set([frameId]);
  for (let pass = 0; pass < frames.size; pass++)
    for (const ref of frames.values())
      if (
        ref.tabId === tabId &&
        ref.parentFrameId !== undefined &&
        invalid.has(ref.parentFrameId)
      )
        invalid.add(ref.frameId);
  for (const [key, ref] of frames)
    if (ref.tabId === tabId && (frameId === 0 || invalid.has(ref.frameId)))
      frames.delete(key);
  notifyFrameRegistry();
}
export async function frameChangeOrTimeout(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      frameWaiters.delete(wake);
      signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve();
    };
    const wake = () => finish();
    const cancel = () => finish(new Error('操作已取消'));
    const timer = setTimeout(wake, ms);
    frameWaiters.add(wake);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
let creatingOffscreen: Promise<void> | undefined;
const pending = new Map<
  string,
  {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    watchdog: ReturnType<typeof setInterval>;
    lastHeartbeat: number;
    runId?: string;
    sequence: number;
    fetch?: Extract<OffscreenJob, { op: 'fetch' }>;
    signal?: AbortSignal;
    platformWaitUntil?: number;
  }
>();
export function finishJob(
  id: string,
  message: { ok: boolean; value?: any; error?: string; block?: PlatformBlock },
): void {
  const entry = pending.get(id);
  if (!entry) return;
  if (entry.fetch && message.ok) {
    if (state.platformBlock)
      message = { ok: false, block: state.platformBlock };
    else if (entry.fetch.scope !== state.accountId)
      message = { ok: false, error: '登录账号已变化，读取结果已丢弃' };
  }
  clearTimeout(entry.timer);
  clearInterval(entry.watchdog);
  pending.delete(id);
  operationEvent(
    entry.runId,
    message.ok ? '后台处理结束' : (message.error ?? '后台处理失败'),
    { code: message.ok ? 'job-end' : 'job-error' },
    message.ok ? 'info' : 'warn',
  );
  if (message.ok) entry.resolve(message.value);
  else if (message.block) {
    void holdPlatform(message.block);
    entry.reject(new PlatformAccessError(message.block));
  } else entry.reject(new Error(message.error ?? '后台处理失败'));
}
export function jobHeartbeat(
  id: string,
  note = '',
  detail?: ProgressDetail,
  sequence = 0,
  events?: { note: string; detail?: ProgressDetail }[],
): boolean {
  const entry = pending.get(id);
  if (!entry || (sequence && sequence <= entry.sequence)) return false;
  entry.sequence = sequence || entry.sequence + 1;
  entry.lastHeartbeat = Date.now();
  heartbeatOperation(entry.runId);
  for (const event of events?.slice(0, -1) ?? [])
    operationEvent(entry.runId, event.note, event.detail);
  if (note) {
    if (
      entry.fetch &&
      entry.platformWaitUntil !== undefined &&
      detail?.code === 'platform-shared'
    )
      detail = {
        ...detail,
        waiting: 'platform',
        platformWaitUntil: entry.platformWaitUntil,
      };
    updateOperation(entry.runId, note, detail);
  }
  return true;
}
export async function offscreen<T>(
  job: OffscreenJob,
  signal?: AbortSignal,
  runId?: string,
): Promise<T> {
  if (!runId)
    runId = Object.values(state.operations ?? {}).find(
      (r) =>
        r.phase === 'running' &&
        (['fetch', 'parse'].includes(job.op)
          ? r.kind === 'scan' || r.kind === 'queue' || r.kind === 'manual'
          : r.kind === 'queue' || r.kind === 'manual'),
    )?.id;
  if (job.op !== 'test') assertPlatformReady();
  if (signal?.aborted) throw new Error('操作已取消');
  if (!creatingOffscreen)
    creatingOffscreen = (async () => {
      if (!(await chrome.offscreen.hasDocument()))
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: [
            chrome.offscreen.Reason.WORKERS,
            chrome.offscreen.Reason.DOM_PARSER,
            chrome.offscreen.Reason.BLOBS,
          ],
          justification: '在本机还原课程文字、解析只读页面并处理模型请求',
        });
    })().finally(() => {
      creatingOffscreen = undefined;
    });
  await creatingOffscreen;
  if (job.op !== 'test') assertPlatformReady();
  if (job.op === 'fetch') {
    if (job.scope !== undefined && job.scope !== state.accountId)
      throw new Error('登录账号已变化');
    job = { ...job, scope: state.accountId };
  }
  if (signal?.aborted) throw new Error('操作已取消');
  const id = crypto.randomUUID();
  operationEvent(runId, `后台作业开始：${job.op}`, { code: 'job-start' });
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      void chrome.runtime
        .sendMessage({ target: 'offscreen', kind: 'cancel', id })
        .catch(() => {});
      finishJob(id, { ok: false, error: '操作已取消' });
    };
    const timer = setTimeout(
      () => {
        void chrome.runtime
          .sendMessage({ target: 'offscreen', kind: 'cancel', id })
          .catch(() => {});
        finishJob(id, { ok: false, error: '后台处理已达到超时限制' });
      },
      job.op === 'restore' ? 1800000 : 900000,
    );
    const watchdog = setInterval(() => {
      const entry = pending.get(id);
      if (entry && Date.now() - entry.lastHeartbeat >= 60000) {
        void chrome.runtime
          .sendMessage({ target: 'offscreen', kind: 'cancel', id })
          .catch(() => {});
        finishJob(id, {
          ok: false,
          error: '后台心跳中断超过 60 秒，流程已暂停',
        });
      }
    }, 5000);
    pending.set(id, {
      resolve: (value) => {
        signal?.removeEventListener('abort', cancel);
        resolve(value);
      },
      reject: (error) => {
        signal?.removeEventListener('abort', cancel);
        reject(error);
      },
      timer,
      watchdog,
      lastHeartbeat: Date.now(),
      runId,
      sequence: 0,
      fetch: job.op === 'fetch' ? job : undefined,
      signal,
    });
    signal?.addEventListener('abort', cancel, { once: true });
    chrome.runtime
      .sendMessage({ target: 'offscreen', kind: 'job', id, job })
      .then(
        (ack) => {
          if (!ack?.ok)
            finishJob(id, { ok: false, error: '后台页面未能接收请求' });
        },
        (error) => finishJob(id, { ok: false, error: '无法连接后台页面' }),
      );
  });
}

const admissions = new Map<string, AbortController>();
function admissionMessage(message: unknown, signal: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(new Error('操作已取消'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      reject(new Error('平台调度通信超过 3 秒没有响应'));
    }, 3000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) return cancel();
    chrome.runtime
      .sendMessage(message)
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      });
  });
}
function admissionJobs(request: PlatformAdmissionRequest, ids: unknown) {
  return Array.isArray(ids)
    ? ids.flatMap((id) => {
        const entry = typeof id === 'string' ? pending.get(id) : undefined;
        const job = entry?.fetch;
        const run = entry?.runId ? state.operations?.[entry.runId] : undefined;
        return entry &&
          job &&
          !entry.signal?.aborted &&
          (!run || run.phase === 'running') &&
          job.scope === request.scope &&
          job.url === request.url &&
          job.purpose === request.purpose &&
          !!job.fresh === request.fresh
          ? [entry]
          : [];
      })
    : [];
}
export function cancelPlatformAdmission(id: string): void {
  admissions.get(id)?.abort();
}
export function requestPlatformAdmission(
  request: PlatformAdmissionRequest,
): boolean {
  if (
    typeof request.id !== 'string' ||
    admissions.has(request.id) ||
    request.scope !== state.accountId ||
    !admissionJobs(request, request.jobIds).length
  )
    return false;
  const controller = new AbortController();
  admissions.set(request.id, controller);
  let entries = admissionJobs(request, request.jobIds);
  void schedulePlatformDispatch(
    async (started) => {
      const sentAt = Date.now();
      let ack;
      try {
        ack = await admissionMessage(
          {
            target: 'offscreen',
            kind: 'platform-grant',
            id: request.id,
            ok: true,
          },
          controller.signal,
        );
      } catch (error) {
        // A lost acknowledgement may follow a real dispatch; conservatively pace the next action.
        started(Date.now());
        throw error;
      }
      if (
        !ack?.ok ||
        !Number.isFinite(ack.startedAt) ||
        ack.startedAt < sentAt ||
        ack.startedAt > Date.now()
      )
        throw new Error('平台读取已取消，未派发请求');
      started(ack.startedAt);
      for (const entry of entries) entry.platformWaitUntil = undefined;
      for (const runId of new Set(entries.map((entry) => entry.runId)))
        recordPlatformRequest(runId);
    },
    {
      signal: controller.signal,
      accountId: request.scope,
      check: async () => {
        const status = await admissionMessage(
          { target: 'offscreen', kind: 'platform-check', id: request.id },
          controller.signal,
        );
        entries = admissionJobs(request, status?.jobIds);
        if (!status?.ok || !entries.length)
          throw new Error('平台读取已取消或运行绑定失效');
      },
      waiting: (until, elapsedMs) => {
        for (const entry of entries) entry.platformWaitUntil = until;
        for (const runId of new Set(entries.map((entry) => entry.runId))) {
          if (until !== undefined)
            updateOperation(runId, '等待访问间隔', {
              code: 'platform-wait',
              waiting: 'platform',
              platformWaitUntil: until,
            });
          else {
            operationEvent(runId, '访问间隔等待结束', {
              code: 'platform-wait-end',
              durationMs: elapsedMs,
            });
            updateOperation(runId, '正在读取平台页面', {
              waiting: 'page',
              platformWaitUntil: undefined,
            });
          }
        }
      },
    },
  )
    .catch((error) => {
      void chrome.runtime
        .sendMessage({
          target: 'offscreen',
          kind: 'platform-grant',
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : '平台访问已中断',
          block: error instanceof PlatformAccessError ? error.block : undefined,
        })
        .catch(() => {});
    })
    .finally(() => admissions.delete(request.id));
  return true;
}
export class FrameCommunicationError extends Error {
  constructor(
    public readonly code: 'frame-disconnected' | 'frame-timeout',
    message: string,
  ) {
    super(message);
  }
}
export async function frameCall<T>(
  ref: Pick<FrameRef, 'tabId' | 'frameId' | 'documentId'>,
  command: FrameCommand,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const runId =
    command.op === 'video-play' || command.op === 'reader-start'
      ? command.binding.runId
      : command.op !== 'describe'
        ? Object.values(state.operations ?? {}).find(
            (r) => r.phase === 'running' && r.kind !== 'test',
          )?.id
        : undefined;
  const started = Date.now();
  if (options.signal?.aborted) throw new Error('操作已取消');
  operationEvent(runId, `页面操作开始：${command.op}`, { code: 'frame-start' });
  if (!['describe', 'video-pause', 'reader-pause'].includes(command.op))
    assertPlatformReady();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const timeoutMs =
    options.timeoutMs ??
    (command.op === 'describe' ||
    ((command.op === 'video-play' || command.op === 'reader-start') &&
      command.deferred)
      ? 3000
      : 30000);
  const heartbeat = setInterval(() => heartbeatOperation(runId), 5000);
  const response = await Promise.race([
    chrome.tabs
      .sendMessage(
        ref.tabId,
        { target: 'content', command },
        ref.documentId
          ? { documentId: ref.documentId }
          : { frameId: ref.frameId },
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /message (?:channel|port).*closed|receiving end does not exist|could not establish connection|no frame|no document|extension context invalidated/i.test(
            message,
          )
        )
          throw new FrameCommunicationError(
            'frame-disconnected',
            '页面通信中断，页面可能已刷新或正在加载，请重新连接后重试',
          );
        throw error;
      }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new FrameCommunicationError(
              'frame-timeout',
              `页面操作等待超过 ${Math.ceil(timeoutMs / 1000)} 秒，请检查页面后继续`,
            ),
          ),
        timeoutMs,
      );
      cancel = () => reject(new Error('操作已取消'));
      options.signal?.addEventListener('abort', cancel, { once: true });
    }),
  ])
    .catch((error) => {
      operationEvent(
        runId,
        error instanceof Error ? error.message : '页面通信失败',
        {
          code: 'frame-error',
          durationMs: Date.now() - started,
        },
        'warn',
      );
      throw error;
    })
    .finally(() => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (cancel) options.signal?.removeEventListener('abort', cancel);
    });
  if (response?.block) {
    await holdPlatform(response.block);
    throw new PlatformAccessError(response.block);
  }
  if (!response?.ok)
    throw Object.assign(new Error(response?.error ?? '页面没有响应'), {
      code: response?.errorCode,
    });
  operationEvent(runId, `页面操作完成：${command.op}`, {
    code: 'frame-end',
    durationMs: Date.now() - started,
  });
  heartbeatOperation(runId);
  return response.value as T;
}
export async function discoverFrames(
  tabId?: number,
  signal?: AbortSignal,
  cached = false,
): Promise<FrameRef[]> {
  if (signal?.aborted) throw new Error('操作已取消');
  if (
    cached &&
    tabId !== undefined &&
    Date.now() - (frameProbedAt.get(tabId) ?? -Infinity) < 1000
  ) {
    const known = [...frames.values()].filter((f) => f.tabId === tabId);
    assertFramesAccessible(known);
    return known;
  }
  if (cached && tabId !== undefined) {
    const known = [...frames.values()].filter((f) => f.tabId === tabId);
    assertFramesAccessible(known);
  }
  const tabs =
    tabId !== undefined
      ? [{ id: tabId }]
      : await chrome.tabs.query({ url: ['https://*.chaoxing.com/*'] });
  const found: FrameRef[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const targetTabId = tab.id;
    const epoch = frameEpoch.get(targetTabId) ?? 0;
    frameProbedAt.set(targetTabId, Date.now());
    const all = await chrome.webNavigation
      .getAllFrames({ tabId: tab.id })
      .catch(() => null);
    if (all && epoch === (frameEpoch.get(targetTabId) ?? 0)) {
      for (const [key, ref] of frames) {
        if (
          ref.tabId === targetTabId &&
          !all.some(
            (f) =>
              f.frameId === ref.frameId &&
              (!ref.documentId ||
                !f.documentId ||
                f.documentId === ref.documentId),
          )
        )
          frames.delete(key);
      }
    }
    const described = await Promise.all(
      (all ?? []).map(async (frame): Promise<FrameRef | undefined> => {
        if (signal?.aborted) throw new Error('操作已取消');
        if (!isChaoxingUrl(frame.url)) return;
        if (detectVerification(frame.url)) {
          return {
            url: frame.url,
            tabId: targetTabId,
            frameId: frame.frameId,
            documentId: frame.documentId,
            top: frame.frameId === 0,
            loginRequired: false,
            verificationRequired: true,
          };
        }
        try {
          const info = await frameCall<FrameInfo>(
            {
              tabId: targetTabId,
              frameId: frame.frameId,
              documentId: frame.documentId,
            },
            { op: 'describe' },
            { signal },
          );
          const ref = {
            ...info,
            tabId: targetTabId,
            frameId: frame.frameId,
            documentId: frame.documentId,
            parentFrameId: frame.parentFrameId,
          };
          const newer = frames.get(`${tab.id}:${frame.frameId}`);
          if (
            epoch === (frameEpoch.get(targetTabId) ?? 0) &&
            (!newer?.documentId || newer.documentId === frame.documentId)
          )
            frames.set(`${tab.id}:${frame.frameId}`, ref);
          return ref;
        } catch {
          /* Frame is still navigating or has no content script. */
        }
      }),
    );
    if (signal?.aborted) throw new Error('操作已取消');
    if (epoch === (frameEpoch.get(targetTabId) ?? 0))
      found.push(...described.filter((f): f is FrameRef => !!f));
  }
  return found;
}
export async function waitForFrames(
  tabId: number,
  predicate: (f: FrameRef) => boolean,
  signal?: AbortSignal,
  timeout = 30000,
  cached = false,
): Promise<FrameRef[]> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (signal?.aborted) throw new Error('操作已取消');
    const all = await discoverFrames(tabId, signal, cached);
    assertFramesAccessible(all);
    const matched = all.filter(predicate);
    if (matched.length) return matched;
    if (cached)
      await frameChangeOrTimeout(Math.min(1000, end - Date.now()), signal);
    else await delay(650, signal);
  }
  throw new Error('页面加载超时，请检查登录或手动打开任务');
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('操作已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error('操作已取消'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
export async function taskFrame(
  tabId: number,
  platformId: string,
  signal?: AbortSignal,
  expectedTaskKey?: string,
  knownTaskKey?: string,
): Promise<{ ref: FrameRef; page: PageSnapshot }> {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (signal?.aborted) throw new Error('操作已取消');
    const all = await discoverFrames(tabId);
    assertFramesAccessible(all);
    if (all.some((f) => f.loginRequired))
      throw new Error('登录已失效，请重新登录');
    for (const ref of all.filter(
      (f) =>
        f.adapter &&
        (expectedTaskKey
          ? matchesTaskFrameKey(f, expectedTaskKey, knownTaskKey)
          : f.taskKey?.endsWith(`:work:${platformId}`)) &&
        f.taskKind !== 'exam',
    )) {
      const page = await frameCall<PageSnapshot | undefined>(ref, {
        op: 'extract',
      });
      if (page) return { ref, page };
    }
    await delay(700, signal);
  }
  throw new Error('未找到对应答题页面，请从任务入口打开后重试');
}
export function assertFramesAccessible(all: FrameRef[]): void {
  assertPlatformReady();
  const challenge = all.find((f) => f.verificationRequired);
  if (challenge) {
    const block = {
      ...platformBlockFor(challenge.url),
      tabId: challenge.tabId,
    };
    void holdPlatform(block);
    throw new PlatformAccessError(block);
  }
}
