import type { CourseRecord } from './domain';
import { safePageUrl } from './security';
import {
  belongsToCourse,
  isCourseListUrl,
  isCourseShellUrl,
  isHomeworkListUrl,
} from './scan-cache';

export interface ReadLink {
  url: string;
  kind: 'course-list' | 'navigation' | 'homework-list';
}
export const navigationAttributes = [
  'data-url',
  'dataurl',
  'data',
  'href',
  'src',
  'data-cx-src',
] as const;

function field(doc: Document, name: string): string | undefined {
  const values = [...doc.querySelectorAll('input')]
    .filter((node) =>
      [node.id, node.getAttribute('name')].some(
        (value) => value?.toLowerCase() === name.toLowerCase(),
      ),
    )
    .map((node) => node.getAttribute('value')?.trim())
    .filter((value): value is string => Boolean(value));
  return new Set(values).size === 1 ? values[0] : undefined;
}

/** Resolve only addresses provided by the page. Never construct an endpoint. */
export function resolveNavigationLink(
  value: string,
  doc: Document,
  source: string,
  course?: CourseRecord,
  now = Date.now(),
): ReadLink | undefined {
  const entry = safePageUrl(value, source);
  if (!entry || entry === source) return;
  const target = new URL(entry);
  if (isCourseListUrl(entry) && target.pathname !== '/base')
    return { url: entry, kind: 'course-list' };
  if (!course || !belongsToCourse(entry, course)) return;
  const kind = isHomeworkListUrl(entry)
    ? 'homework-list'
    : isCourseShellUrl(entry)
      ? 'navigation'
      : undefined;
  if (!kind) return;
  if (kind === 'navigation') return { url: entry, kind };

  const current = new URL(source);
  const params = target.searchParams;
  if (isCourseShellUrl(source)) {
    if (!belongsToCourse(source, course)) return;
    const courseId = field(doc, 'courseid');
    const classId = field(doc, 'clazzid') ?? field(doc, 'classid');
    if (
      (courseId && courseId !== course.courseId) ||
      (classId && classId !== course.classId)
    )
      return;

    const workEnc = field(doc, 'workEnc');
    const pageEnc = field(doc, 'enc') ?? current.searchParams.get('enc');
    // A course-page token cannot authorize the homework tab.
    if (!params.has('enc') && pageEnc && !workEnc) return;
    if (!params.has('enc') && workEnc) params.set('enc', workEnc);
    if (!params.has('stuenc') && pageEnc) params.set('stuenc', pageEnc);
    const openc = field(doc, 'openc') ?? current.searchParams.get('openc');
    if (!params.has('openc') && openc) params.set('openc', openc);
    if (workEnc || params.has('enc')) {
      if (!params.has('ut'))
        params.set(
          'ut',
          field(doc, 'ut') ?? current.searchParams.get('ut') ?? 's',
        );
      if (!params.has('t')) params.set('t', String(now));
      if (!params.has('isdisplaytable'))
        params.set('isdisplaytable', field(doc, 'isdisplaytable') ?? '2');
    }
  } else if (
    isHomeworkListUrl(source) &&
    target.origin === current.origin &&
    target.pathname === current.pathname
  ) {
    // Relative pagination often contains only a page number. Keep its list authorization.
    for (const [key, item] of current.searchParams)
      if (!/^(?:page|pageNum|pageIndex|p)$/i.test(key) && !params.has(key))
        params.set(key, item);
  }
  if (!(params.get('courseId') ?? params.get('courseid')))
    params.set('courseId', course.courseId);
  if (!(
    params.get('classId') ??
    params.get('clazzid') ??
    params.get('clazzId')
  ))
    params.set('classId', course.classId);
  if (!params.has('cpi'))
    params.set(
      'cpi',
      course.cpi || field(doc, 'cpi') || current.searchParams.get('cpi') || '',
    );
  return { url: target.href, kind };
}

// Only literal navigation assignments are recognized; page JavaScript is never executed.
function literalRedirects(code: string): string[] {
  return [
    ...code.matchAll(
      /\b(?:(?:window|top|parent)\.)?location(?:\.href)?\s*=\s*(['"])([^'"\r\n]*)\1\s*(?=[;}]|$)/g,
    ),
  ].map((match) => match[2]!.replace(/\\\//g, '/'));
}
export function readNavigationLinks(
  doc: Document,
  source: string,
  course?: CourseRecord,
): ReadLink[] {
  const links: ReadLink[] = [];
  const now = Date.now();
  const add = (value: string) => {
    const link = resolveNavigationLink(value, doc, source, course, now);
    if (link && !links.some((old) => old.url === link.url)) links.push(link);
  };
  for (const node of doc.querySelectorAll(
    'iframe[src], iframe[data-cx-src], a[href], [data-url], [dataurl], [data]',
  ))
    for (const attr of navigationAttributes) {
      const value = node.getAttribute(attr);
      if (value) add(value);
    }
  if (course && isCourseShellUrl(source)) {
    for (const node of doc.querySelectorAll(
      'script:not([src]):not([data-cx-src]), [onclick]',
    ))
      for (const value of literalRedirects(
        node.tagName === 'SCRIPT'
          ? (node.textContent ?? '')
          : (node.getAttribute('onclick') ?? ''),
      ))
        add(value);
  }
  return links;
}
