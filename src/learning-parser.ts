import type { CourseRecord, LearningItem, LearningTaskType } from './domain';
import { textOf } from './page-parser';
import { hashText, isChaoxingUrl } from './security';
import { assertPlatformPage } from './platform-access';
import {
  attachmentCompletion,
  catalogCompletion,
  configurationCompletion,
  resolveCompletion,
} from './learning-completion';

export interface ChapterEntry {
  id: string;
  title: string;
  complete: boolean;
  completionState?: import('./domain').CompletionState;
  url?: string;
  actionId: string;
}
export interface LearningMenu {
  fingerprint: string;
  chapters: ChapterEntry[];
}
function chapterNodes(doc: Document): Element[] {
  return [
    ...doc.querySelectorAll(
      '[onclick*="getTeacherAjax"],[onclick*="studentstudy"],[onclick*="toOld("],[data-knowledgeid],a[href*="studentstudy"],a[href*="knowledge/cards"]',
    ),
  ];
}
export function learningMenu(doc: Document, url: string): LearningMenu {
  const chapters: ChapterEntry[] = [];
  for (const node of chapterNodes(doc)) {
    const action = node.getAttribute('onclick') ?? '';
    const link = node.getAttribute('href') ?? node.getAttribute('data-url');
    let address: URL | undefined;
    try {
      if (link && !/^javascript:/i.test(link)) address = new URL(link, url);
    } catch {}
    if (address && !isChaoxingUrl(address.href)) continue;
    const id =
      node.getAttribute('data-knowledgeid') ||
      address?.searchParams.get('chapterId') ||
      address?.searchParams.get('knowledgeid') ||
      node
        .getAttribute('id')
        ?.match(/(?:cur|chapter|knowledge)[-_]?(\d+)$/i)?.[1] ||
      action.match(
        /getTeacherAjax\s*\(\s*['"]?\d+['"]?\s*,\s*['"]?\d+['"]?\s*,\s*['"]?(\d+)/,
      )?.[1];
    if (!id || !/^\d+$/.test(id) || chapters.some((c) => c.id === id)) continue;
    const row =
      node.closest('.chapter_item,.chapter_unit,li,.posCatalog_select') ?? node;
    const completionState = catalogCompletion(row);
    const complete = completionState === 'confirmed';
    chapters.push({
      id,
      title:
        node.getAttribute('title') ||
        textOf(node.querySelector('.catalog_name,.chapter-name')) ||
        textOf(node).slice(0, 160) ||
        '章节 ' + id,
      complete,
      completionState,
      url: address?.href,
      actionId: hashText(id + ':' + action + ':' + (link ?? '')),
    });
  }
  return {
    chapters,
    fingerprint: hashText(
      JSON.stringify(chapters.map((c) => [c.id, c.actionId, c.url])),
    ),
  };
}
export function openLearningChapter(
  doc: Document,
  url: string,
  actionId: string,
  fingerprint: string,
): void {
  const menu = learningMenu(doc, url);
  if (menu.fingerprint !== fingerprint)
    throw new Error('章节目录已变化，请重新读取');
  const entry = menu.chapters.find((c) => c.actionId === actionId);
  if (!entry || entry.complete) throw new Error('章节入口已变化或已完成');
  const node = chapterNodes(doc).find(
    (n) =>
      hashText(
        entry.id +
          ':' +
          (n.getAttribute('onclick') ?? '') +
          ':' +
          (n.getAttribute('href') ?? n.getAttribute('data-url') ?? ''),
      ) === actionId,
  );
  if (!(node instanceof HTMLElement)) throw new Error('未找到真实章节入口');
  node.click();
}
export function learningConfigurations(script: string): unknown[] {
  const values: unknown[] = [];
  const pattern = /\b(?:mArg|attachments)\s*[:=]\s*([{[])/g;
  for (let match; (match = pattern.exec(script));) {
    let quote = '',
      escaped = false,
      depth = 0,
      end = match.index + match[0].length - 1;
    const start = end;
    for (; end < script.length; end++) {
      const c = script[end]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === quote) quote = '';
        continue;
      }
      if (c === '"') quote = c;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) {
        end++;
        break;
      }
    }
    try {
      const value = JSON.parse(script.slice(start, end));
      values.push(...(Array.isArray(value) ? value : [value]));
    } catch {}
  }
  return values;
}
export function parseLearningCards(
  doc: Document,
  url: string,
  course: CourseRecord,
  chapterId: string,
  options: {
    fresh?: boolean;
    knownReadingTask?: { jobId: string; objectId?: string };
  } = {},
): LearningItem[] {
  assertPlatformPage(url, doc);
  const attachments: any[] = [];
  for (const script of doc.querySelectorAll('script'))
    for (const value of learningConfigurations(script.textContent ?? '')) {
      if (value && typeof value === 'object') {
        const object = value as any;
        if (Array.isArray(object.attachments))
          attachments.push(...object.attachments);
        else if (object.type || object.property) attachments.push(object);
      }
    }
  const configured = new Set(attachments);
  for (const frame of doc.querySelectorAll('iframe[data]')) {
    try {
      const data = JSON.parse(frame.getAttribute('data')!);
      const existing = attachments.find(
        (a) => (a.jobid ?? a.property?.jobid) === data.jobid && data.jobid,
      );
      const container = frame.closest('.ans-attach-ct') ?? frame.parentElement;
      const icon = [
        ...(container?.querySelectorAll('.ans-job-icon') ?? []),
      ].find(
        (n) =>
          !container?.matches('.ans-attach-ct') ||
          n.closest('.ans-attach-ct') === container,
      );
      const marker = attachmentCompletion(container);
      const ratio = container?.textContent?.match(
        /总时长的\s*(\d+(?:\.\d+)?)%/,
      )?.[1];
      if (existing) {
        existing.cardMarkerState = marker;
        existing.hasTaskMarker = !!icon;
        if (ratio) existing.viewingRatio = Number(ratio) / 100;
      } else
        attachments.push({
          ...data,
          cardMarkerState: marker,
          hasTaskMarker: !!icon,
        });
    } catch {}
  }
  // Native readers retire job=true to job=false or remove the job field after
  // a successful callback, without isPassed. This is evidence only for a known
  // reading task on a fresh, identity-checked card, never a discovery heuristic.
  const retiredReadingTask = (a: any) => {
    const known = options.knownReadingTask,
      property = a.property ?? a;
    return !!(
      options.fresh &&
      known?.jobId &&
      (a.job === false ||
        (configured.has(a) &&
          !!known.objectId &&
          !Object.prototype.hasOwnProperty.call(a, 'job'))) &&
      String(a.jobid ?? property.jobid ?? '') === known.jobId &&
      (!known.objectId ||
        String(
          a.objectId ??
            a.objectid ??
            property.objectid ??
            property.objectId ??
            '',
        ) === known.objectId) &&
      ['document', 'image'].includes(
        learningTaskType(a.type, property.module, property.type, ''),
      )
    );
  };
  return attachments
    .filter(
      (a) =>
        a.job === true ||
        a.hasTaskMarker ||
        retiredReadingTask(a) ||
        (a.isPassed === true && (!!a.jobid || !!a.property?.jobid)) ||
        (a.job !== false && (!!a.jobid || !!a.property?.jobid)),
    )
    .map((a) => {
      const property = a.property ?? a;
      const jobId = String(a.jobid ?? property.jobid ?? '');
      const objectId = String(
        a.objectId ??
          a.objectid ??
          property.objectid ??
          property.objectId ??
          '',
      );
      const workId = String(
        property.workid ?? a.workid ?? jobId.match(/^work-(\d+)$/)?.[1] ?? '',
      );
      const type = learningTaskType(
        a.type,
        property.module,
        property.type,
        workId,
      );
      const explicit = configurationCompletion(a);
      const configState =
        explicit === 'unknown' && retiredReadingTask(a)
          ? 'confirmed'
          : explicit;
      const completionState = resolveCompletion(
        configState,
        a.cardMarkerState ?? 'unknown',
        options.fresh,
      );
      const completed = completionState === 'confirmed';
      const title = String(
        property.name ??
          property.title ??
          (type === 'video'
            ? '章节视频'
            : type === 'quiz'
              ? '章节测验'
              : '其他任务点'),
      );
      const cardNumber = new URL(url).searchParams.get('num') ?? '0';
      const id =
        course.id +
        ':' +
        chapterId +
        ':' +
        cardNumber +
        ':' +
        (jobId || objectId || workId);
      const task =
        type === 'quiz'
          ? {
              id: course.accountId + ':' + course.id + ':quiz:' + workId,
              accountId: course.accountId,
              courseId: course.id,
              title,
              type: 'quiz' as const,
              status: completed ? ('complete' as const) : ('pending' as const),
              url,
              platformId: workId,
              discovery: 'opened' as const,
              listed: false,
              source: { url, at: Date.now(), label: '用户启动的自动学习' },
            }
          : undefined;
      return {
        id,
        courseId: course.id,
        chapterId,
        title,
        url,
        type,
        jobId,
        objectId,
        task,
        card: { id: cardNumber, title: '', url },
        completion: completionCondition(a, property),
        completionState,
        completionEvidence:
          completionState !== 'unknown'
            ? {
                at: Date.now(),
                source:
                  configState !== 'unknown' ? 'configuration' : 'card-marker',
                state: completionState,
                fresh: options.fresh ?? false,
              }
            : undefined,
        platformComplete: completed,
        phase: completed ? 'done' : type === 'unknown' ? 'review' : 'waiting',
        note:
          type === 'unknown'
            ? '该任务暂未适配，请打开检查并人工完成'
            : undefined,
      };
    });
}

export function learningTaskType(
  type: unknown,
  module: unknown,
  extension: unknown,
  workId = '',
): LearningTaskType {
  const value = [type, module, extension]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (
    /(?:^|\s)(?:work|insertwork|quiz)(?:\s|$)/.test(value) &&
    String(workId).trim().length > 0
  )
    return 'quiz';
  if (/video|insertvideo|\.(?:mp4|webm|m3u8|mov)\b/.test(value)) return 'video';
  if (/audio|insertaudio|\.(?:mp3|wav|m4a|ogg)\b/.test(value)) return 'audio';
  if (
    /document|insertdoc|insertpdf|insertppt|\bpdf\b|\bppt\b|\.(?:pdf|pptx?|docx?)\b/.test(
      value,
    )
  )
    return 'document';
  if (
    /insertimage|insertimg|\bimage\b|\bimg\b|\.(?:png|jpe?g|gif|webp)\b/.test(
      value,
    )
  )
    return 'image';
  return 'unknown';
}
function completionCondition(
  a: any,
  property: any,
): LearningItem['completion'] {
  const ratio = Number(
    a.playTimeRatio ??
      a.viewingRatio ??
      property.playTimeRatio ??
      property.viewingRatio,
  );
  const seconds = Number(a.requiredSeconds ?? property.requiredSeconds);
  return {
    ratio:
      Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : undefined,
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
  };
}

export interface LearningCardMenu {
  chapterId?: string;
  fingerprint: string;
  cards: {
    id: string;
    title: string;
    actionId: string;
    url?: string;
    number?: string;
  }[];
}
export function learningCardMenu(doc: Document, url: string): LearningCardMenu {
  const cards = [
    ...doc.querySelectorAll<HTMLElement>(
      '[id^="dct"][cardid], [onclick*="changeDisplayContent"],a[href*="knowledge/cards"]',
    ),
  ].map((n) => {
    const action = n.getAttribute('onclick') ?? n.getAttribute('href') ?? '';
    const link = n.getAttribute('href');
    const id = n.getAttribute('cardid') ?? n.id ?? hashText(action);
    const index = action.match(/changeDisplayContent\(\s*(\d+)/)?.[1];
    return {
      id,
      title: (n.textContent ?? '').trim(),
      actionId: hashText(id + ':' + action),
      url:
        link && !link.startsWith('javascript:')
          ? new URL(link, url).href
          : undefined,
      number: index ? String(Number(index) - 1) : undefined,
    };
  });
  return {
    chapterId: (() => {
      const owners = [
        ...new Set(
          [
            ...doc.querySelectorAll<HTMLElement>(
              '[onclick*="changeDisplayContent"]',
            ),
          ]
            .map(
              (n) =>
                n
                  .getAttribute('onclick')
                  ?.match(
                    /changeDisplayContent\(\s*\d+\s*,\s*\d+\s*,\s*['"](\d+)['"]/,
                  )?.[1],
            )
            .filter(Boolean),
        ),
      ];
      return owners.length === 1
        ? owners[0]
        : owners.length > 1
          ? 'conflict'
          : undefined;
    })(),
    fingerprint: hashText(
      JSON.stringify(cards.map((c) => [c.id, c.number, c.actionId, c.url])),
    ),
    cards,
  };
}
export function openLearningCard(
  doc: Document,
  url: string,
  actionId: string,
  fingerprint: string,
): void {
  const menu = learningCardMenu(doc, url);
  if (menu.fingerprint !== fingerprint) throw new Error('卡片分页已变化');
  const entry = menu.cards.find((c) => c.actionId === actionId);
  const node = [
    ...doc.querySelectorAll<HTMLElement>(
      '[id^="dct"][cardid], [onclick*="changeDisplayContent"],a[href*="knowledge/cards"]',
    ),
  ].find(
    (n) =>
      hashText(
        (n.getAttribute('cardid') ??
          n.id ??
          hashText(n.getAttribute('onclick') ?? n.getAttribute('href') ?? '')) +
          ':' +
          (n.getAttribute('onclick') ?? n.getAttribute('href') ?? ''),
      ) === actionId,
  );
  if (!entry || !node) throw new Error('未找到真实卡片分页');
  node.click();
}
