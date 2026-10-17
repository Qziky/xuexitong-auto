import type { CourseRecord, TaskRecord, ScanSource } from './domain';
import { parseDate, textOf } from './page-parser';
import { safePageUrl } from './security';
import { assertPlatformPage } from './platform-access';
import { isHomeworkListUrl } from './scan-cache';
import {
  readNavigationLinks,
  resolveNavigationLink,
  navigationAttributes,
} from './course-navigation';

export interface ParsedDocument {
  courses: CourseRecord[];
  tasks: TaskRecord[];
  links: {
    url: string;
    kind: 'course-list' | 'navigation' | 'homework-list';
  }[];
  homeworkCounts?: { completed: number; total: number };
  homeworkListKnown?: boolean;
  loginRequired: boolean;
}
export function inertDocument(html: string): Document {
  const inert = html.replace(
    /<(?:iframe|img|video|audio|source|script|link)\b[^>]*>/gi,
    (tag) =>
      tag.replace(
        /(\s)(src|srcset|srcdoc|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
        (_, space: string, attr: string, value: string) =>
          `${space}data-cx-${attr.toLowerCase()}=${value}`,
      ),
  );
  return new DOMParser().parseFromString(inert, 'text/html');
}
function source(url: string, label: string): ScanSource {
  return { url, label, at: Date.now() };
}
export function readDeadline(node: Element): {
  deadline?: number;
  deadlineEstimated?: boolean;
} {
  const attr =
    node.querySelector('[data-deadline], [data-endtime], [data-end-time]') ??
    node;
  for (const name of ['data-deadline', 'data-endtime', 'data-end-time']) {
    const value = attr.getAttribute(name);
    if (!value) continue;
    const numeric = /^\d{10,13}$/.test(value)
      ? Number(value) * (value.length === 10 ? 1000 : 1)
      : undefined;
    const deadline = numeric ?? parseDate(value);
    if (deadline !== undefined) return { deadline };
  }
  const label = textOf(node);
  const explicit = label.match(
    /(?:截止(?:时间|日期)?|结束(?:时间|日期)?)\s*[:：]?\s*(20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/,
  )?.[1];
  if (explicit) {
    const deadline = parseDate(explicit);
    if (deadline !== undefined) return { deadline };
  }
  const match = label.match(
    /剩余\s*(?:(\d+)\s*天)?\s*(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分钟)?/,
  );
  if (match?.slice(1).some(Boolean))
    return {
      deadline:
        Date.now() +
        ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 +
          Number(match[3] ?? 0)) *
          60000,
      deadlineEstimated: true,
    };
  return {};
}
export function parseScanDocument(
  doc: Document,
  url: string,
  accountId: string,
  course?: CourseRecord,
): ParsedDocument {
  assertPlatformPage(url, doc);
  const result: ParsedDocument = {
    courses: [],
    tasks: [],
    links: [],
    loginRequired: false,
  };
  const body = textOf(doc.body);
  result.loginRequired =
    Boolean(doc.querySelector('input[type="password"]')) && /登录/.test(body);
  if (!course) {
    for (const link of doc.querySelectorAll(
      'a[href*="stucoursemiddle"], a[href*="/mycourse/stu?"]',
    )) {
      const entry = safePageUrl(link.getAttribute('href') ?? '', url);
      if (!entry) continue;
      const p = new URL(entry).searchParams;
      const courseId = p.get('courseid') ?? p.get('courseId') ?? '';
      const classId =
        p.get('clazzid') ?? p.get('clazzId') ?? p.get('classId') ?? '';
      if (!courseId || !classId) continue;
      const id = `${courseId}:${classId}`;
      if (result.courses.some((c) => c.id === id)) continue;
      const container =
        link.closest('li, .course, .courseItem, .course-item, .courseCard') ??
        link.parentElement;
      const title =
        link.getAttribute('title') ||
        textOf(
          link.querySelector('.course-name, .courseName, .courseTitle, h3'),
        ) ||
        textOf(link)
          .replace(/\d+\s*\/\s*\d+.*$/, '')
          .trim();
      if (!title) continue;
      const label = textOf(container);
      const aggregate = label.match(
        /(?:已完成|任务点|进度)?\s*(\d+)\s*\/\s*(\d+)/,
      );
      const completed = Number(aggregate?.[1]);
      const total = Number(aggregate?.[2]);
      result.courses.push({
        id,
        accountId,
        title,
        url: entry,
        courseId,
        classId,
        cpi: p.get('cpi') ?? '',
        taskPoints:
          aggregate && completed <= total ? { completed, total } : undefined,
        state: /已退课|退课成功/.test(label)
          ? 'withdrawn'
          : /已结束|已结课/.test(label)
            ? 'ended'
            : 'active',
        source: source(url, '课程列表'),
        warnings: [],
      });
    }
  }
  // Read inert navigation markup; chapter, task-card and question URLs are excluded.
  result.links = readNavigationLinks(doc, url, course);
  if (!course || !isHomeworkListUrl(url)) return result;
  const counts = body.match(
    /(?:已完成|完成数量|完成情况)\s*[:：]?\s*[（(]?\s*(\d+)\s*\/\s*(\d+)/,
  );
  if (counts && Number(counts[1]) <= Number(counts[2]))
    result.homeworkCounts = {
      completed: Number(counts[1]),
      total: Number(counts[2]),
    };
  for (const item of doc.querySelectorAll(
    'li[data], [onclick*="goTask"][data], a[href*="/work/task"], a[href*="/work/dowork"], a[href*="/work/view"]',
  )) {
    const entry = safePageUrl(
      item.getAttribute('data') ?? item.getAttribute('href') ?? '',
      url,
    );
    if (
      !entry ||
      !/\/work\/(?:task|view|dowork)$/.test(new URL(entry).pathname)
    )
      continue;
    const params = new URL(entry).searchParams;
    const id = params.get('workId') ?? params.get('workid');
    if (!id || result.tasks.some((task) => task.platformId === id)) continue;
    const row = item.closest('li, .work-item, .workItem, .work') ?? item;
    const label = textOf(row);
    const statusText =
      textOf(row.querySelector('.status, .workStatus, .work-status')) ||
      item.getAttribute('aria-label') ||
      label;
    const deadline = readDeadline(row);
    const status = /已完成|已提交|已批阅|待批阅/.test(statusText)
      ? 'submitted'
      : /未交|未完成|未提交|待完成/.test(statusText)
        ? deadline.deadline && deadline.deadline < Date.now()
          ? 'expired'
          : 'pending'
        : 'unknown';
    result.tasks.push({
      id: `${accountId}:${course.id}:homework:${id}`,
      accountId,
      courseId: course.id,
      title:
        textOf(row.querySelector('.work_name, .workName, .work-title, p')) ||
        item.getAttribute('title') ||
        item.getAttribute('aria-label')?.split(/[;；]/)[0] ||
        `作业 ${id}`,
      type: 'homework',
      status,
      url: entry,
      platformId: id,
      ...deadline,
      grade: label.match(/(?:成绩|得分)\s*[:：]?\s*(\d+(?:\.\d+)?)/)?.[1],
      source: source(url, '普通作业列表'),
      discovery: 'list',
      listed: true,
    });
  }
  const unknownPaging = [...doc.querySelectorAll('a, button')].some(
    (node) =>
      /下一页/.test(textOf(node)) &&
      !node.hasAttribute('disabled') &&
      !/disabled/.test(node.className) &&
      !navigationAttributes.some((attr) => {
        const link = resolveNavigationLink(
          node.getAttribute(attr) ?? '',
          doc,
          url,
          course,
        );
        return (
          link?.kind === 'homework-list' &&
          result.links.some((item) => item.url === link.url)
        );
      }),
  );
  result.homeworkListKnown =
    !unknownPaging &&
    (result.tasks.length > 0 ||
      /暂无作业|还没有作业|无作业|暂无内容/.test(body) ||
      result.homeworkCounts?.total === 0);
  return result;
}
