import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  initialState,
  type TaskRecord,
  type TaskPreparation,
} from '../src/domain';
import { Workspace, workspaceStep } from '../src/ui/Workspace';
import { StatusBar } from '../src/ui/StatusBar';
import { LearningSettingsPanel } from '../src/ui/LearningSettings';
import { Queues } from '../src/ui/Queues';
const task: TaskRecord = {
  id: 't',
  accountId: 'a',
  courseId: 'c',
  platformId: '1',
  url: 'https://mooc1.chaoxing.com/work/do',
  title: '作业',
  type: 'homework',
  status: 'pending',
  source: { at: 1, url: '', label: 'test' },
};
it('keeps a verification-only draft recovery entry after preparation cache is cleared', () => {
  const state = initialState();
  state.workflows.t = {
    taskId: 't',
    runId: 'r',
    stage: 'verifying',
    phase: 'review',
    steps: {},
    filled: true,
    readbackVerified: true,
    draftAttempted: true,
    expectedDigest: 'e',
  };
  const html = renderToStaticMarkup(
    createElement(Workspace, {
      state,
      task,
      onAction: vi.fn(),
      onDetails: vi.fn(),
      onExport: vi.fn(),
      onSettings: vi.fn(),
      onComplete: vi.fn(),
    }),
  );
  expect(html).toContain('核验上次草稿');
  expect(html).not.toContain('>保存草稿<');
  expect(html).not.toContain('>提交答案<');
});
it('learning status shows live scrolling rather than a stale starting note or invented page count', () => {
  const state = initialState(),
    now = Date.now();
  state.learning.runId = 'r';
  state.learning.phase = 'running';
  state.learning.items = [
    {
      id: 'i',
      courseId: 'c',
      chapterId: '1',
      title: '课件',
      url: '',
      type: 'document',
      phase: 'reading',
      readerMode: 'scroll',
      scrollPosition: 123.4,
      note: '等待平台要求的阅读时长',
    },
  ];
  state.operations.r = {
    id: 'r',
    kind: 'learning',
    phase: 'running',
    stage: 'checking',
    title: '学习',
    note: '启动阅读',
    startedAt: now,
    updatedAt: now,
    stageStartedAt: now,
    lastHeartbeatAt: now,
    lastProgressAt: now,
    seq: 0,
  };
  const html = renderToStaticMarkup(
    createElement(StatusBar, { state, onAction: vi.fn(), onQueue: vi.fn() }),
  );
  expect(html).toContain('滚动位置 123 像素 · 页数未知');
  expect(html).toContain('等待平台要求的阅读时长');
  expect(html).not.toContain('启动阅读');
  expect(html).not.toContain('<progress');
  expect(html).not.toContain('已阅读 0');
});
it('reading pace has an independent settings entry with the supported range and next-task explanation', () => {
  const html = renderToStaticMarkup(
    createElement(LearningSettingsPanel, {
      state: initialState(),
      onError: vi.fn(),
      onRefresh: vi.fn(),
    }),
  );
  expect(html).toContain('min="0.25"');
  expect(html).toContain('max="5"');
  expect(html).toContain('value="1"');
  expect(html).toContain('下一任务生效');
  expect(html).toContain('value="0.25"');
  expect(html).toContain('优先 2 倍速');
});
function ready() {
  const state = initialState();
  state.provider.hasKey = true;
  state.preparations.t = {
    taskId: 't',
    accountId: 'a',
    courseId: 'c',
    tabId: 1,
    frameId: 0,
    taskKey: 't',
    fingerprint: 'f',
    existingDigest: 'e',
    providerRevision: 0,
    policy: 'preserve',
    phase: 'decoded',
    decoded: true,
    at: 1,
    snapshot: {
      adapter: 'modern',
      taskKey: 't',
      fingerprint: 'f',
      url: '',
      title: '作业',
      status: 'pending',
      questions: [
        {
          id: 'q',
          number: 1,
          type: 'single',
          stem: '题目',
          options: [],
          existing: [],
          blanks: [],
          issues: [],
          required: true,
        },
      ],
    },
  } satisfies TaskPreparation;
  return state;
}
it('only shows the real remaining platform wait and clears it for cache results or expired waits', () => {
  const state = initialState(),
    now = Date.now();
  state.operations.r = {
    id: 'r',
    kind: 'scan',
    phase: 'running',
    stage: 'checking',
    title: '读取',
    note: '等待访问间隔',
    startedAt: now,
    updatedAt: now,
    stageStartedAt: now,
    lastHeartbeatAt: now,
    lastProgressAt: now,
    seq: 0,
    waiting: 'platform',
    platformWaitUntil: now + 300,
    platformRequests: 1,
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(StatusBar, { state, onAction: vi.fn(), onQueue: vi.fn() }),
    );
  expect(render()).toContain('访问间隔剩余 0.3 秒');
  expect(render()).not.toContain('至少');
  state.operations.r.platformWaitUntil = Date.now() - 1;
  expect(render()).not.toContain('访问间隔剩余');
  state.operations.r.waiting = undefined;
  state.operations.r.platformWaitUntil = undefined;
  state.operations.r.note = '使用缓存';
  state.operations.r.readSource = 'cache';
  const html = render();
  expect(html).toContain('使用缓存');
  expect(html).toContain('读取来源：缓存');
  expect(html).not.toContain('访问间隔剩余');
});
it('stage depends on confirmed data; incomplete readback never advances to submit', () => {
  const state = initialState();
  expect(workspaceStep(state, 't')).toBe(0);
  state.preparations = ready().preparations;
  expect(workspaceStep(state, 't')).toBe(1);
  state.preparations.t!.proposals = [
    { questionId: 'q', needsReview: false, source: 'own', explanation: '' },
  ];
  expect(workspaceStep(state, 't')).toBe(1);
  state.preparations.t!.proposals = [
    { questionId: 'q', needsReview: false, source: 'model', explanation: '' },
  ];
  expect(workspaceStep(state, 't')).toBe(2);
  state.workflows.t = {
    taskId: 't',
    runId: 'r',
    stage: 'readback',
    phase: 'review',
    steps: {},
    filled: true,
    readbackVerified: false,
  };
  expect(workspaceStep(state, 't')).toBe(2);
  state.workflows.t.readbackVerified = true;
  expect(workspaceStep(state, 't')).toBe(3);
});
it('opening a detected page renders one primary recognition button without invoking actions', () => {
  const action = vi.fn(),
    state = initialState();
  const html = renderToStaticMarkup(
    createElement(Workspace, {
      state,
      task: { ...task, questionCount: 30 },
      onAction: action,
      onDetails: vi.fn(),
      onExport: vi.fn(),
      onSettings: vi.fn(),
      onComplete: vi.fn(),
    }),
  );
  expect(html).toContain('检测到 30 道题');
  expect(html.match(/main-action/g)).toHaveLength(1);
  expect(action).not.toHaveBeenCalled();
});
it('read-only reference has no fill, save, submit or complete actions', () => {
  const state = ready();
  state.preparations.t!.proposals = [
    { questionId: 'q', needsReview: false, source: 'model', explanation: '' },
  ];
  const html = renderToStaticMarkup(
    createElement(Workspace, {
      state,
      task: { ...task, analysisOnly: true, status: 'submitted' },
      onAction: vi.fn(),
      onDetails: vi.fn(),
      onExport: vi.fn(),
      onSettings: vi.fn(),
      onComplete: vi.fn(),
    }),
  );
  expect(html).toContain('参考已生成');
  expect(html).toContain('导出 TXT');
  expect(html).not.toContain('>填写答案<');
  expect(html).not.toContain('>保存草稿<');
  expect(html).not.toContain('一键处理');
});
it('a server-verified draft remains at the submission checkpoint', () => {
  const state = ready();
  state.preparations.t!.proposals = [
    { questionId: 'q', needsReview: false, source: 'model', explanation: '' },
  ];
  state.workflows.t = {
    taskId: 't',
    runId: 'r',
    stage: 'verifying',
    phase: 'done',
    steps: {},
    filled: true,
    readbackVerified: true,
    draftAttempted: true,
    draftVerified: true,
  };
  const html = renderToStaticMarkup(
    createElement(Workspace, {
      state,
      task,
      onAction: vi.fn(),
      onDetails: vi.fn(),
      onExport: vi.fn(),
      onSettings: vi.fn(),
      onComplete: vi.fn(),
    }),
  );
  expect(html).toContain('可继续提交答案');
  expect(html).toContain('>提交答案<');
  expect(html).toContain('>草稿已保存<');
});
it('an ambiguous submit offers verification even on a read-only page, without a second submit button', () => {
  const state = ready();
  state.workflows.t = {
    taskId: 't',
    runId: 'r',
    stage: 'verifying',
    phase: 'review',
    steps: {},
    submitAttempted: true,
  };
  const html = renderToStaticMarkup(
    createElement(Workspace, {
      state,
      task: { ...task, status: 'submitted', analysisOnly: true },
      onAction: vi.fn(),
      onDetails: vi.fn(),
      onExport: vi.fn(),
      onSettings: vi.fn(),
      onComplete: vi.fn(),
    }),
  );
  expect(html).toContain('>核验上次提交<');
  expect(html).not.toContain('>提交答案<');
});
it('run history can return to the task result after platform navigation', () => {
  const state = ready();
  state.tasks = [task];
  state.operations.r = {
    id: 'r',
    taskId: 't',
    kind: 'manual',
    stage: 'verifying',
    phase: 'review',
    title: '作业',
    note: '结果待确认',
    startedAt: 1,
    updatedAt: 2,
    stageStartedAt: 1,
    lastProgressAt: 2,
    lastHeartbeatAt: 2,
    seq: 1,
  };
  const html = renderToStaticMarkup(
    createElement(Queues, {
      state,
      onAction: vi.fn(),
      onCurrent: vi.fn(),
      onLogs: vi.fn(),
    }),
  );
  expect(html).toContain('>查看处理结果<');
});
