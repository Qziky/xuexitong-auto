import type { CourseRecord } from './domain';
import { isChaoxingUrl } from './security';

function param(url: URL, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value) return value;
  }
  return;
}

/** Recognize the active course directory across platform route casing changes. */
export function matchesCourseLearningMenu(
  frame: { url: string; hasLearningMenu?: boolean },
  course: Pick<CourseRecord, 'courseId' | 'classId' | 'cpi' | 'url'>,
): boolean {
  if (!frame.hasLearningMenu || !isChaoxingUrl(frame.url)) return false;
  try {
    const actual = new URL(frame.url);
    const requested = new URL(course.url);
    return (
      param(actual, 'courseid', 'courseId') ===
        (course.courseId || param(requested, 'courseid', 'courseId')) &&
      param(actual, 'clazzid', 'classId', 'clazzId') ===
        (course.classId || param(requested, 'clazzid', 'classId', 'clazzId')) &&
      param(actual, 'cpi') ===
        (course.cpi || param(requested, 'cpi'))
    );
  } catch {
    return false;
  }
}
