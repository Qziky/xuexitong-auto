import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, ConfirmedQuestionText, TaskAction } from '../domain';
import { taskCapabilities } from '../page-workspace';
import type { QuestionExportOptions } from '../question-export';
import { command, preview } from './client';
import { ClockProvider } from './Clock';
import { useExtensionState } from './useExtensionState';
import { StatusBar } from './StatusBar';
import { Workspace } from './Workspace';
import { Todos } from './Todos';
import { Queues } from './Queues';
import { Settings } from './Settings';
import { QuestionDetails, type QuestionFilter } from './QuestionDetails';
import { DeveloperLogs } from './DeveloperLogs';
type Route = {
  kind: 'todo' | 'page' | 'settings' | 'details' | 'queue' | 'logs';
  taskId?: string;
  courseId?: string;
  filter?: QuestionFilter;
};
function followedRoute(state: AppState): Route {
  const page = state.currentPage;
  return page?.kind === 'home'
    ? { kind: 'todo' }
    : page?.kind === 'course'
      ? { kind: 'todo', courseId: page.courseId }
      : { kind: 'page' };
}
export function App() {
  return (
    <ClockProvider>
      <AppShell />
    </ClockProvider>
  );
}
function AppShell() {
  const { state, sync, connectionError } = useExtensionState();
  const [route, setRoute] = useState<Route>({ kind: 'page' }),
    [follow, setFollow] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const latest = useRef(state),
    routeRef = useRef(route),
    followRef = useRef(follow),
    returning = useRef<Route>({ kind: 'page' });
  latest.current = state;
  routeRef.current = route;
  followRef.current = follow;
  const contextKey = [
    state.currentPage?.kind,
    state.currentPage?.courseId,
    state.currentPage?.workspaceId,
    state.currentPage?.tabId,
  ].join(':');
  useEffect(() => {
    if (followRef.current) setRoute(followedRoute(state));
  }, [follow, contextKey]);
  const selectedId =
    route.taskId ??
    (state.currentPage?.workspaceId
      ? state.workspaces[state.currentPage.workspaceId]?.task.id
      : undefined);
  const task =
    Object.values(state.workspaces).find((w) => w.task.id === selectedId)
      ?.task ?? state.tasks.find((t) => t.id === selectedId);
  const record = selectedId ? state.preparations[selectedId] : undefined;
  const onAction = useCallback(
    (kind: string, extra: Record<string, unknown> = {}) => {
      setError('');
      setNotice('');
      void command(kind, extra).catch((e) =>
        setError(e instanceof Error ? e.message : '操作失败'),
      );
    },
    [],
  );
  const taskAction = useCallback(
    (action: TaskAction, questionId?: string) => {
      const s = latest.current,
        r = routeRef.current;
      const id =
        r.taskId ??
        (s.currentPage?.workspaceId
          ? s.workspaces[s.currentPage.workspaceId]?.task.id
          : undefined);
      if (!id) {
        setError('请先打开题目页');
        return;
      }
      const workspace =
        Object.values(s.workspaces).find(
          (w) => w.task.id === id && w.id === s.currentPage?.workspaceId,
        ) ?? Object.values(s.workspaces).find((w) => w.task.id === id);
      const preparation = s.preparations[id];
      onAction(
        workspace ? 'workspace-action' : 'task-action',
        workspace
          ? {
              workspaceId: workspace.id,
              bindingRevision: workspace.bindingRevision,
              action,
              questionId,
              resultRevision: preparation?.resultRevision,
            }
          : {
              id,
              action,
              questionId,
              expectedRevision: preparation?.resultRevision,
              intent: 'reference',
            },
      );
    },
    [onAction],
  );
  const confirm = useCallback(
    (questionId: string, text: ConfirmedQuestionText) => {
      const s = latest.current,
        r = routeRef.current,
        id =
          r.taskId ??
          (s.currentPage?.workspaceId
            ? s.workspaces[s.currentPage.workspaceId]?.task.id
            : undefined);
      if (id)
        onAction('confirm-question-text', {
          id,
          questionId,
          expectedRevision: s.preparations[id]?.resultRevision,
          text,
        });
    },
    [onAction],
  );
  const exportTxt = useCallback((options: QuestionExportOptions = {}) => {
    const s = latest.current,
      r = routeRef.current,
      id =
        r.taskId ??
        (s.currentPage?.workspaceId
          ? s.workspaces[s.currentPage.workspaceId]?.task.id
          : undefined);
    void command<{ filename: string; text: string }>('export-questions', {
      id,
      options,
    })
      .then((data) => {
        const url = URL.createObjectURL(
          new Blob([data.text], { type: 'text/plain;charset=utf-8' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = data.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('TXT 已导出，使用已有识别结果。');
      })
      .catch((e) => setError(e instanceof Error ? e.message : '导出失败'));
  }, []);
  function navigate(next: Route) {
    followRef.current = false;
    setFollow(false);
    setRoute(next);
    setError('');
    setNotice('');
  }
  function backToCurrent() {
    followRef.current = true;
    setFollow(true);
    setRoute(followedRoute(state));
    setError('');
  }
  function details(filter: QuestionFilter = 'all') {
    returning.current = route;
    navigate({ kind: 'details', taskId: selectedId, filter });
  }
  const activeNav =
    route.kind === 'settings' || route.kind === 'logs'
      ? 'settings'
      : route.kind === 'todo' || route.kind === 'queue'
        ? 'todo'
        : 'page';
  return (
    <div className="app-shell">
      <header className="app-header">
        <strong>课程任务助手</strong>
        <span className="account-state">
          {preview ? '界面预览' : state.accountId ? '已登录' : '等待登录'}
        </span>
        {!follow && (
          <button className="quiet" onClick={backToCurrent}>
            返回当前页
          </button>
        )}
      </header>
      <nav className="main-nav" aria-label="主导航">
        <button
          aria-current={activeNav === 'todo' ? 'page' : undefined}
          onClick={() => navigate({ kind: 'todo' })}
        >
          待办
        </button>
        <button
          aria-current={activeNav === 'page' ? 'page' : undefined}
          onClick={() => {
            setFollow(true);
            setRoute({ kind: 'page' });
          }}
        >
          当前页
        </button>
        <button
          aria-current={activeNav === 'settings' ? 'page' : undefined}
          onClick={() => navigate({ kind: 'settings' })}
        >
          设置
        </button>
      </nav>
      <StatusBar
        state={state}
        onAction={onAction}
        onQueue={() => navigate({ kind: 'queue' })}
      />
      {state.platformBlock && (
        <div className="platform-alert">
          <strong>平台访问已暂停</strong>
          <p>{state.platformBlock.message}</p>
          <div className="inline-actions">
            {state.platformBlock.kind === 'captcha' && (
              <button onClick={() => onAction('open-verification')}>
                打开验证页
              </button>
            )}
            <button onClick={() => onAction('resume-platform')}>
              手动处理后恢复
            </button>
          </div>
        </div>
      )}
      {(error || connectionError) && (
        <div className="message error" role="alert">
          {error || connectionError}
          <button
            className="quiet"
            onClick={() => {
              setError('');
              void sync();
            }}
          >
            重试连接
          </button>
        </div>
      )}
      {notice && (
        <div className="message">
          {notice}
          <button className="quiet" onClick={() => setNotice('')}>
            关闭
          </button>
        </div>
      )}
      {state.logStorageError && state.preferences.developerMode && (
        <div className="message error">
          日志存储失败：{state.logStorageError}
        </div>
      )}
      <main
        className={
          'main-content ' + (route.kind === 'details' ? 'detail-content' : '')
        }
      >
        {route.kind === 'todo' && (
          <Todos
            state={state}
            courseId={route.courseId}
            onAction={onAction}
            onCurrent={(id) => navigate({ kind: 'page', taskId: id })}
            onQueue={() => navigate({ kind: 'queue' })}
          />
        )}
        {route.kind === 'page' && (
          <Workspace
            state={state}
            task={task}
            onAction={taskAction}
            onDetails={details}
            onExport={() => exportTxt()}
            onSettings={() => navigate({ kind: 'settings' })}
            onComplete={(goal) => {
              if (task) {
                onAction('complete-tasks', {
                  ids: [task.id],
                  policy: state.draftPolicy,
                  goal,
                });
                navigate({ kind: 'queue' });
              }
            }}
          />
        )}
        {route.kind === 'details' && record?.snapshot && (
          <QuestionDetails
            state={state}
            record={record}
            initialFilter={route.filter}
            onBack={() => setRoute(returning.current)}
            onAction={taskAction}
            onConfirm={confirm}
            onExport={exportTxt}
          />
        )}
        {route.kind === 'details' && !record?.snapshot && (
          <div className="empty-card">
            <p>请先识别文字。</p>
            <button onClick={() => setRoute(returning.current)}>
              返回当前步骤
            </button>
          </div>
        )}
        {route.kind === 'settings' && (
          <>
            <Settings
              key={state.accountId}
              state={state}
              onError={setError}
              onRefresh={sync}
            />
            <section className="settings-card">
              <h2>开发者模式</h2>
              <label className="toggle-row">
                <span>
                  <strong>详细运行日志</strong>
                  <small>显示运行卡片、阶段时间线和请求记录</small>
                </span>
                <input
                  type="checkbox"
                  checked={state.preferences.developerMode}
                  onChange={(e) =>
                    onAction('preferences', {
                      value: { developerMode: e.target.checked },
                    })
                  }
                />
              </label>
              {state.preferences.developerMode && (
                <button onClick={() => navigate({ kind: 'logs' })}>
                  查看完整日志
                </button>
              )}
            </section>
          </>
        )}
        {route.kind === 'queue' && (
          <Queues
            state={state}
            onAction={onAction}
            onCurrent={(id) => navigate({ kind: 'page', taskId: id })}
            onLogs={() => navigate({ kind: 'logs' })}
          />
        )}
        {route.kind === 'logs' && state.preferences.developerMode && (
          <>
            <button
              className="back-button"
              onClick={() => navigate({ kind: 'settings' })}
            >
              ← 返回设置
            </button>
            <DeveloperLogs state={state} />
          </>
        )}
      </main>
      {(route.kind === 'page' || route.kind === 'todo') && (
        <footer className="policy-footer">
          {!(task && route.kind === 'page' && !taskCapabilities(task).fill) && (
            <label>
              已有答案
              <select
                aria-label="已有答案策略"
                value={state.draftPolicy}
                disabled={Object.values(state.operations).some(
                  (r) => r.phase === 'running' && r.kind !== 'learning',
                )}
                onChange={(e) =>
                  onAction('answer-policy', { policy: e.target.value })
                }
              >
                <option value="preserve">保留并补空</option>
                <option value="overwrite">覆盖重做</option>
              </select>
            </label>
          )}
          <small>
            {task && route.kind === 'page' && !taskCapabilities(task).fill
              ? '只读页不会修改答案'
              : '填写前核验页面，提交后核验结果'}
          </small>
        </footer>
      )}
    </div>
  );
}
