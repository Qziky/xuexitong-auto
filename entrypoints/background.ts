import {
  initStore,
  state,
  provider,
  persist,
  log,
  saveProvider,
  saveRecognition,
  saveLearningSettings,
  visionProvider,
  effectiveVisionProvider,
  exportDiagnostics,
} from '../src/background/store';
import {
  frames,
  frameCall,
  offscreen,
  finishJob,
  discoverFrames,
  notifyFrameRegistry,
  invalidateLearningFrames,
  jobHeartbeat,
  requestPlatformAdmission,
  cancelPlatformAdmission,
  requestImageResource,
} from '../src/background/transport';
import {
  refreshOverview,
  refreshCourseProgress,
  cancelScan,
} from '../src/background/scanner';
import {
  refreshHomeworkLists,
  observeHomeworkEntry,
} from '../src/background/homework-scanner';
import {
  prepareActiveTask,
  prepareTask,
  cancelPreparation,
  cancelChangedPreparation,
  cancelInactivePreparation,
} from '../src/background/preparer';
import { ownedTabs } from '../src/background/owned-tabs';
import {
  scheduleActiveTaskObservation,
  cancelTaskObservation,
} from '../src/background/task-observer';
import {
  startQueue,
  pauseQueue,
  resumeQueue,
  cancelChangedExecution,
  acceptQueue,
  acceptResume,
} from '../src/background/executor';
import { editorBridge } from '../src/background/editor';
import { assertWriteOperation } from '../src/background/write-authorization';
import { dueReminders } from '../src/reminders';
import {
  isChaoxingUrl,
  providerPermission,
  isTrustedExtensionSender,
} from '../src/security';
import {
  assertPlatformReady,
  holdPlatform,
  releasePlatformHold,
} from '../src/background/platform';
import {
  detectVerification,
  platformBlockFor,
  PlatformAccessError,
} from '../src/platform-access';
import {
  startTaskAction,
  cancelWorkflow,
  cancelWorkflowAndWait,
  cancelInactiveWorkflow,
  cancelChangedWorkflow,
  manualRunning,
  confirmQuestionText,
} from '../src/background/workflows';
import {
  queryRuns,
  queryLogs,
  exportLogs,
  clearLogs,
} from '../src/background/journal';
import { beginOperation, finishOperation } from '../src/background/operations';
import { checkFrames, scanOperationId } from '../src/background/scan-control';
import { discoverAccountFrames } from '../src/background/learning-frame-access';
import { FrameAccountError } from '../src/background/frame-account';
import { installLearningForegroundController } from '../src/background/learning-foreground';
import {
  startLearning,
  pauseLearning,
  awaitLearningIdle,
  resumeLearning,
  authorizeVideo,
  resourceStartup,
  videoEvent,
  readingEvent,
  completionObserved,
  observeLearningQuestion,
  observeLearningReader,
  retryLearningItems,
} from '../src/background/learning';
import {
  startConnectionTest,
  cancelConnectionTests,
} from '../src/background/connection-tests';
import {
  canAutoResumeAfterWorkerRestart,
  canAutoResumeMissingAccount,
  shouldAutoResumeDiscoveryRetry,
} from '../src/learning-policy';

