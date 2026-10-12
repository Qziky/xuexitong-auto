import type { CourseRecord, HomeworkListCache, TaskRecord } from '../domain';
import {
  cacheFresh,
  homeworkCacheKey,
  belongsToCourse,
  isCourseShellUrl,
  isHomeworkListUrl,
  mergeTaskRecords,
} from '../scan-cache';
import type { ParsedDocument } from '../scan-parser';
import { state, persist, log } from './store';
import {
  discoverFrames,
  frameCall,
  offscreen,
  type FrameRef,
} from './transport';
import { beginScan, checkScan, checkFrames, endScan } from './scan-control';
import { holdPlatform, rethrowPlatformBlock } from './platform';
import { PlatformAccessError } from '../platform-access';

interface ReadDoc {
  html: string;
  url: string;
}
function bindUrl(url: string, course: CourseRecord): string {
  if (!belongsToCourse(url, course)) throw new Error('作业入口指向其他课程');
  const bound = new URL(url);
  if (!(
    bound.searchParams.get('courseId') ?? bound.searchParams.get('courseid')
  ))
    bound.searchParams.set('courseId', course.courseId);
  if (!(
    bound.searchParams.get('classId') ??
    bound.searchParams.get('clazzid') ??
    bound.searchParams.get('clazzId')
  ))
    bound.searchParams.set('classId', course.classId);
  if (!bound.searchParams.has('cpi')) bound.searchParams.set('cpi', course.cpi);
  return bound.href;
}
function matches(frame: FrameRef, course: CourseRecord): boolean {
  const params = new URL(frame.url).searchParams;
  return (
    (params.get('courseId') ?? params.get('courseid')) === course.courseId &&
    (params.get('classId') ??
      params.get('clazzId') ??
      params.get('clazzid')) === course.classId
  );
}
export function observeHomeworkEntry(ref: FrameRef): void {
  if (!isHomeworkListUrl(ref.url) || ref.accountId !== state.accountId) return;
  const course = state.courses.find(
    (c) => c.accountId === state.accountId && matches(ref, c),
  );
  if (!course) return;
  const key = homeworkCacheKey(course.accountId, course.id);
  const cache = state.homeworkCache[key] ?? {
    accountId: course.accountId,
    courseId: course.id,
    entryUrls: [],
    taskIds: [],
    complete: false,
  };
  if (!cache.entryUrls.includes(ref.url)) cache.entryUrls = [ref.url];
  state.homeworkCache[key] = cache;
}

