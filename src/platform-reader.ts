import { isChaoxingUrl } from './security';
import { taskIdentifiers } from './task-context';
import {
  isCourseListUrl,
  isCourseShellUrl,
  isHomeworkListUrl,
} from './scan-cache';
import { inertDocument } from './scan-parser';
import {
  assertPlatformPage,
  PlatformAccessError,
  platformBlockFor,
  retryAfterTime,
} from './platform-access';
import type { ProgressSink } from './progress';

export interface PlatformRead {
  html: string;
  url: string;
  source?: 'page' | 'cache' | 'network' | 'shared';
}
export type PlatformReadPurpose =
  'catalog' | 'navigation' | 'homework-list' | 'result' | 'learning';
export interface NetworkReadContext {
  url: string;
  scope?: string;
  purpose?: PlatformReadPurpose;
  fresh: boolean;
  signal: AbortSignal;
  jobIds(): string[];
}
export interface PlatformReadOptions {
  jobId?: string;
  progress?: ProgressSink;
  network?: (
    context: NetworkReadContext,
    start: () => Promise<Response>,
  ) => Promise<Response>;
}
interface ReadSubscriber {
  options: PlatformReadOptions;
  shared: boolean;
}
interface InflightRead {
  controller: AbortController;
  subscribers: Set<ReadSubscriber>;
  result: Promise<PlatformRead>;
}
export function allowedPlatformRead(
  url: string,
  purpose?: 'catalog' | 'navigation' | 'homework-list' | 'result' | 'learning',
): boolean {
  if (!isChaoxingUrl(url)) return false;
  if (purpose === 'learning')
    return /\/(?:mycourse\/(?:stu|studentstudy|stucoursemiddle|studentcourse)|knowledge\/cards)$/.test(
      new URL(url).pathname,
    );
  if (purpose === 'catalog') return isCourseListUrl(url);
  if (purpose === 'navigation') return isCourseShellUrl(url);
  if (purpose === 'homework-list') return isHomeworkListUrl(url);
  const result =
    /\/(?:work\/(?:task|view|dowork|review)|api\/work|ananas\/modules\/work\/index\.html)$/.test(
      new URL(url).pathname,
    );
  if (purpose === 'result') {
    if (result) return true;
    const address = new URL(url);
    if (!/\/work\/(?:doHomeWorkNew|prompt)$/.test(address.pathname)) return false;
    const ids = taskIdentifiers(url);
    if (!ids.course || !ids.clazz || !ids.work) return false;
    return !/\/prompt$/.test(address.pathname) || /^[1-9]\d*$/.test(address.searchParams.get('answerId') ?? '');
  }
  return (
    isCourseListUrl(url) ||
    isCourseShellUrl(url) ||
    isHomeworkListUrl(url) ||
    result
  );
}
export class PlatformReader {
  private scope?: string;
  private generation = 0;
  private cache = new Map<
    string,
    { read: PlatformRead; expires: number; startedAt: number }
  >();
  private inflight = new Map<string, InflightRead>();
  private chars = 0;
  async read(
    url: string,
    signal: AbortSignal,
    scope?: string,
    fresh = false,
    purpose?: PlatformReadPurpose,
    options: PlatformReadOptions = {},
  ): Promise<PlatformRead> {
    if (!allowedPlatformRead(url, purpose))
      throw new Error('扫描地址不在允许的只读页面范围内');
    if (signal.aborted) throw new Error('操作已取消');
    if (scope !== this.scope) {
      this.cache.clear();
      this.chars = 0;
      this.scope = scope;
      this.generation++;
    }
    const cacheKey = JSON.stringify([scope, purpose, url]);
    const cached = this.cache.get(cacheKey);
    if (
      scope &&
      !fresh &&
      cached &&
      cached.expires > Date.now() &&
      allowedPlatformRead(cached.read.url, purpose)
    ) {
      options.progress?.('使用缓存', {
        code: 'platform-cache',
        readSource: 'cache',
        waiting: undefined,
        platformWaitUntil: undefined,
      });
      return { ...cached.read, source: 'cache' };
    }
    const generation = this.generation;
    const key = JSON.stringify([generation, scope, purpose, url, fresh]);
    let entry = this.inflight.get(key);
    const subscriber: ReadSubscriber = {
      options,
      shared: !!entry && !entry.controller.signal.aborted,
    };
    if (!entry || entry.controller.signal.aborted) {
      entry = {
        controller: new AbortController(),
        subscribers: new Set(),
        result: undefined!,
      };
      this.inflight.set(key, entry);
      const current = entry;
      const context: NetworkReadContext = {
        url,
        scope,
        purpose,
        fresh,
        signal: current.controller.signal,
        jobIds: () =>
          [...current.subscribers].flatMap((s) =>
            s.options.jobId ? [s.options.jobId] : [],
          ),
      };
      current.result = Promise.resolve().then(() =>
        this.fetchRead(context, cacheKey, current, generation, options.network),
      );
      void current.result
        .finally(() => {
          if (this.inflight.get(key) === current) this.inflight.delete(key);
        })
        .catch(() => {});
    }
    const current = entry;
    current.subscribers.add(subscriber);
    if (subscriber.shared)
      options.progress?.('共享正在进行的页面读取', {
        code: 'platform-shared',
        readSource: 'shared',
        waiting: 'page',
        platformWaitUntil: undefined,
      });
    return new Promise<PlatformRead>((resolve, reject) => {
      let settled = false;
      const leave = () => {
        current.subscribers.delete(subscriber);
        signal.removeEventListener('abort', cancel);
        if (!current.subscribers.size) {
          current.controller.abort();
          if (this.inflight.get(key) === current) this.inflight.delete(key);
        }
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        leave();
        reject(new Error('操作已取消'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      current.result.then(
        (read) => {
          if (settled) return;
          settled = true;
          leave();
          options.progress?.(
            subscriber.shared ? '共享读取完成' : '页面读取完成',
            {
              code: 'platform-read-end',
              readSource: subscriber.shared ? 'shared' : 'network',
              waiting: undefined,
              platformWaitUntil: undefined,
            },
          );
          resolve({
            ...read,
            source: subscriber.shared ? 'shared' : 'network',
          });
        },
        (error) => {
          if (settled) return;
          settled = true;
          leave();
          reject(error);
        },
      );
    });
  }
  private async fetchRead(
    context: NetworkReadContext,
    cacheKey: string,
    entry: InflightRead,
    generation: number,
    network?: PlatformReadOptions['network'],
  ): Promise<PlatformRead> {
    const { url, scope, signal, purpose } = context;
    let startedAt = 0;
    const start = () => {
      if (signal.aborted) throw new Error('操作已取消');
      if (scope !== this.scope || generation !== this.generation)
        throw new Error('登录账号已变化，页面读取已取消');
      startedAt = Date.now();
      for (const subscriber of entry.subscribers)
        subscriber.options.progress?.(
          subscriber.shared ? '共享正在进行的页面读取' : '正在读取平台页面',
          {
            code: 'platform-fetch-start',
            readSource: subscriber.shared ? 'shared' : 'network',
            waiting: 'page',
            platformWaitUntil: undefined,
          },
        );
      return fetch(url, {
        credentials: 'include',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        cache: 'no-store',
      });
    };
    const response = network ? await network(context, start) : await start();
    if (!isChaoxingUrl(response.url))
      throw new Error('页面跳转到站外，可能需要重新登录');
    if (response.status === 429)
      throw new PlatformAccessError(
        platformBlockFor(
          response.url,
          'rate-limit',
          retryAfterTime(response.headers.get('Retry-After')),
        ),
      );
    assertPlatformPage(response.url);
    if (!allowedPlatformRead(response.url, purpose))
      throw new Error('页面跳转超出当前读取范围');
    const html = await response.text();
    if (signal.aborted) throw new Error('操作已取消');
    if (html.length > 12000000) throw new Error('页面内容超过大小限制');
    assertPlatformPage(response.url, inertDocument(html));
    if (!response.ok)
      throw new Error(`读取页面失败（HTTP ${response.status}）`);
    const read = { html, url: response.url };
    const cached = this.cache.get(cacheKey);
    if (
      scope &&
      this.scope === scope &&
      generation === this.generation &&
      html.length <= 1000000 &&
      (!cached || cached.startedAt <= startedAt)
    ) {
      if (cached) {
        this.chars -= cached.read.html.length;
        this.cache.delete(cacheKey);
      }
      this.cache.set(cacheKey, {
        read,
        expires: Date.now() + 300000,
        startedAt,
      });
      this.chars += html.length;
      while (this.cache.size > 64 || this.chars > 4000000) {
        const key = this.cache.keys().next().value!;
        this.chars -= this.cache.get(key)!.read.html.length;
        this.cache.delete(key);
      }
    }
    return read;
  }
}
