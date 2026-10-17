import {
  extractAccount,
  extractPage,
  readPageStatus,
  taskKeyFromUrl,
} from '../src/page-parser';
import {
  fillPage,
  liveSnapshot,
  pageButton,
  confirmVisible,
  visible,
  authorizeWrite,
} from '../src/page-actions';
import { catalogMenu, openCatalogAction } from '../src/catalog-navigation';
import type { FrameCommand, FrameInfo } from '../src/messages';
import { boundPageImage, readPageImageResource } from '../src/page-image';
import { describeFrame } from '../src/frame-description';
import {
  learningMenu,
  openLearningChapter,
  learningCardMenu,
  openLearningCard,
} from '../src/learning-parser';
import { describeVideo, VideoPlayer } from '../src/video-player';
import { ReadingAdapter } from '../src/learning-adapters';
import { LearningStarter } from '../src/learning-startup';
import { LearningAdapterError } from '../src/video-player';
import { learningFrameIdentity } from '../src/learning-frame-identity';
import type { VideoBinding } from '../src/video-player';
import {
  assertPlatformPage,
  PlatformAccessError,
} from '../src/platform-access';

export default defineContentScript({
  matches: ['https://*.chaoxing.com/*'],
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: true,
  runAt: 'document_idle',
  main(ctx) {
    let contextActive = true;
    let learningBinding: VideoBinding | undefined;
    const matchesIdentity = (binding: VideoBinding) => {
      const id = identity.current();
      return (
        (!id?.jobId || !binding.jobId || id.jobId === binding.jobId) &&
        (!id?.objectId || !binding.objectId || id.objectId === binding.objectId)
      );
    };
    const identity = learningFrameIdentity(window, () => {
      if (learningBinding && !matchesIdentity(learningBinding)) {
        starter.cancel();
        player.pause();
        reader.pause();
        learningBinding = undefined;
      }
      scheduleReport();
    });
    ctx.onInvalidated(() => identity.close());
    const player = new VideoPlayer(
      document,
      () => location.href,
      async (binding) =>
        matchesIdentity(binding) &&
        (
          await chrome.runtime.sendMessage({
            target: 'background',
            kind: 'video-authorize',
            binding,
          })
        )?.value === true,
      async (binding, video) =>
        matchesIdentity(binding) &&
        (
          await chrome.runtime.sendMessage({
            target: 'background',
            kind: 'video-event',
            binding,
            video,
          })
        )?.value === true,
    );
    ctx.onInvalidated(() => player.pause());
    const reader = new ReadingAdapter(
      document,
      async (binding) =>
        matchesIdentity(binding) &&
        (
          await chrome.runtime.sendMessage({
            target: 'background',
            kind: 'learning-authorize',
            binding,
          })
        )?.value === true,
      async (binding, reading) =>
        matchesIdentity(binding) &&
        (
          await chrome.runtime.sendMessage({
            target: 'background',
            kind: 'reading-event',
            binding,
            reading,
          })
        )?.value === true,
    );
    ctx.onInvalidated(() => reader.pause());
    const starter = new LearningStarter(async (binding, result) => {
      await chrome.runtime.sendMessage({
        target: 'background',
        kind: 'learning-startup',
        binding,
        result,
      });
    });
    ctx.onInvalidated(() => {
      contextActive = false;
      starter.cancel();
      learningBinding = undefined;
    });
    const describe = (): FrameInfo => ({
      ...describeFrame(
        document,
        location.href,
        window === window.top,
        document.cookie,
      ),
      learningIdentity: identity.current(),
    });
    let last = '';
    let lastCompletion = '';
    const report = () => {
      identity.refresh();
      const info = describe();
      const completionKey =
        learningBinding &&
        ['confirmed', 'conflict'].includes(
          info.learningIdentity?.completionState ?? '',
        ) &&
        matchesIdentity(learningBinding)
          ? learningBinding.lease + ':' + JSON.stringify(info.learningIdentity)
          : '';
      if (completionKey && completionKey !== lastCompletion) {
        lastCompletion = completionKey;
        void chrome.runtime
          .sendMessage({
            target: 'background',
            kind: 'learning-completion-observed',
            binding: learningBinding,
            evidence: {
              state: info.learningIdentity?.completionState,
              source: 'card-marker',
              at: Date.now(),
            },
          })
          .catch(() => {
            if (lastCompletion === completionKey) lastCompletion = '';
          });
      }
      const key = JSON.stringify(info);
      if (key !== last) {
        last = key;
        void chrome.runtime
          .sendMessage({ target: 'background', kind: 'frame-ready', info })
          .catch(() => {});
      }
    };
    report();
    let reportTimer: ReturnType<typeof ctx.setTimeout> | undefined;
    const scheduleReport = () => {
      if (!reportTimer)
        reportTimer = ctx.setTimeout(() => {
          reportTimer = undefined;
          report();
        }, 250);
    };
    const observer = new MutationObserver((changes) => {
      const relevant =
        '.TiMu,.questionLi,.workTitle,.ceyan_name,.mark_title,.work_name,.chapter_item,input,textarea,iframe,video,audio,source,style,.ans-job-icon,.ans-attach-ct,#viewerContainer,#docContainer,[data-document-page],[data-reader-scroll]';
      if (
        changes.some((change) => {
          const target =
            change.target instanceof Element
              ? change.target
              : change.target.parentElement;
          return (
            target?.closest(relevant) ||
            [...change.addedNodes, ...change.removedNodes].some(
              (node) =>
                /9010|验证码/.test(node.textContent ?? '') ||
                (node instanceof Element &&
                  (node.matches(relevant) || node.querySelector(relevant))),
            )
          );
        })
      )
        scheduleReport();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class',
        'value',
        'src',
        'checked',
        'style',
        'data',
        'aria-label',
        'aria-busy',
        'data-loaded',
        'data-reader-page',
      ],
    });
    document.addEventListener('input', scheduleReport, true);
    document.addEventListener('change', scheduleReport, true);
    window.addEventListener('pageshow', scheduleReport);
    ctx.onInvalidated(() => observer.disconnect());
    const onMessage: Parameters<
      typeof chrome.runtime.onMessage.addListener
    >[0] = (message, sender, reply) => {
      if (
        !contextActive ||
        sender.id !== chrome.runtime.id ||
        message?.target !== 'content'
      )
        return;
      const command = message.command as FrameCommand;
      (async () => {
        if (!['describe', 'video-pause', 'reader-pause'].includes(command.op))
          assertPlatformPage(location.href, document);
        switch (command.op) {
          case 'learning-card-menu':
            return learningCardMenu(document, location.href);
          case 'learning-card-open':
            openLearningCard(
              document,
              location.href,
              command.actionId,
              command.fingerprint,
            );
            return true;
          case 'reader-start':
            learningBinding = command.binding;
            if (command.deferred)
              return starter.launch(command.binding, async () => {
                if (!matchesIdentity(command.binding))
                  throw new LearningAdapterError(
                    'binding-changed',
                    '阅读任务已变化',
                  );
                return reader.start(
                  command.binding,
                  command.completion,
                  command.settings,
                );
              });
            return reader.start(
              command.binding,
              command.completion,
              command.settings,
            );
          case 'reader-pause':
            starter.cancel();
            learningBinding = undefined;
            reader.pause();
            return true;
          case 'learning-menu':
            return learningMenu(document, location.href);
          case 'learning-open':
            openLearningChapter(
              document,
              location.href,
              command.actionId,
              command.fingerprint,
            );
            return true;
          case 'video-describe':
            return describeVideo(document, location.href);
          case 'video-play':
            learningBinding = command.binding;
            if (command.deferred)
              return starter.launch(command.binding, async () => {
                if (!matchesIdentity(command.binding))
                  throw new LearningAdapterError(
                    'binding-changed',
                    '播放任务已变化',
                  );
                return player.play(
                  command.binding,
                  false,
                  command.requireProgress,
                  command.settings,
                );
              });
            return player.play(
              command.binding,
              false,
              command.requireProgress,
              command.settings,
            );
          case 'video-recover':
            learningBinding = command.binding;
            if (command.deferred)
              return starter.launch(command.binding, async () => {
                if (!matchesIdentity(command.binding))
                  throw new LearningAdapterError(
                    'binding-changed',
                    '恢复任务绑定已变化',
                  );
                return player.recover(command.binding, command.settings);
              });
            return player.recover(command.binding, command.settings);
          case 'video-pause':
            if (command.onlyUnbound) {
              if (
                learningBinding &&
                matchesIdentity(learningBinding) &&
                (
                  await chrome.runtime.sendMessage({
                    target: 'background',
                    kind: 'learning-authorize',
                    binding: learningBinding,
                  })
                )?.value === true
              )
                return true;
              await player.pauseUnbound();
            } else {
              starter.cancel();
              learningBinding = undefined;
              player.pause(true);
              reader.pause();
            }
            return true;
          case 'describe':
            return describe();
          case 'html':
            return {
              html: document.documentElement.outerHTML,
              url: location.href,
              info: describe(),
            };
          case 'catalog-menu':
            return catalogMenu(document, location.href, visible);
          case 'catalog-open':
            openCatalogAction(
              document,
              location.href,
              command.id,
              command.fingerprint,
              visible,
            );
            return true;
          case 'extract': {
            if (document.querySelector('.font-cxsecret')) {
              await Promise.race([
                document.fonts.ready,
                new Promise<void>((_, reject) =>
                  ctx.setTimeout(
                    () => reject(new Error('页面字体加载超时')),
                    10000,
                  ),
                ),
              ]);
            }
            return liveSnapshot();
          }
          case 'image-resource': {
            const page = extractPage(document, location.href, document.cookie);
            const result = await readPageImageResource(
              page,
              command.binding,
              command.imageId,
              command.resourceKey,
            );
            assertPlatformPage(location.href, document);
            boundPageImage(
              extractPage(document, location.href, document.cookie),
              command.binding,
              command.imageId,
              command.resourceKey,
            );
            return result;
          }
          case 'fill':
            return fillPage(command.binding, command.proposals);
          case 'draft':
            return pageButton(command.binding, 'draft');
          case 'submit':
            return pageButton(command.binding, 'submit');
          case 'confirm':
            await authorizeWrite(command.binding, 'confirm');
            return confirmVisible(command.taskKey, command.binding);
          case 'result':
            return {
              ...readPageStatus(document, location.href),
              taskKey: taskKeyFromUrl(location.href, document),
              accountId: extractAccount(document, document.cookie),
              page: extractPage(document, location.href, document.cookie),
            };
          default:
            throw new Error('未知页面操作');
        }
      })().then(
        (value) => reply({ ok: true, value }),
        (error) =>
          reply({
            ok: false,
            error: error instanceof Error ? error.message : '页面处理失败',
            block:
              error instanceof PlatformAccessError ? error.block : undefined,
            errorCode:
              typeof error === 'object' && error !== null && 'code' in error
                ? String(error.code)
                : undefined,
          }),
      );
      return true;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => {
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* The extension context may already have been destroyed. */
      }
    });
  },
});