// Called by the overview under the same cancellation controller; no chapter or question operations.
export async function readHomeworkLists(
  signal: AbortSignal,
  courseId?: string,
  force = false,
): Promise<void> {
  const accountId = state.accountId;
  if (!accountId) throw new Error('请先登录并获取课程列表');
  const all = await discoverFrames();
  checkFrames(all, accountId);
  all.forEach(observeHomeworkEntry);
  const courses = state.courses.filter(
    (c) =>
      c.accountId === accountId &&
      c.state === 'active' &&
      (!courseId || c.id === courseId),
  );
  state.scan.total = courses.length;
  state.scan.completed = 0;
  for (const course of courses) {
    checkScan(signal, accountId);
    state.scan.note = `${course.title} · 正在更新普通作业列表`;
    const key = homeworkCacheKey(accountId, course.id);
    const cache: HomeworkListCache = state.homeworkCache[key] ?? {
      accountId,
      courseId: course.id,
      entryUrls: [],
      taskIds: [],
      complete: false,
    };
    state.homeworkCache[key] = cache;
    if (!force && cache.complete && cacheFresh(cache.at)) {
      log(
        `${course.title}：命中 5 分钟作业列表缓存，复用 ${cache.taskIds.length} 份作业`,
      );
      state.scan.completed++;
      continue;
    }
    // Earlier versions could cache an address built with the course-page token.
    // Re-discover unconfirmed entries, unless a live homework page supplies a fresh one.
    if (
      !cache.complete &&
      cache.note &&
      !all.some((ref) => matches(ref, course) && isHomeworkListUrl(ref.url))
    )
      cache.entryUrls = [];
    cache.lastAttemptAt = Date.now();
    const parse = async (read: ReadDoc): Promise<ParsedDocument> => {
      checkScan(signal, accountId);
      if (!belongsToCourse(read.url, course))
        throw new Error('页面跳转到其他课程');
      const parsed = await offscreen<ParsedDocument>(
        { op: 'parse', ...read, accountId, course },
        signal,
      );
      if (parsed.loginRequired) throw new Error('登录已失效，请重新登录');
      return parsed;
    };
    const fetchRead = async (
      url: string,
      purpose: 'navigation' | 'homework-list',
    ): Promise<ReadDoc> => {
      checkScan(signal, accountId);
      const read = await offscreen<ReadDoc>(
        { op: 'fetch', url: bindUrl(url, course), purpose, fresh: force },
        signal,
      );
      if (
        !(purpose === 'navigation'
          ? isCourseShellUrl(read.url)
          : isHomeworkListUrl(read.url))
      )
        throw new Error('入口未返回预期的列表页面');
      return read;
    };
    try {
      if (!cache.entryUrls.length) {
        const live = all.filter(
          (f) => matches(f, course) && isCourseShellUrl(f.url),
        );
        const pending: { url: string; ref?: FrameRef }[] = live.map((ref) => ({
          url: ref.url,
          ref,
        }));
        if (
          isCourseShellUrl(course.url) &&
          !pending.some((item) => item.url === course.url)
        )
          pending.push({ url: course.url });
        const seen = new Set<string>();
        const collect = (parsed: ParsedDocument) => {
          for (const link of parsed.links) {
            if (!belongsToCourse(link.url, course)) continue;
            if (link.kind === 'homework-list' && isHomeworkListUrl(link.url)) {
              const entry = bindUrl(link.url, course);
              if (!cache.entryUrls.includes(entry)) cache.entryUrls.push(entry);
            } else if (
              link.kind === 'navigation' &&
              isCourseShellUrl(link.url) &&
              !seen.has(link.url) &&
              !pending.some((item) => item.url === link.url)
            )
              pending.push({ url: link.url });
          }
        };
        while (pending.length && seen.size < 3 && !cache.entryUrls.length) {
          checkScan(signal, accountId);
          const next = pending.shift()!;
          if (seen.has(next.url)) continue;
          seen.add(next.url);
          if (next.ref) {
            try {
              const parsed = await parse(
                await frameCall<ReadDoc>(next.ref, { op: 'html' }),
              );
              collect(parsed);
              if (
                cache.entryUrls.length ||
                parsed.links.some((link) => link.kind === 'navigation')
              )
                continue;
            } catch (error) {
              rethrowPlatformBlock(error);
              checkScan(signal, accountId);
              if (error instanceof Error && /登录已失效/.test(error.message))
                throw error;
            }
          }
          // A loading/stale user DOM must not hide the server-rendered navigation.
          collect(await parse(await fetchRead(next.url, 'navigation')));
        }
      }
      if (!cache.entryUrls.length) {
        cache.complete = false;
        cache.note = '请打开本课程作业页以获取入口';
      } else {
        const pending = [...new Set(cache.entryUrls)];
        const seen = new Set<string>();
        const tasks: TaskRecord[] = [];
        let complete = true;
        while (pending.length && seen.size < 40) {
          checkScan(signal, accountId);
          const url = pending.shift()!;
          if (seen.has(url)) continue;
          seen.add(url);
          if (!isHomeworkListUrl(url)) throw new Error('作业列表入口无效');
          const parsed = await parse(await fetchRead(url, 'homework-list'));
          log(
            `${course.title}：普通作业列表第 ${seen.size} 页已读取，返回 ${parsed.tasks.filter((t) => t.type === 'homework').length} 份作业`,
          );
          if (
            parsed.tasks.some(
              (t) => t.type === 'homework' && !belongsToCourse(t.url, course),
            )
          )
            throw new Error('作业链接指向其他课程，保留上次记录');
          complete &&= parsed.homeworkListKnown === true;
          const incoming = parsed.tasks.filter(
            (t) =>
              t.type === 'homework' &&
              t.accountId === accountId &&
              t.courseId === course.id &&
              belongsToCourse(t.url, course),
          );
          tasks.push(
            ...incoming.filter((t) => !tasks.some((old) => old.id === t.id)),
          );
          state.tasks = mergeTaskRecords(state.tasks, incoming);
          for (const link of parsed.links)
            if (
              link.kind === 'homework-list' &&
              isHomeworkListUrl(link.url) &&
              belongsToCourse(link.url, course) &&
              !seen.has(link.url) &&
              !pending.includes(link.url)
            )
              pending.push(link.url);
          await persist();
        }
        complete &&= pending.length === 0;
        cache.complete = complete;
        if (complete) {
          const ids = tasks.map((t) => t.id);
          state.tasks = state.tasks.map((t) =>
            t.accountId === accountId &&
            t.courseId === course.id &&
            t.type === 'homework'
              ? { ...t, listed: ids.includes(t.id) }
              : t,
          );
          cache.taskIds = ids;
          cache.at = Date.now();
          cache.note = undefined;
          const listed = state.tasks.filter((t) => ids.includes(t.id));
          course.homeworkCounts = {
            completed: listed.filter((t) =>
              ['submitted', 'complete'].includes(t.status),
            ).length,
            total: listed.length,
          };
        } else {
          cache.taskIds = [
            ...new Set([...cache.taskIds, ...tasks.map((t) => t.id)]),
          ];
          cache.note = '部分作业列表未确认，保留上次记录；请打开平台核对';
        }
      }
    } catch (error) {
      rethrowPlatformBlock(error);
      checkScan(signal, accountId);
      cache.complete = false;
      // Expired/invalid entries are re-discovered on the next user or scheduled refresh.
      cache.entryUrls = [];
      cache.note =
        error instanceof Error
          ? `作业列表更新失败：${error.message}`
          : '作业列表更新失败，保留上次记录';
      if (/登录已失效/.test(cache.note)) throw error;
    }
    state.scan.completed++;
    await persist();
  }
}
export async function refreshHomeworkLists(
  courseId?: string,
  force = false,
): Promise<void> {
  if (
    courseId &&
    !state.courses.some(
      (c) =>
        c.id === courseId &&
        c.accountId === state.accountId &&
        c.state === 'active',
    )
  )
    throw new Error('课程不属于当前账号');
  const controller = beginScan('刷新普通作业列表');
  try {
    state.scan = {
      scope: 'homework',
      courseId,
      phase: 'running',
      completed: 0,
      total: 0,
      at: Date.now(),
      note: '正在刷新普通作业列表',
    };
    await persist();
    await readHomeworkLists(controller.signal, courseId, force);
    state.scan = {
      ...state.scan,
      phase: 'done',
      at: Date.now(),
      note: '普通作业列表已更新；题目在打开或点击完成时读取',
    };
  } catch (error) {
    if (error instanceof PlatformAccessError) await holdPlatform(error.block);
    state.scan = {
      ...state.scan,
      phase: state.platformBlock
        ? 'blocked'
        : controller.signal.aborted
          ? 'cancelled'
          : 'error',
      at: Date.now(),
      note: error instanceof Error ? error.message : '更新失败',
    };
    log(state.scan.note, 'warn');
  } finally {
    endScan(controller);
    await persist();
  }
}