export default defineBackground(() => {
  const ready = initStore().then(async () => {
    installLearningForegroundController(
      (learningId) =>
        state.learning.id === learningId &&
        state.learning.phase === 'running' &&
        state.learning.accountId === state.accountId &&
        !state.platformBlock,
      (_learningId, error) => {
        void import('../src/background/learning').then((module) =>
          module.interruptLearning(error.message),
        );
      },
    );
    if (state.learning.tabId !== undefined) ownedTabs.add(state.learning.tabId);
    state.queue.items.forEach((item) => {
      if (item.ownedTab && item.tabId !== undefined) ownedTabs.add(item.tabId);
    });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.alarms.create('refresh-courses', { periodInMinutes: 30 });
    await chrome.alarms.create('task-reminders', { periodInMinutes: 15 });
    const verifying = (await discoverFrames()).find(
      (f) => f.verificationRequired,
    );
    if (verifying)
      await holdPlatform({
        ...platformBlockFor(verifying.url),
        tabId: verifying.tabId,
      });
    else {
      scheduleActiveTaskObservation();
      if (
        shouldAutoResumeDiscoveryRetry(
          state.learning,
          state.accountId,
          Boolean(state.platformBlock),
        )
      ) {
        state.learning.phase = 'paused';
        state.learning.index = state.learning.items.length;
        state.learning.note = '待重试章节目录检查点';
        await persist(true);
      }
      if (
        canAutoResumeAfterWorkerRestart(
          state.learning,
          state.accountId,
          Boolean(state.platformBlock),
        )
      ) {
        try {
          const tabIds = [
            state.learning.tabId,
            state.queue.items[state.queue.index]?.tabId,
          ].filter((id): id is number => id !== undefined);
          if (tabIds.length === 0)
            throw new Error('学习页面不可用，无法核验当前登录账号');
          for (const tabId of new Set(tabIds)) {
            const tab = await chrome.tabs.get(tabId).catch(() => undefined);
            if (!tab?.url || !isChaoxingUrl(tab.url))
              throw new Error('学习页面已关闭或不属于超星课程');
            await discoverAccountFrames(tabId, state.learning.accountId);
          }
          resumeLearning();
          log('已复核原账号与课程页面，自动恢复上次中断的学习');
        } catch (error) {
          if (error instanceof PlatformAccessError) {
            await holdPlatform(error.block);
          } else {
            const note = `自动恢复未继续：${error instanceof Error ? error.message : '账号身份复核失败'}`;
            state.learning.note =
              error instanceof FrameAccountError &&
              error.code === 'account-unconfirmed'
                ? error.message
                : note;
            log(note, 'warn');
            await persist(true);
          }
        }
      }
      scheduleScan();
    }
  });
  let accountRecovery: Promise<void> | undefined;
  function recoverMissingAccount(): void {
    const queue = state.learning;
    if (
      accountRecovery ||
      queue.tabId === undefined ||
      !canAutoResumeMissingAccount(
        queue,
        state.accountId,
        Boolean(state.platformBlock),
      )
    )
      return;
    accountRecovery = (async () => {
      // A frame-ready event can arrive while the failed runner is still
      // pausing its old resource. Resume only after its cleanup has finished.
      await awaitLearningIdle();
      if (
        state.learning !== queue ||
        !canAutoResumeMissingAccount(
          queue,
          state.accountId,
          Boolean(state.platformBlock),
        )
      )
        return;
      await discoverAccountFrames(queue.tabId!, queue.accountId);
      if (
        state.learning !== queue ||
        !canAutoResumeMissingAccount(
          queue,
          state.accountId,
          Boolean(state.platformBlock),
        )
      )
        return;
      resumeLearning();
      log('已即时复核当前账号，自动恢复因账号信息暂缺而暂停的学习');
      await persist(true);
    })()
      .catch(async (error) => {
        if (error instanceof PlatformAccessError)
          await holdPlatform(error.block);
        else if (
          state.learning === queue &&
          canAutoResumeMissingAccount(
            queue,
            state.accountId,
            Boolean(state.platformBlock),
          ) &&
          error?.code !== 'account-unconfirmed'
        ) {
          queue.note = error instanceof Error ? error.message : '账号复核失败';
          await persist(true);
        }
      })
      .finally(() => {
        accountRecovery = undefined;
      });
  }
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleScan(force = false): void {
    if (
      !state.preferences.autoScan ||
      state.platformBlock ||
      state.queue.phase === 'running' ||
      state.learning.phase === 'running' ||
      state.scan.phase === 'running' ||
      manualRunning()
    )
      return;
    if (
      !force &&
      state.progressRefreshedAt &&
      Date.now() - state.progressRefreshedAt < 120000
    )
      return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      if (
        !state.preferences.autoScan ||
        state.platformBlock ||
        state.scan.phase === 'running' ||
        state.queue.phase === 'running' ||
        state.learning.phase === 'running' ||
        manualRunning()
      )
        return;
      void refreshOverview()
        .then(remind)
        .catch((error) => {
          log(String(error), 'warn');
          void persist();
        });
    }, 2500);
  }
  async function remind(): Promise<void> {
    for (const reminder of state.preferences.notifications
      ? dueReminders(
          state.tasks.filter((t) => t.accountId === state.accountId),
          state.reminders,
          Date.now(),
          state.courses.filter((c) => c.accountId === state.accountId),
        )
      : []) {
      await chrome.notifications.create(reminder.id, {
        type: 'basic',
        iconUrl: 'icon/128.png',
        title: reminder.title,
        message: reminder.message,
      });
      state.reminders[reminder.id] = Date.now();
    }
    const cutoff = Date.now() - 180 * 86400000;
    state.reminders = Object.fromEntries(
      Object.entries(state.reminders).filter(([, at]) => at > cutoff),
    );
    await persist();
    const badge = state.tasks.filter(
      (t) =>
        t.accountId === state.accountId &&
        t.status === 'pending' &&
        t.listed !== false &&
        (t.type === 'homework' || t.discovery === 'opened'),
    ).length;
    await chrome.action.setBadgeText({ text: badge ? String(badge) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#265bdc' });
    scheduleActiveTaskObservation();
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.target !== 'background')
      return;
    (async () => {
      await ready;
      const trusted = isTrustedExtensionSender(
        sender,
        chrome.runtime.id,
        import.meta.env.DEV,
      );
      if (
        trusted &&
        sender.url?.endsWith('/offscreen.html') &&
        message.kind === 'platform-request'
      ) {
        if (!requestPlatformAdmission(message))
          throw new Error('平台访问申请绑定无效');
        return true;
      }
      if (
        trusted &&
        sender.url?.endsWith('/offscreen.html') &&
        message.kind === 'platform-cancel'
      ) {
        cancelPlatformAdmission(message.id);
        return true;
      }
      if (
        message.kind === 'job-result' &&
        trusted &&
        sender.url?.endsWith('/offscreen.html')
      ) {
        finishJob(message.id, message);
        return true;
      }
      if (
        message.kind === 'heartbeat' &&
        trusted &&
        sender.url?.endsWith('/offscreen.html')
      ) {
        jobHeartbeat(
          message.id,
          typeof message.note === 'string' ? message.note : '',
          message.detail,
          message.sequence,
          message.events,
        );
        return true;
      }
      if (
        trusted &&
        sender.url?.endsWith('/offscreen.html') &&
        message.kind === 'image-resource'
      )
        return requestImageResource(
          message.id,
          message.imageId,
          message.resourceKey,
        );
      if (sender.tab?.id !== undefined && !trusted) {
        if (!sender.url || !isChaoxingUrl(sender.url))
          throw new Error('页面来源无效');
        const frameId = sender.frameId ?? 0;
        if (
          message.kind === 'video-authorize' ||
          message.kind === 'learning-authorize'
        )
          return authorizeVideo(
            message.binding,
            sender.tab.id,
            frameId,
            sender.documentId,
          );
        if (message.kind === 'learning-startup')
          return resourceStartup(
            message.binding,
            message.result,
            sender.tab.id,
            frameId,
            sender.documentId,
          );
        if (message.kind === 'reading-event')
          return readingEvent(
            message.binding,
            message.reading,
            sender.tab.id,
            frameId,
            sender.documentId,
          );
        if (message.kind === 'learning-completion-observed')
          return completionObserved(
            message.binding,
            message.evidence,
            sender.tab.id,
            frameId,
            sender.documentId,
          );
        if (message.kind === 'video-event')
          return videoEvent(
            message.binding,
            message.video,
            sender.tab.id,
            frameId,
            sender.documentId,
          );
        if (message.kind === 'frame-ready') {
          const info = message.info;
          if (!info || info.url !== sender.url)
            throw new Error('页面地址不一致');
          cancelChangedPreparation({ ...info, tabId: sender.tab.id, frameId });
          cancelChangedWorkflow({ ...info, tabId: sender.tab.id, frameId });
          await cancelChangedExecution({
            ...info,
            tabId: sender.tab.id,
            frameId,
          });
          frames.set(`${sender.tab.id}:${frameId}`, {
            ...info,
            parentFrameId: frames.get(`${sender.tab.id}:${frameId}`)
              ?.parentFrameId,
            tabId: sender.tab.id,
            frameId,
            documentId: sender.documentId,
          });
          notifyFrameRegistry(sender.tab.id);
          if (
            (info.video || info.media?.length) &&
            ownedTabs.has(sender.tab.id) &&
            !(
              state.learning.phase === 'running' &&
              state.learning.tabId === sender.tab.id &&
              state.learning.frameId === frameId &&
              ['preparing', 'playing', 'reading', 'verifying'].includes(
                state.learning.items[state.learning.index]?.phase ?? '',
              )
            )
          )
            void frameCall(
              { tabId: sender.tab.id, frameId, documentId: sender.documentId },
              { op: 'video-pause', onlyUnbound: true },
            ).catch(() => {});
          observeHomeworkEntry({ ...info, tabId: sender.tab.id, frameId });
          observeLearningReader({
            ...info,
            tabId: sender.tab.id,
            frameId,
            documentId: sender.documentId,
          });
          observeLearningQuestion({ ...info, tabId: sender.tab.id, frameId });
          if (info.verificationRequired || detectVerification(sender.url)) {
            clearTimeout(autoTimer);
            cancelTaskObservation();
            cancelPreparation();
            cancelWorkflow();
            await holdPlatform({
              ...platformBlockFor(sender.url),
              tabId: sender.tab.id,
            });
            cancelScan();
            if (state.queue.phase === 'paused')
              await pauseQueue(false, state.platformBlock!.message);
            return true;
          }
          const accountIssue =
            info.loginRequired ||
            Boolean(
              info.accountId &&
              state.accountId &&
              info.accountId !== state.accountId,
            );
          const learningAccountIssue =
            state.learning.phase === 'running' &&
            state.learning.tabId === sender.tab.id &&
            (info.loginRequired ||
              Boolean(
                info.accountId && info.accountId !== state.learning.accountId,
              ));
          const queueItem = state.queue.items[state.queue.index];
          const queueAccountIssue =
            state.queue.phase === 'running' &&
            queueItem?.tabId === sender.tab.id &&
            (info.loginRequired ||
              Boolean(
                info.accountId && info.accountId !== state.queue.accountId,
              ));
          const scanAccountIssue =
            state.scan.phase === 'running' &&
            ownedTabs.has(sender.tab.id) &&
            (info.loginRequired || accountIssue);
          const hasActiveRun =
            state.learning.phase === 'running' ||
            state.queue.phase === 'running' ||
            state.scan.phase === 'running';
          if (
            accountIssue &&
            (!hasActiveRun ||
              learningAccountIssue ||
              queueAccountIssue ||
              scanAccountIssue)
          ) {
            cancelTaskObservation();
            cancelPreparation();
            cancelWorkflow();
            state.currentTaskId = undefined;
            state.preparations = {};
            state.workspaces = {};
            state.currentPage = undefined;
            if (learningAccountIssue)
              await pauseLearning(false, '登录失效或账号已变化');
          }
          if (queueAccountIssue)
            await pauseQueue(
              false,
              info.loginRequired
                ? '登录已失效，请重新登录后继续'
                : '登录账号已变化，请重新扫描并选择任务',
            );
          if (scanAccountIssue)
            cancelScan(
              info.loginRequired
                ? '登录已失效，请重新登录'
                : '登录账号已变化，请重新刷新进度',
            );
          if (
            /\/visit\/interaction|\/base(?:[/?]|$)/.test(sender.url) &&
            info.accountId &&
            !info.loginRequired
          )
            scheduleScan(info.accountId !== state.accountId);
          if (!ownedTabs.has(sender.tab.id)) scheduleActiveTaskObservation();
          if (
            !info.loginRequired &&
            info.accountId &&
            info.accountId === state.learning.accountId
          )
            recoverMissingAccount();
          return true;
        }
        if (message.kind === 'authorize-write') {
          if (!['fill', 'draft', 'submit', 'confirm'].includes(message.action))
            throw new Error('写入动作无效');
          assertWriteOperation(
            message.binding,
            sender.tab.id,
            frameId,
            message.action,
          );
          return true;
        }
        if (message.kind === 'editor') {
          if (
            !message.binding?.taskKey ||
            !/^[\w:]+$/.test(message.binding.taskKey)
          )
            throw new Error('编辑器绑定无效');
          if (message.action === 'write') {
            if (message.binding.operationId)
              assertWriteOperation(
                message.binding,
                sender.tab.id,
                frameId,
                'fill',
              );
            const item = state.queue.items[state.queue.index];
            const workflow = Object.values(state.workflows).find(
              (w) =>
                w.phase === 'running' &&
                w.action === 'fill' &&
                w.stage === 'filling' &&
                w.tabId === sender.tab!.id &&
                w.frameId === frameId,
            );
            const prepared = workflow
              ? state.preparations[workflow.taskId]
              : undefined;
            const manualWrite =
              prepared?.accountId === state.accountId &&
              prepared?.fingerprint === message.binding.fingerprint &&
              prepared?.taskKey === message.binding.taskKey;
            if (
              !manualWrite &&
              (state.queue.phase !== 'running' ||
                item?.tabId !== sender.tab.id ||
                item.stage !== 'filling' ||
                item.snapshot?.fingerprint !== message.binding.fingerprint ||
                item.snapshot?.taskKey !== message.binding.taskKey)
            )
              throw new Error('没有对应的编辑器写入任务');
          } else if (message.action !== 'read')
            throw new Error('编辑器操作无效');
          return editorBridge(
            sender.tab.id,
            frameId,
            message.binding,
            message.action,
            message.action === 'read'
              ? (message.ids ?? []).map((id: string) => ({ id }))
              : (message.values ?? []),
          );
        }
        throw new Error('页面无权访问扩展配置或执行队列');
      }
      if (!trusted) throw new Error('扩展消息来源无效');
      switch (message.kind) {
        case 'start-learning':
          return startLearning(
            message.courseIds,
            message.range,
            message.goal,
            message.policy,
            message.selectedTypes,
          );
        case 'pause-learning':
          await pauseLearning(message.stop === true);
          return true;
        case 'resume-learning':
          return resumeLearning();
        case 'retry-learning':
          return retryLearningItems();
        case 'open-learning': {
          const current = state.learning.items[state.learning.index];
          const item = message.itemId
            ? state.learning.items.find((i) => i.id === message.itemId)
            : current;
          if (!item || state.learning.accountId !== state.accountId)
            throw new Error('学习任务已失效，请检查账号');
          if (
            item === current &&
            [
              'preparing',
              'playing',
              'reading',
              'executing',
              'verifying',
            ].includes(item.phase) &&
            state.learning.tabId !== undefined &&
            (await chrome.tabs.get(state.learning.tabId).catch(() => undefined))
          )
            await chrome.tabs.update(state.learning.tabId, { active: true });
          else await chrome.tabs.create({ url: item.url, active: true });
          return true;
        }
        case 'workspace-action': {
          if (['fill', 'draft', 'submit'].includes(message.action))
            await pauseLearning(false, '已暂停学习，正在处理当前页答案');
          const workspace = state.workspaces[message.workspaceId];
          if (
            !workspace ||
            workspace.bindingRevision !== message.bindingRevision ||
            workspace.task.accountId !== state.accountId
          )
            throw new Error('当前页绑定已变化，请返回当前页后重试');
          return startTaskAction(
            workspace.task.id,
            message.action,
            message.questionId,
            message.resultRevision,
            'reference',
          );
        }
        case 'export-questions': {
          const record = state.preparations[message.id];
          if (!record?.decoded || !record.snapshot)
            throw new Error('请先识别文字，再导出已有结果');
          return (await import('../src/question-export')).exportQuestions(
            record.snapshot,
            record.proposals ?? [],
            message.options,
          );
        }
        case 'state':
          return (await import('../src/background/store')).stateSnapshot();
        case 'refresh-overview':
        case 'refresh-progress':
          assertPlatformReady();
          if (state.learning.phase === 'running')
            throw new Error('请先暂停学习队列再刷新');
          if (state.queue.phase === 'running')
            throw new Error('请先暂停答题队列');
          if (state.scan.phase === 'running')
            throw new Error('已有扫描正在进行，请等待完成或取消');
          void (
            message.kind === 'refresh-progress'
              ? refreshCourseProgress(true)
              : refreshOverview(true)
          )
            .then(remind)
            .catch((error) => {
              log(String(error), 'warn');
              void persist();
            });
          return { operationId: scanOperationId() };
        case 'refresh-homework-list':
          assertPlatformReady();
          if (state.learning.phase === 'running')
            throw new Error('请先暂停学习队列再刷新');
          if (state.queue.phase === 'running')
            throw new Error('请先暂停答题队列');
          if (state.scan.phase === 'running')
            throw new Error('已有扫描正在进行，请等待完成或取消');
          if (
            typeof message.courseId !== 'string' ||
            !state.courses.some(
              (course) =>
                course.id === message.courseId &&
                course.accountId === state.accountId &&
                course.state === 'active',
            )
          )
            throw new Error('课程不属于当前账号的在读清单');
          void refreshHomeworkLists(message.courseId, true)
            .then(remind)
            .catch((error) => {
              log(String(error), 'warn');
              void persist();
            });
          return { operationId: scanOperationId() };
        case 'task-action':
          if (['fill', 'draft', 'submit'].includes(message.action))
            await pauseLearning(false, '已暂停学习，正在处理当前页答案');
          return startTaskAction(
            message.id,
            message.action,
            message.questionId,
            message.expectedRevision,
            message.intent === 'reference' ? 'reference' : 'execution',
          );
        case 'confirm-question-text':
          return confirmQuestionText(
            message.id,
            message.questionId,
            message.expectedRevision,
            message.text,
          );
        case 'prepare-current-task':
          if (!state.currentTaskId) throw new Error('尚未识别到当前任务');
          return startTaskAction(state.currentTaskId, 'decode');
        case 'prepare-task': {
          if (typeof message.id !== 'string') throw new Error('任务选择无效');
          const task = state.tasks.find(
            (item) =>
              item.id === message.id && item.accountId === state.accountId,
          );
          if (!task) throw new Error('任务不属于当前账号');
          return startTaskAction(task.id, 'decode');
        }
        case 'cancel-preparation':
          cancelWorkflow();
          cancelPreparation();
          return true;
        case 'answer-policy':
          if (!['preserve', 'overwrite'].includes(message.policy))
            throw new Error('答题策略无效');
          if (state.queue.phase === 'running')
            throw new Error('请先暂停执行队列');
          cancelPreparation();
          cancelWorkflow();
          state.draftPolicy = message.policy;
          (await import('../src/cache-invalidation')).invalidateCandidates(
            state,
            () => false,
          );
          for (const record of Object.values(state.preparations))
            record.policy = state.draftPolicy;
          await persist();
          return true;
        case 'cancel-scan':
          cancelScan();
          return true;
        case 'open-verification': {
          const block = state.platformBlock;
          if (!block || block.kind !== 'captcha')
            throw new Error('当前没有待处理的平台验证');
          const existing =
            block.tabId === undefined
              ? undefined
              : await chrome.tabs.get(block.tabId).catch(() => undefined);
          if (existing?.url && isChaoxingUrl(existing.url))
            await chrome.tabs.update(existing.id!, { active: true });
          else if (block.url && detectVerification(block.url))
            await chrome.tabs.create({ url: block.url, active: true });
          else throw new Error('请在出现验证码的超星页面手动完成验证');
          return true;
        }
        case 'resume-platform': {
          const all = await discoverFrames();
          if (all.some((f) => f.verificationRequired))
            throw new Error('平台验证码页面仍未完成，请先手动验证');
          if (!all.some((f) => f.accountId && !f.loginRequired))
            throw new Error('请先回到已登录的个人中心课程列表');
          if (state.scan.phase === 'running')
            throw new Error('正在结束上次扫描，请稍后继续');
          await releasePlatformHold();
          void refreshOverview(true)
            .then(remind)
            .catch((error) => {
              log(String(error), 'warn');
              void persist();
            });
          return true;
        }
        case 'complete-tasks':
          cancelConnectionTests();
          return acceptQueue(
            message.ids,
            message.policy,
            message.goal ?? 'submit',
            async () => {
              await pauseLearning(false, '已暂停学习，开始处理所选作业');
              await cancelWorkflowAndWait();
            },
          );
        case 'cancel-workflow':
          cancelWorkflow(message.id);
          return true;
        case 'cancel-operation':
          cancelConnectionTests(message.operationId);
          return true;
        case 'log-runs':
          return queryRuns();
        case 'log-query':
          return queryLogs(message.query);
        case 'log-export':
          return exportLogs(message.query);
        case 'log-clear':
          await clearLogs();
          return true;
        case 'pause':
          cancelWorkflow();
          await pauseLearning();
          await pauseQueue();
          return true;
        case 'resume':
          cancelConnectionTests();
          return acceptResume(cancelWorkflowAndWait);
        case 'stop':
          cancelWorkflow();
          await pauseLearning(true);
          await pauseQueue(true);
          return true;
        case 'save-provider': {
          cancelConnectionTests();
          const permission = providerPermission(
            message.config.baseUrl ?? provider.baseUrl,
          );
          if (!(await chrome.permissions.contains({ origins: [permission] })))
            throw new Error('请先授权模型服务域名');
          cancelPreparation();
          cancelWorkflow();
          if (state.queue.phase === 'running')
            await pauseQueue(false, '模型设置已变化，继续时重新生成答案');
          if (
            state.learning.phase === 'running' &&
            state.learning.items[state.learning.index]?.type === 'quiz'
          )
            await pauseLearning(false, '模型配置已变化');
          await saveProvider(message.config, message.removeKey);
          return true;
        }
        case 'test-provider':
          return startConnectionTest('test', provider);
        case 'save-learning-settings':
          await saveLearningSettings(message.settings);
          return true;
        case 'save-recognition': {
          cancelConnectionTests();
          if (message.recognition?.visionService === 'independent') {
            const permission = providerPermission(
              message.config?.baseUrl ?? visionProvider.baseUrl,
            );
            if (!(await chrome.permissions.contains({ origins: [permission] })))
              throw new Error('请先授权视觉服务域名');
          }
          cancelPreparation();
          cancelWorkflow();
          if (state.queue.phase === 'running')
            await pauseQueue(false, '文字识别设置已变化，继续时重新生成答案');
          if (
            state.learning.phase === 'running' &&
            state.learning.items[state.learning.index]?.type === 'quiz'
          )
            await pauseLearning(false, '识别配置已变化');
          await saveRecognition(
            message.recognition,
            message.config,
            message.removeKey,
          );
          return true;
        }
        case 'test-vision': {
          if (state.queue.phase === 'running')
            throw new Error('请先暂停执行队列再测试视觉连接');
          const config = effectiveVisionProvider();
          const permission = providerPermission(config.baseUrl);
          if (!(await chrome.permissions.contains({ origins: [permission] })))
            throw new Error('请先授权视觉服务域名');
          return startConnectionTest(
            'test-vision',
            config,
            state.recognition.visionConcurrency,
          );
        }
        case 'preferences':
          state.preferences = { ...state.preferences, ...message.value };
          await persist();
          return true;
        case 'open-task': {
          const task = state.tasks.find((t) => t.id === message.id);
          if (!task || !isChaoxingUrl(task.url))
            throw new Error('任务入口无效');
          const item = state.queue.items.find((i) => i.taskId === task.id);
          if (
            item?.tabId !== undefined &&
            (await chrome.tabs.get(item.tabId).catch(() => undefined))
          )
            await chrome.tabs.update(item.tabId, { active: true });
          else await chrome.tabs.create({ url: task.url, active: true });
          return true;
        }
        case 'open-course': {
          const c = state.courses.find((c) => c.id === message.id);
          if (c) await chrome.tabs.create({ url: c.url, active: true });
          return true;
        }
        case 'open-homework-list': {
          const c = state.courses.find(
            (c) => c.id === message.id && c.accountId === state.accountId,
          );
          if (!c) throw new Error('课程入口无效');
          const cached =
            state.homeworkCache[`${c.accountId}:${c.id}`]?.entryUrls[0];
          await chrome.tabs.create({ url: cached ?? c.url, active: true });
          return true;
        }
        case 'open-login':
          await chrome.tabs.create({
            url: 'https://i.chaoxing.com/',
            active: true,
          });
          return true;
        case 'export':
          return exportDiagnostics();
        default:
          throw new Error('未知操作');
      }
    })().then(
      (value) => reply({ ok: true, value }),
      (error) =>
        reply({
          ok: false,
          error: error instanceof Error ? error.message : '扩展操作失败',
          ...(error instanceof PlatformAccessError
            ? { block: error.block }
            : {}),
        }),
    );
    return true;
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    void ready
      .then(async () => {
        if (
          alarm.name === 'refresh-courses' &&
          state.preferences.autoScan &&
          !state.platformBlock &&
          state.scan.phase !== 'running' &&
          state.queue.phase !== 'running' &&
          state.learning.phase !== 'running' &&
          !manualRunning()
        )
          await refreshOverview();
        await remind();
      })
      .catch((error) => {
        log(String(error), 'warn');
        void persist();
      });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    invalidateLearningFrames(tabId);
    const childTabId =
      state.queue.learningId === state.learning.id &&
      state.queue.phase === 'running'
        ? state.queue.items[state.queue.index]?.tabId
        : undefined;
    if (
      (state.learning.tabId === tabId || childTabId === tabId) &&
      state.learning.phase === 'running'
    )
      void pauseLearning(false, '前台学习标签页已关闭');
    ownedTabs.delete(tabId);
    for (const w of Object.values(state.workflows))
      if (w.tabId === tabId && w.phase === 'running') cancelWorkflow(w.taskId);
    if (
      Object.values(state.preparations).some((record) => record.tabId === tabId)
    )
      cancelPreparation();
    for (const [key, ref] of frames)
      if (ref.tabId === tabId) frames.delete(key);
    scheduleActiveTaskObservation();
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void ready.then(() => {
      cancelInactiveWorkflow(tabId);
      cancelInactivePreparation(tabId);
      scheduleActiveTaskObservation();
    });
  });
  chrome.webNavigation?.onBeforeNavigate?.addListener((event) => {
    invalidateLearningFrames(event.tabId, event.frameId);
    if (detectVerification(event.url))
      void holdPlatform({ ...platformBlockFor(event.url), tabId: event.tabId });
  });
  chrome.webNavigation?.onCommitted?.addListener((event) =>
    invalidateLearningFrames(event.tabId, event.frameId),
  );
  chrome.windows.onFocusChanged.addListener(() => {
    void ready.then(() => scheduleActiveTaskObservation());
  });
  chrome.notifications.onClicked.addListener(() => {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (tabs[0]?.windowId !== undefined)
          void chrome.sidePanel.open({ windowId: tabs[0].windowId });
      });
  });
});
