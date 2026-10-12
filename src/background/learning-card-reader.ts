import type { CourseRecord, LearningItem } from '../domain';
import type { FrameInfo } from '../messages';
import { allowedPlatformRead, type PlatformRead } from '../platform-reader';
import { PlatformAccessError } from '../platform-access';
import { checkFrames } from './scan-control';
import { frameCall, type FrameRef } from './transport';
import { discoverFrames } from './learning-frame-access';

function location(url: string) {
  if (!allowedPlatformRead(url, 'learning')) return undefined;
  const p = new URL(url);
  if (!/\/knowledge\/cards$/.test(p.pathname)) return undefined;
  return {
    origin: p.origin,
    path: p.pathname,
    course: p.searchParams.get('courseid') ?? p.searchParams.get('courseId'),
    clazz: p.searchParams.get('clazzid') ?? p.searchParams.get('classId'),
    chapter:
      p.searchParams.get('knowledgeid') ?? p.searchParams.get('chapterId'),
    number: p.searchParams.get('num') ?? '0',
    cpi: p.searchParams.get('cpi'),
  };
}
export function sameCardPage(a: string, b: string): boolean {
  const left = location(a),
    right = location(b);
  return (
    !!left &&
    !!right &&
    left.origin === right.origin &&
    left.path === right.path &&
    !!left.chapter &&
    left.chapter === right.chapter &&
    left.number === right.number &&
    left.course === right.course &&
    left.clazz === right.clazz &&
    left.cpi === right.cpi
  );
}
export function cardMatchesItem(
  url: string,
  item: LearningItem,
  course: CourseRecord,
): boolean {
  return (
    cardBelongsToCourse(url, course, item.chapterId) &&
    sameCardPage(url, item.url)
  );
}
export function cardBelongsToCourse(
  url: string,
  course: CourseRecord,
  chapterId: string,
): boolean {
  const card = location(url);
  return (
    !!card &&
    card.chapter === chapterId &&
    (!course.courseId || card.course === course.courseId) &&
    (!course.classId || card.clazz === course.classId)
  );
}
/** Ephemeral HTML from a pinned document, never a substitute for fresh completion verification. */
export async function loadedLearningCard(
  ref: FrameRef,
  item: LearningItem,
  course: CourseRecord,
  accountId: string,
  signal: AbortSignal,
): Promise<PlatformRead | undefined> {
  if (!ref.documentId || !cardMatchesItem(ref.url, item, course))
    return undefined;
  if (
    ref.learningCardIdentity &&
    (!ref.learningCardIdentity.ready ||
      ref.learningCardIdentity.chapterId !== item.chapterId ||
      ref.learningCardIdentity.cardNumber !==
        (new URL(item.url).searchParams.get('num') ?? '0'))
  )
    return undefined;
  try {
    const read = await frameCall<PlatformRead & { info: FrameInfo }>(
      ref,
      { op: 'html' },
      { signal },
    );
    if (signal.aborted) throw new Error('操作已取消');
    if (
      !read?.info ||
      typeof read.html !== 'string' ||
      !read.html.length ||
      read.html.length > 12000000 ||
      read.url !== ref.url ||
      read.info.url !== read.url ||
      !cardMatchesItem(read.url, item, course) ||
      (read.info.learningCardIdentity &&
        (!read.info.learningCardIdentity.ready ||
          read.info.learningCardIdentity.chapterId !== item.chapterId ||
          read.info.learningCardIdentity.cardNumber !==
            (new URL(item.url).searchParams.get('num') ?? '0')))
    )
      return undefined;
    if (read.info.accountId && read.info.accountId !== accountId)
      throw new Error('登录账号已变化');
    if (read.info.loginRequired) throw new Error('登录已失效，请重新登录');
    const all = await discoverFrames(ref.tabId, signal);
    checkFrames([...all, { ...ref, ...read.info }], accountId);
    const current = all.find((f) => f.frameId === ref.frameId);
    if (current?.loginRequired) throw new Error('登录已失效，请重新登录');
    if (
      !current ||
      current.documentId !== ref.documentId ||
      current.url !== read.url
    )
      return undefined;
    return { html: read.html, url: read.url, source: 'page' };
  } catch (error) {
    if (
      signal.aborted ||
      error instanceof PlatformAccessError ||
      /账号|登录/.test(error instanceof Error ? error.message : '')
    )
      throw error;
    return undefined;
  }
}
