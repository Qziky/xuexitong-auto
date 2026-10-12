import { describe, expect, it } from 'vitest';
import {
  initialState,
  type CourseRecord,
  type TaskRecord,
} from '../src/domain';
import {
  assertTaskCapability,
  resolveTask,
  resolveWorkspace,
  taskCapabilities,
  workspaceFromFrame,
  recordVerifiedSubmission,
} from '../src/page-workspace';
import { migrateState } from '../src/state-migration';

describe('当前页与待办能力边界', () => {
  it('服务端提交证据同步已替换的列表对象及工作区，并保留已知成绩', () => {
    const state = initialState();
    const submitted = {
      id: 't',
      accountId: 'a',
      courseId: 'c',
      platformId: '1',
      type: 'homework',
      status: 'pending',
    } as TaskRecord;
    state.tasks = [
      { ...submitted },
      { ...submitted, id: 'other', accountId: 'b', grade: '50' },
    ];
    state.workspaces.w = {
      id: 'w',
      task: { ...submitted, id: 'page:t' },
      taskKey: 'key',
      tabId: 1,
      frameId: 0,
      at: 1,
      capabilities: taskCapabilities(submitted),
    };
    recordVerifiedSubmission(state, submitted, '100');
    expect(state.tasks[0]).toMatchObject({ status: 'submitted', grade: '100' });
    expect(state.workspaces.w.capabilities.fill).toBe(false);
    expect(state.tasks[1]).toMatchObject({ status: 'pending', grade: '50' });
    recordVerifiedSubmission(state, submitted);
    expect(state.tasks[0]!.grade).toBe('100');
  });
  const task = {
    id: 't',
    type: 'homework',
    status: 'pending',
    pageMode: 'answer',
  } as TaskRecord;
  it('同一任务的多个页面优先解析当前工作区', () => {
    const state = initialState();
    const old = {
      id: 'old', task: { ...task, title: '旧页面' }, tabId: 1, frameId: 0,
      taskKey: 'key', at: 1, capabilities: taskCapabilities(task),
    };
    const current = { ...old, id: 'current', tabId: 2, frameId: 8,
      task: { ...task, title: '当前页面' } };
    state.workspaces = { old, current };
    state.currentPage = { kind: 'question', tabId: 2, workspaceId: 'current' } as any;
    expect(resolveWorkspace(state, 't')).toBe(current);
    expect(resolveTask(state, 't')).toBe(current.task);
    expect(resolveTask(state, 'missing')).toBeUndefined();
  });
  it('过期、已提交与预览允许分析并拒绝写入', () => {
    for (const item of [
      { ...task, status: 'expired' as const },
      { ...task, status: 'submitted' as const },
      { ...task, pageMode: 'preview' as const },
    ]) {
      expect(taskCapabilities(item)).toEqual({
        analyze: true,
        fill: false,
        save: false,
        submit: false,
      });
      expect(() => assertTaskCapability(item, 'analyze')).not.toThrow();
      expect(() => assertTaskCapability(item, 'fill')).toThrow('不能填写');
    }
  });
  it('只读页保存在独立工作区，不修改待办', () => {
    const state = initialState();
    state.accountId = 'cx:1';
    state.courses = [
      {
        id: '100:200',
        accountId: 'cx:1',
        courseId: '100',
        classId: '200',
        state: 'active',
      } as CourseRecord,
    ];
    const workspace = workspaceFromFrame(
      {
        url: 'https://mooc1.chaoxing.com/mooc2/work/preview?courseId=100&classId=200&workId=900',
        accountId: 'cx:1',
        tabId: 1,
        frameId: 8,
        top: false,
        taskKey: '100:200:work:900',
        adapter: 'legacy',
        taskKind: 'homework',
        loginRequired: false,
        taskSummary: {
          title: '预览',
          status: 'expired',
          pageMode: 'preview',
          questionCount: 3,
        },
      },
      state,
    )!;
    expect(workspace.task.analysisOnly).toBe(true);
    expect(state.tasks).toHaveLength(0);
    state.workspaces[workspace.id] = workspace;
    expect(resolveTask(state, workspace.task.id)).toBe(workspace.task);
  });
  it('升级保留设置和历史，清理会话并暂停旧学习队列', () => {
    const state = initialState();
    state.learning.phase = 'running';
    state.learning.courseIds = ['c'];
    state.preferences.developerMode = true;
    const migrated = migrateState(state);
    expect(migrated.schema).toBe(2);
    expect(migrated.learning.phase).toBe('paused');
    expect(migrated.learning.courseIds).toEqual(['c']);
    expect(migrated.preferences.developerMode).toBe(true);
    expect(migrated.workspaces).toEqual({});
  });
});
