import type { CourseRecord, TaskRecord } from './domain';
import { isChaoxingUrl } from './security';

export const SCAN_CACHE_TTL = 5 * 60000;
export function homeworkCacheKey(accountId: string, courseId: string): string {
  return `${accountId}:${courseId}`;
}
export function cacheFresh(at: number | undefined, now = Date.now()): boolean {
  return at !== undefined && now >= at && now - at < SCAN_CACHE_TTL;
}
export function isHomeworkListUrl(url: string): boolean {
  return isChaoxingUrl(url) && /\/work\/list$/.test(new URL(url).pathname);
}
export function isCourseShellUrl(url: string): boolean {
  return (
    isChaoxingUrl(url) &&
    /^\/(?:visit\/stucoursemiddle|(?:mooc2-ans\/)?mycourse\/(?:stu|transfer))$/.test(
      new URL(url).pathname,
    )
  );
}
export function isCourseListUrl(url: string): boolean {
  return (
    isChaoxingUrl(url) &&
    /^\/(?:base|visit\/(?:interaction|courselist[^/]*|courses[^/]*))$/.test(
      new URL(url).pathname,
    )
  );
}
export function belongsToCourse(url: string, course: CourseRecord): boolean {
  if (!isChaoxingUrl(url)) return false;
  const params = new URL(url).searchParams;
  const courseId = params.get('courseid') ?? params.get('courseId');
  const classId =
    params.get('clazzid') ?? params.get('clazzId') ?? params.get('classId');
  return (
    (!courseId || courseId === course.courseId) &&
    (!classId || classId === course.classId)
  );
}
export function mergeTaskRecords(
  existing: TaskRecord[],
  incoming: TaskRecord[],
): TaskRecord[] {
  const result = [...existing];
  for (const task of incoming) {
    const index = result.findIndex((old) => old.id === task.id);
    const old = result[index];
    const next =
      old &&
      ['submitted', 'complete', 'review'].includes(old.status) &&
      !['submitted', 'complete'].includes(task.status)
        ? { ...task, status: old.status, grade: old.grade, note: old.note }
        : { ...task, grade: task.grade ?? old?.grade };
    if (index < 0) result.push(next);
    else result[index] = next;
  }
  return result;
}
