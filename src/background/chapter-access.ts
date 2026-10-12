import type { ChapterEntry } from '../learning-parser';
import { isChaoxingUrl } from '../security';
import { ownedTabs } from './owned-tabs';
import { accessPlatform, type PlatformActionOptions } from './platform';
import {
  assertFramesAccessible,
  frameChangeOrTimeout,
  frameCall,
  type FrameRef,
} from './transport';
import { discoverFrames } from './learning-frame-access';

type ChapterEntryOptions = Omit<PlatformActionOptions, 'signal'> & {
  foregroundTarget?: (tabId: number) => Promise<void> | void;
};

/** Capture the platform's real navigation; never synthesize chapter/card URLs. */
export async function chapterCardEntry(
  ref: FrameRef,
  chapter: ChapterEntry,
  fingerprint: string,
  signal: AbortSignal,
  options: ChapterEntryOptions = {},
): Promise<{ url: string; tabId: number; openedTabIds: number[] }> {
  const openedTabIds: number[] = [];
  const active = await chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .catch(() => []);
  const listener = (
    event: chrome.webNavigation.WebNavigationSourceCallbackDetails,
  ) => {
    if (event.sourceTabId !== ref.tabId || signal.aborted) return;
    if (event.url && !isChaoxingUrl(event.url) && event.url !== 'about:blank')
      return;
    openedTabIds.push(event.tabId);
    ownedTabs.add(event.tabId);
    if (options.foregroundTarget && event.url && isChaoxingUrl(event.url)) {
      void Promise.resolve(options.foregroundTarget(event.tabId)).catch(
        () => {},
      );
    } else if (active[0]?.id !== undefined) {
      // Standalone chapter navigation preserves the user's current tab.
      void chrome.tabs
        .get(event.tabId)
        .then((tab) => {
          if (tab.active)
            return chrome.tabs.update(active[0]!.id!, { active: true });
        })
        .catch(() => {});
    }
  };
  chrome.webNavigation.onCreatedNavigationTarget.addListener(listener);
  try {
    const { foregroundTarget: _foregroundTarget, ...platformOptions } = options;
    const expected = new URL(
      chapter.url ?? ref.url ?? 'https://i.chaoxing.com/',
    );
    const belongs = (address: URL) =>
      ['courseid', 'clazzid', 'cpi'].every(
        (key) =>
          !expected.searchParams.has(key) ||
          address.searchParams.get(key) === expected.searchParams.get(key),
      );
    const existing = await discoverFrames(ref.tabId, signal);
    assertFramesAccessible(existing);
    const reusable = existing.find((f) => {
      const p = new URL(f.url);
      return (
        /\/knowledge\/cards$/.test(p.pathname) &&
        belongs(p) &&
        (p.searchParams.get('knowledgeid') ??
          p.searchParams.get('chapterId')) === chapter.id &&
        (!f.learningCardIdentity ||
          (f.learningCardIdentity.ready &&
            f.learningCardIdentity.chapterId === chapter.id))
      );
    });
    if (reusable) return { url: reusable.url, tabId: ref.tabId, openedTabIds };
    let navigationError: unknown;
    try {
      await accessPlatform(
        () =>
          frameCall(
            ref,
            {
              op: 'learning-open',
              actionId: chapter.actionId,
              fingerprint,
            },
            { signal },
          ),
        { ...platformOptions, signal },
      );
    } catch (error) {
      if (
        signal.aborted ||
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        !['frame-disconnected', 'frame-timeout'].includes(String(error.code))
      )
        throw error;
      // The click may have navigated its own document before replying.
      // Observe the exact target; never repeat a potentially successful click.
      navigationError = error;
    }
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      if (signal.aborted) throw new Error('学习已暂停');
      await options.check?.();
      for (const tabId of [ref.tabId, ...openedTabIds]) {
        const frames = await discoverFrames(tabId, signal);
        assertFramesAccessible(frames);
        for (const frame of frames) {
          const url = new URL(frame.url);
          if (
            /\/knowledge\/cards$/.test(url.pathname) &&
            belongs(url) &&
            (url.searchParams.get('knowledgeid') ??
              url.searchParams.get('chapterId')) === chapter.id &&
            (!frame.learningCardIdentity ||
              (frame.learningCardIdentity.ready &&
                frame.learningCardIdentity.chapterId === chapter.id))
          )
            return { url: frame.url, tabId, openedTabIds };
        }
      }
      await frameChangeOrTimeout(Math.min(1000, end - Date.now()), signal);
    }
    throw (
      navigationError ?? new Error('未找到平台打开的章节卡片，请手动打开检查')
    );
  } catch (error) {
    await closeChapterTabs(openedTabIds);
    try {
      await options.foregroundTarget?.(ref.tabId);
    } catch {
      // Preserve the navigation error; the learning queue will pause if focus
      // cannot be restored to its verified source page.
    }
    throw error;
  } finally {
    chrome.webNavigation.onCreatedNavigationTarget.removeListener(listener);
  }
}
export async function closeChapterTabs(ids: number[]): Promise<void> {
  for (const id of ids) {
    await chrome.tabs.remove(id).catch(() => {});
    ownedTabs.delete(id);
  }
}
