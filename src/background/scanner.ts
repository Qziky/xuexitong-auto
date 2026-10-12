import type { CourseRecord } from '../domain';
import type { ParsedDocument } from '../scan-parser';
import { state, log, persist } from './store';
import {
  discoverFrames,
  frameCall,
  offscreen,
  waitForFrames,
} from './transport';
import type { CatalogMenu } from '../catalog-navigation';
import { delay } from './transport';
import { holdPlatform, accessPlatform, rethrowPlatformBlock } from './platform';
import { PlatformAccessError } from '../platform-access';

import {
  beginScan,
  cancelScan,
  checkScan,
  checkFrames,
  endScan,
  scanRunning,
  scanOperationId,
} from './scan-control';
import { cacheFresh, isCourseListUrl } from '../scan-cache';
import { readHomeworkLists } from './homework-scanner';
import { ownedTabs } from './owned-tabs';
export { cancelScan };

interface ReadDoc {
  html: string;
  url: string;
}
export async function refreshCourseProgress(
  force = false,
  withHomework = false,
): Promise<void> {
  if (scanRunning()) return;
  const controller = beginScan();
  const signal = controller.signal;
  let scanTab: number | undefined;
  const newCourses: CourseRecord[] = [];
  const ended = new Set<string>();
  const conflictingProgress = new Set<string>();
  let accountId: string | undefined;
  function mergeCourses(): void {
    if (!accountId) return;
    const previous = state.courses.filter(
      (course) => course.accountId === accountId && !ended.has(course.id),
    );
    state.courses = [
      ...newCourses.map((course) => {
        const old = previous.find((candidate) => candidate.id === course.id);
        return {
          ...course,
          homeworkCounts: course.homeworkCounts ?? old?.homeworkCounts,
        };
      }),
      ...previous.filter(
        (course) => !newCourses.some((incoming) => incoming.id === course.id),
      ),
    ];
  }
  function collect(parsed: ParsedDocument): void {
    if (parsed.loginRequired) throw new Error('登录已失效，请重新登录');
    for (const course of parsed.courses) {
      if (course.state !== 'active') {
        ended.add(course.id);
        continue;
      }
      const index = newCourses.findIndex(
        (candidate) => candidate.id === course.id,
      );
      if (index < 0) newCourses.push(course);
      else {
        const previous = newCourses[index]!;
        const conflict =
          previous.taskPoints &&
          course.taskPoints &&
          JSON.stringify(previous.taskPoints) !==
            JSON.stringify(course.taskPoints);
        if (conflict) conflictingProgress.add(course.id);
        const warnings = [
          ...previous.warnings,
          ...course.warnings,
          ...(conflictingProgress.has(course.id)
            ? ['课程列表中的任务点进度不一致，状态待确认']
            : []),
        ];
        newCourses[index] = {
          ...previous,
          ...course,
          taskPoints: conflictingProgress.has(course.id)
            ? undefined
            : (course.taskPoints ?? previous.taskPoints),
          homeworkCounts: course.homeworkCounts ?? previous.homeworkCounts,
          warnings: [...new Set(warnings)],
        };
      }
    }
  }
  async function parse(read: ReadDoc): Promise<ParsedDocument> {
    checkScan(signal, accountId);
    if (!isCourseListUrl(read.url))
      throw new Error('进度刷新只允许读取课程列表');
    return offscreen({ op: 'parse', ...read, accountId: accountId! }, signal);
  }
  try {
    state.scan = {
      scope: withHomework ? 'overview' : 'progress',
      phase: 'running',
      completed: 0,
      total: 0,
      at: Date.now(),
      note: '正在刷新课程列表任务点进度',
    };
    await persist();
    const all = await discoverFrames();
    checkFrames(all);
    const seed = all.filter(
      (frame) => isCourseListUrl(frame.url) && !frame.loginRequired,
    );
    const identities = [
      ...new Set(seed.map((frame) => frame.accountId).filter(Boolean)),
    ];
    if (identities.length !== 1)
      throw new Error('请在 Edge 登录学习通并打开个人中心课程列表');
    accountId = identities[0]!;
    if (state.accountId && state.accountId !== accountId) {
      state.queue.phase = state.queue.phase === 'idle' ? 'idle' : 'paused';
      state.queue.note = '账号已切换，请重新选择任务';
      state.courses = [];
      state.tasks = [];
      state.homeworkCache = {};
      state.preparations = {};
      state.currentTaskId = undefined;
      state.progressRefreshedAt = 0;
    }
    state.accountId = accountId;
    const visited = new Set<string>();
    const pending: ReadDoc[] = [];
    const seeds = new Set<string>();
    for (const ref of seed) {
      if (seeds.has(ref.url)) continue;
      seeds.add(ref.url);
      checkScan(signal, accountId);
      const live = await frameCall<ReadDoc>(ref, { op: 'html' });
      // Refresh the observed list page itself; fall back to its DOM for client-rendered lists.
      try {
        const fresh = await offscreen<ReadDoc>(
          {
            op: 'fetch',
            url: ref.url,
            fresh: force || !cacheFresh(state.progressRefreshedAt || undefined),
            purpose: 'catalog',
          },
          signal,
        );
        const parsed = await parse(fresh);
        pending.push(parsed.courses.length ? fresh : live);
      } catch (error) {
        rethrowPlatformBlock(error);
        checkScan(signal, accountId);
        pending.push(live);
      }
    }
    let courseListPartial = false;
    while (pending.length) {
      checkScan(signal, accountId);
      const read = pending.shift()!;
      if (visited.has(read.url)) continue;
      visited.add(read.url);
      const parsed = await parse(read);
      collect(parsed);
      for (const link of parsed.links.filter((l) => l.kind === 'course-list')) {
        if (visited.has(link.url) || !isCourseListUrl(link.url)) continue;
        if (visited.size + pending.length > 100) {
          courseListPartial = true;
          continue;
        }
        try {
          pending.push(
            await offscreen<ReadDoc>(
              { op: 'fetch', url: link.url, fresh: force, purpose: 'catalog' },
              signal,
            ),
          );
        } catch (error) {
          rethrowPlatformBlock(error);
          checkScan(signal, accountId);
          courseListPartial = true;
        }
      }
    }
    const dynamicSeed = seed.find((f) =>
      /\/visit\/(?:interaction|courselist|courses)/.test(f.url),
    );
    if (dynamicSeed) {
      const menu = await frameCall<CatalogMenu>(dynamicSeed, {
        op: 'catalog-menu',
      }).catch((error) => {
        rethrowPlatformBlock(error);
        return undefined;
      });
      if (menu?.actions.length) {
        const tab = await accessPlatform(
          () =>
            chrome.tabs.create({
              url: dynamicSeed.url,
              active: false,
            }),
          {
            signal,
            runId: scanOperationId(),
            accountId,
            check: () => checkScan(signal, accountId),
          },
        );
        scanTab = tab.id;
        if (scanTab !== undefined) ownedTabs.add(scanTab);
        if (scanTab !== undefined) {
          const paths: string[][] = [[]];
          const visitedMenus = new Set<string>();
          while (paths.length && visitedMenus.size < 100) {
            checkScan(signal, accountId);
            const path = paths.shift()!;
            try {
              if (path.length || visitedMenus.size) {
                await accessPlatform(
                  () =>
                    chrome.tabs.update(scanTab!, {
                      url: dynamicSeed.url,
                      active: false,
                    }),
                  {
                    signal,
                    runId: scanOperationId(),
                    accountId,
                    check: () => checkScan(signal, accountId),
                  },
                );
              }
              let refs = await waitForFrames(
                scanTab,
                (f) =>
                  /\/visit\/(?:interaction|courselist|courses)/.test(f.url),
                signal,
              );
              let ref = refs[0]!;
              let currentMenu = await frameCall<CatalogMenu>(ref, {
                op: 'catalog-menu',
              });
              for (const id of path) {
                await accessPlatform(
                  () =>
                    frameCall(
                      ref,
                      {
                        op: 'catalog-open',
                        id,
                        fingerprint: currentMenu.fingerprint,
                      },
                      { signal },
                    ),
                  {
                    signal,
                    runId: scanOperationId(),
                    accountId,
                    check: () => checkScan(signal, accountId),
                  },
                );
                const old = currentMenu.fingerprint;
                let changed = false;
                for (let attempt = 0; attempt < 20; attempt++) {
                  await delay(300, signal);
                  refs = await discoverFrames(scanTab);
                  checkFrames(refs, accountId);
                  ref =
                    refs.find((f) =>
                      /\/visit\/(?:interaction|courselist|courses)/.test(f.url),
                    ) ?? ref;
                  currentMenu = await frameCall<CatalogMenu>(ref, {
                    op: 'catalog-menu',
                  });
                  if (currentMenu.fingerprint !== old) {
                    changed = true;
                    break;
                  }
                }
                if (!changed) throw new Error('课程文件夹或分页未完成加载');
              }
              if (visitedMenus.has(currentMenu.fingerprint)) continue;
              visitedMenus.add(currentMenu.fingerprint);
              const parsed = await parse(
                await frameCall<ReadDoc>(ref, { op: 'html' }),
              );
              collect(parsed);
              for (const action of currentMenu.actions)
                if (path.length < 20) paths.push([...path, action.id]);
                else courseListPartial = true;
            } catch (error) {
              rethrowPlatformBlock(error);
              checkScan(signal, accountId);
              courseListPartial = true;
            }
          }
          if (paths.length) courseListPartial = true;
        }
      }
    }
    if (!newCourses.length)
      throw new Error(
        '未识别到在读课程，请展开课程文件夹或切换到在读课程列表后刷新',
      );
    if (courseListPartial)
      newCourses.forEach((course) =>
        course.warnings.push(
          '部分课程列表分页或文件夹未读取，请展开后刷新进度',
        ),
      );
    checkScan(signal, accountId);
    mergeCourses();
    state.progressRefreshedAt = Date.now();
    if (withHomework) await readHomeworkLists(signal, undefined, force);
    state.scan = {
      ...state.scan,
      phase: 'done',
      completed: newCourses.length,
      total: newCourses.length,
      at: Date.now(),
      note: withHomework
        ? `已更新 ${newCourses.length} 门课程的进度和普通作业列表`
        : `已刷新 ${newCourses.length} 门课程的任务点进度`,
    };
    log(state.scan.note);
  } catch (error) {
    if (error instanceof PlatformAccessError) await holdPlatform(error.block);
    mergeCourses();
    state.scan = {
      ...state.scan,
      phase: state.platformBlock
        ? 'blocked'
        : signal.aborted
          ? 'cancelled'
          : 'error',
      note:
        state.platformBlock?.message ??
        (error instanceof Error ? error.message : '进度刷新失败'),
      at: Date.now(),
    };
    log(state.scan.note, signal.aborted ? 'info' : 'warn');
  } finally {
    if (scanTab !== undefined && state.platformBlock?.tabId !== scanTab)
      await chrome.tabs.remove(scanTab).catch(() => {});
    if (scanTab !== undefined) ownedTabs.delete(scanTab);
    endScan(controller);
    await persist();
  }
}
export function refreshOverview(force = false): Promise<void> {
  return refreshCourseProgress(force, true);
}
