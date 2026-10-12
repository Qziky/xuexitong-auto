import type { CourseRecord, LearningItem, LearningQueue } from '../domain';
import type { LearningMenu, LearningCardMenu } from '../learning-parser';
import { selectedLearningTypes } from '../learning-policy';
import { matchesCourseLearningMenu } from '../learning-directory';
import { state, persist } from './store';
import { updateOperation, operationEvent } from './operations';
import {
  reconcileCompletedDiscoveryFailures,
  markRetriedDiscoveryPlaceholders,
} from '../learning-recovery';
import { frameCall, frameChangeOrTimeout, type FrameRef } from './transport';
import {
  discoverFrames,
  discoverAccountFrames,
  waitForFrames,
} from './learning-frame-access';
import { accessPlatform } from './platform';
import { chapterCardEntry, closeChapterTabs } from './chapter-access';
import { sameCardPage, cardBelongsToCourse } from './learning-card-reader';
export interface DiscoveryIO {
  adoptTab?(tabId: number): void | Promise<void>;
  activateTab?(tabId: number): Promise<void>;
  guard(queue: LearningQueue, signal: AbortSignal): void;
  ensureTab(
    queue: LearningQueue,
    url: string,
    signal: AbortSignal,
  ): Promise<number>;
  readCards(
    item: LearningItem,
    queue: LearningQueue,
    signal: AbortSignal,
    fresh?: boolean,
    loadedRef?: FrameRef,
  ): Promise<LearningItem[]>;
}
function sameCourseDirectory(ref: FrameRef, course: CourseRecord): boolean {
  return matchesCourseLearningMenu(ref, course);
}
export function sameLearningItem(a: LearningItem, b: LearningItem): boolean {
  return (
    a.id === b.id ||
    (a.courseId === b.courseId &&
      a.chapterId === b.chapterId &&
      (new URL(a.url).searchParams.get('num') ?? '0') ===
        (new URL(b.url).searchParams.get('num') ?? '0') &&
      (a.jobId && b.jobId
        ? a.jobId === b.jobId
        : !!a.objectId && a.objectId === b.objectId))
  );
}
async function chapterCardMenu(
  tabId: number,
  chapterId: string,
  signal: AbortSignal,
): Promise<{ ref: FrameRef; menu: LearningCardMenu } | undefined> {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (signal.aborted) throw new Error('学习已暂停');
    const all = await discoverFrames(tabId, signal);
    let pending = false;
    for (const ref of all) {
      const menu = await frameCall<LearningCardMenu>(
        ref,
        { op: 'learning-card-menu' },
        { signal },
      );
      if (!menu.cards.length) continue;
      if (menu.chapterId && menu.chapterId !== chapterId) {
        pending = true;
        continue;
      }
      return { ref, menu };
    }
    if (
      !pending &&
      all.length &&
      !all.some(
        (f) =>
          f.hasLearningMenu ||
          /\/mycourse\/studentstudy$/.test(new URL(f.url).pathname),
      )
    )
      return undefined;
    await frameChangeOrTimeout(Math.min(1000, end - Date.now()), signal);
  }
  throw new Error('卡片导航未更新到目标章节，请打开检查');
}
/** Resuming never trusts a persisted directory or old resource frame. */
export async function revalidateLearningDirectory(
  queue: LearningQueue,
  item: LearningItem,
  signal: AbortSignal,
  io: DiscoveryIO,
): Promise<void> {
  io.guard(queue, signal);
  const course = state.courses.find(
    (c) =>
      c.id === item.courseId &&
      c.accountId === queue.accountId &&
      c.state === 'active',
  );
  if (!course) throw new Error('恢复前课程归属或在读状态已变化');
  updateOperation(queue.runId, '恢复前核对章节目录：' + course.title, {
    stage: 'checking',
    waiting: 'page',
  });
  const tabId = await io.ensureTab(queue, course.url, signal);
  await io.activateTab?.(tabId);
  await waitForFrames(tabId, (f) => !!f.hasLearningMenu, signal);
  const frames = await discoverAccountFrames(tabId, queue.accountId, signal);
  io.guard(queue, signal);
  for (const ref of frames.filter((f) => f.hasLearningMenu)) {
    const menu = await frameCall<LearningMenu>(
      ref,
      { op: 'learning-menu' },
      { signal },
    );
    io.guard(queue, signal);
    if (!menu.chapters.some((c) => c.id === item.chapterId)) continue;
    const live = (await discoverFrames(tabId, signal)).find(
      (f) =>
        f.frameId === ref.frameId &&
        f.documentId === ref.documentId &&
        f.url === ref.url,
    );
    if (!live) throw new Error('恢复前章节目录文档已变化');
    io.guard(queue, signal);
    const reconciled = reconcileCompletedDiscoveryFailures(
      queue,
      course.id,
      menu.chapters,
    );
    if (reconciled)
      operationEvent(
        queue.runId,
        `最新目录确认已完成，清除 ${reconciled} 条章节发现失败记录`,
        {
          code: 'chapter-discovery-recovered',
        },
      );
    if (queue.cursor?.nextChapterId) {
      const index = menu.chapters.findIndex(
        (c) => c.id === queue.cursor!.nextChapterId,
      );
      if (index < 0)
        throw new Error('待恢复章节的稳定标识已不存在，请打开检查');
      queue.cursor.chapter = index;
      queue.cursor.chapters = menu.chapters;
    }
    const chapter = menu.chapters.find((c) => c.id === item.chapterId)!;
    const opened = await chapterCardEntry(
      ref,
      chapter,
      menu.fingerprint,
      signal,
      {
        runId: queue.runId,
        accountId: queue.accountId,
        check: () => io.guard(queue, signal),
        foregroundTarget: io.activateTab,
      },
    );
    await io.adoptTab?.(opened.tabId);
    queue.tabId = opened.tabId;
    await io.activateTab?.(opened.tabId);
    const navigation = await chapterCardMenu(
      opened.tabId,
      item.chapterId,
      signal,
    );
    const matches = (f: FrameRef) =>
      cardBelongsToCourse(f.url, course, item.chapterId) &&
      sameCardPage(f.url, item.url) &&
      (!f.learningCardIdentity || f.learningCardIdentity.ready);
    if (!(await discoverFrames(opened.tabId, signal)).some(matches)) {
      const number = new URL(item.url).searchParams.get('num') ?? '0';
      const card =
        navigation?.menu.cards.find(
          (c) => c.id === item.card?.id && c.number === number,
        ) ?? navigation?.menu.cards.find((c) => c.number === number);
      if (!navigation || !card) throw new Error('恢复前未找到当前任务卡片');
      // Old checkpoints may contain a header ID from the previous chapter.
      // The actual card address and job/object identity remain checked on startup.
      item.card = { id: card.id, title: card.title, url: item.url };
      await accessPlatform(
        () =>
          frameCall(
            navigation.ref,
            {
              op: 'learning-card-open',
              actionId: card.actionId,
              fingerprint: navigation.menu.fingerprint,
            },
            { signal },
          ),
        {
          signal,
          runId: queue.runId,
          accountId: queue.accountId,
          check: () => io.guard(queue, signal),
        },
      );
      await waitForFrames(opened.tabId, matches, signal);
    }
    await discoverAccountFrames(opened.tabId, queue.accountId, signal);
    return;
  }
  throw new Error('恢复前未找到当前任务所属章节，请打开检查');
}
/** Yield after one card so it executes before discovering the next card. */
export async function discoverNextChapter(
  queue: LearningQueue,
  signal: AbortSignal,
  io: DiscoveryIO,
): Promise<void> {
  queue.cursor ??= { course: 0, chapter: 0 };
  const cursor = queue.cursor;
  while (cursor.course < queue.courseIds.length) {
    io.guard(queue, signal);
    const course = state.courses.find(
      (c) =>
        c.id === queue.courseIds[cursor.course] &&
        c.accountId === queue.accountId &&
        c.state === 'active',
    );
    if (!course) throw new Error('课程归属或在读状态已变化');
    updateOperation(queue.runId, '发现任务：' + course.title, {
      stage: 'checking',
      waiting: 'page',
      total: undefined,
    });
    let currentFrames =
      queue.tabId === undefined
        ? []
        : await discoverFrames(queue.tabId, signal, true);
    if (currentFrames.length)
      currentFrames = await discoverAccountFrames(
        queue.tabId!,
        queue.accountId,
        signal,
      );
    const sameCourse = currentFrames.some((f) =>
      sameCourseDirectory(f, course),
    );
    const tabId = sameCourse
      ? queue.tabId!
      : await io.ensureTab(queue, course.url, signal);
    queue.tabId = tabId;
    await io.activateTab?.(tabId);
    const frames = await waitForFrames(
      tabId,
      (f) => sameCourseDirectory(f, course),
      signal,
    );
    await discoverAccountFrames(tabId, queue.accountId, signal);
    let directory: { ref: FrameRef; menu: LearningMenu } | undefined;
    for (const ref of frames.filter((frame) =>
      sameCourseDirectory(frame, course),
    )) {
      const menu = await frameCall<LearningMenu>(ref, { op: 'learning-menu' });
      if (menu.chapters.length) {
        directory = { ref, menu };
        break;
      }
    }
    if (!directory) throw new Error('未找到可确认的章节目录');
    let activeDirectory = directory;
    if (!cursor.chapters) {
      cursor.chapters = activeDirectory.menu.chapters;
      if (cursor.nextChapterId) {
        const index = cursor.chapters.findIndex(
          (c) => c.id === cursor.nextChapterId,
        );
        if (index < 0)
          throw new Error('待恢复章节的稳定标识已不存在，请打开检查');
        cursor.chapter = index;
      }
    }
    while (cursor.chapter < cursor.chapters.length) {
      io.guard(queue, signal);
      const targetChapterId =
        cursor.nextChapterId ?? cursor.chapters[cursor.chapter]?.id;
      if (!targetChapterId) throw new Error('当前章节缺少稳定标识');
      const liveFrames = await discoverAccountFrames(
        tabId,
        queue.accountId,
        signal,
      );
      let live = liveFrames.find(
        (frame) =>
          sameCourseDirectory(frame, course) &&
          frame.frameId === activeDirectory.ref.frameId &&
          frame.documentId === activeDirectory.ref.documentId &&
          frame.url === activeDirectory.ref.url,
      );
      if (!live) {
        live = liveFrames.find((frame) => sameCourseDirectory(frame, course));
        if (!live) {
          const reboundFrames = await waitForFrames(
            tabId,
            (frame) => sameCourseDirectory(frame, course),
            signal,
            10000,
          );
          live = reboundFrames.find((frame) =>
            sameCourseDirectory(frame, course),
          );
        }
        if (!live) throw new Error('课程目录帧重绑定失败');
        operationEvent(queue.runId, '章节导航后重新绑定课程目录帧', {
          code: 'chapter-directory-frame-rebound',
        });
      }
      const liveMenu = await frameCall<LearningMenu>(
        live,
        { op: 'learning-menu' },
        { signal },
      );
      const liveChapterIndex = liveMenu.chapters.findIndex(
        (chapter) => chapter.id === targetChapterId,
      );
      if (liveChapterIndex < 0)
        throw new Error('待恢复章节的稳定标识已不存在，请打开检查');
      cursor.chapters = liveMenu.chapters;
      cursor.chapter = liveChapterIndex;
      cursor.nextChapterId = targetChapterId;
      activeDirectory = {
        ref: live,
        menu: liveMenu,
      };
      const original = cursor.chapters[cursor.chapter]!;
      const chapter = activeDirectory.menu.chapters.find(
        (c) => c.id === original.id,
      );
      if (!chapter) throw new Error('章节入口已变化，无法确认是否完成');
      if (chapter.complete) {
        cursor.nextCardId = undefined;
        cursor.cardIds = undefined;
        cursor.chapter++;
        cursor.nextChapterId = cursor.chapters[cursor.chapter]?.id;
        continue;
      }
      updateOperation(queue.runId, '发现章节任务：' + chapter.title, {
        stage: 'checking',
        waiting: 'page',
      });
      io.guard(queue, signal);
      const opened = await chapterCardEntry(
        activeDirectory.ref,
        chapter,
        activeDirectory.menu.fingerprint,
        signal,
        {
          runId: queue.runId,
          accountId: queue.accountId,
          check: () => io.guard(queue, signal),
          foregroundTarget: io.activateTab,
        },
      );
      await io.adoptTab?.(opened.tabId);
      try {
        await discoverAccountFrames(opened.tabId, queue.accountId, signal);
        let cardMenu = await chapterCardMenu(opened.tabId, chapter.id, signal);
        const cards = cardMenu?.menu.cards ?? [
          {
            id: new URL(opened.url).searchParams.get('num') ?? '0',
            title: '',
            url: opened.url,
            number: new URL(opened.url).searchParams.get('num') ?? '0',
            actionId: '',
          },
        ];
        const cardIndex = cursor.nextCardId
          ? cards.findIndex((c) => c.id === cursor.nextCardId)
          : 0;
        if (cardIndex < 0) {
          operationEvent(
            queue.runId,
            '平台卡片目录已变化；清除旧分页位置并从当前章节首卡重新读取',
            { code: 'stale-card-checkpoint-reset' },
          );
          cursor.nextCardId = undefined;
          cursor.cardIds = undefined;
          await persist(true);
          continue;
        }
        const recovered = markRetriedDiscoveryPlaceholders(
          queue,
          course.id,
          chapter.id,
        );
        if (recovered)
          operationEvent(
            queue.runId,
            `重新读取 ${recovered} 条章节发现占位后继续任务扫描`,
            { code: 'chapter-discovery-recovered' },
          );
        cursor.cardIds = cards.map((c) => c.id);
        for (const card of cards.slice(cardIndex, cardIndex + 1)) {
          io.guard(queue, signal);
          let url = card.url;
          let loadedRef: FrameRef | undefined;
          if (cardMenu) {
            const existing = await discoverAccountFrames(
              opened.tabId,
              queue.accountId,
              signal,
            );
            const menuRef = existing.find(
              (f) =>
                f.frameId === cardMenu!.ref.frameId &&
                f.url === cardMenu!.ref.url,
            );
            if (!menuRef) throw new Error('卡片导航页面已变化');
            cardMenu.ref = menuRef;
            const menu = await frameCall<LearningCardMenu>(cardMenu.ref, {
              op: 'learning-card-menu',
            });
            const current = menu.cards.find((c) => c.id === card.id);
            if (
              !current ||
              current.number !== card.number ||
              current.url !== card.url ||
              current.actionId !== card.actionId
            )
              throw new Error('卡片分页已经变化');
            const matchesCard = (f: FrameRef) => {
              const p = new URL(f.url);
              return (
                cardBelongsToCourse(f.url, course, chapter.id) &&
                (!f.learningCardIdentity ||
                  (f.learningCardIdentity.ready &&
                    f.learningCardIdentity.chapterId === chapter.id)) &&
                (card.number !== undefined
                  ? (p.searchParams.get('num') ?? '0') === card.number
                  : !!card.url && sameCardPage(f.url, card.url))
              );
            };
            loadedRef = existing.find(matchesCard);
            if (!loadedRef) {
              await accessPlatform(
                () =>
                  frameCall(
                    cardMenu!.ref,
                    {
                      op: 'learning-card-open',
                      actionId: current.actionId,
                      fingerprint: menu.fingerprint,
                    },
                    { signal },
                  ),
                {
                  signal,
                  runId: queue.runId,
                  accountId: queue.accountId,
                  check: () => io.guard(queue, signal),
                },
              );
              const result = await waitForFrames(
                opened.tabId,
                matchesCard,
                signal,
              );
              await discoverAccountFrames(
                opened.tabId,
                queue.accountId,
                signal,
              );
              loadedRef = result.find(matchesCard);
            }
            url = loadedRef?.url;
          } else {
            loadedRef = (await discoverFrames(opened.tabId, signal)).find(
              (f) => !!url && sameCardPage(f.url, url),
            );
          }
          if (!url) throw new Error('卡片未提供真实访问地址');
          const marker: LearningItem = {
            id: 'read',
            courseId: course.id,
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            title: chapter.title,
            url,
            type: 'unknown',
            phase: 'waiting',
          };
          const items = await io.readCards(
            marker,
            queue,
            signal,
            false,
            loadedRef,
          );
          io.guard(queue, signal);
          for (const item of items) {
            item.chapterTitle = chapter.title;
            item.card = { id: card.id, title: card.title, url };
            if (queue.goal === 'submit' && item.task?.type === 'quiz')
              item.task.autoSubmitBestCandidate = true;
            if (
              (item.type === 'unknown' ||
                selectedLearningTypes(queue).includes(item.type)) &&
              !queue.items.some((i) => sameLearningItem(i, item))
            )
              queue.items.push(item);
          }
          await persist(true);
        }
        io.guard(queue, signal);
        cursor.nextCardId = cards[cardIndex + 1]?.id;
        if (!cursor.nextCardId) {
          cursor.cardIds = undefined;
          cursor.chapter++;
          cursor.nextChapterId = cursor.chapters[cursor.chapter]?.id;
        }
        await persist(true);
        return;
      } finally {
        await io.activateTab?.(queue.tabId!);
        await closeChapterTabs(
          opened.openedTabIds.filter((id) => id !== queue.tabId),
        );
      }
    }
    cursor.course++;
    cursor.chapter = 0;
    cursor.chapters = undefined;
    cursor.nextChapterId = undefined;
    cursor.nextCardId = undefined;
    cursor.cardIds = undefined;
    await persist(true);
  }
  queue.discovered = true;
  await persist(true);
}
