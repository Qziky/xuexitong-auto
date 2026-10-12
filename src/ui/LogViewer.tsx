import { useEffect, useRef, useState } from 'react';
import type { AppState, LogEvent, OperationProgress } from '../domain';
import type { LogQuery } from '../background/journal';
import { STAGE_LABEL } from '../progress';
import { command } from './client';

export function LogViewer({
  state,
  fixedRunId,
  compact = false,
}: {
  state: AppState;
  fixedRunId?: string;
  compact?: boolean;
}) {
  const [runs, setRuns] = useState<OperationProgress[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [runId, setRunId] = useState(fixedRunId ?? '');
  const [taskId, setTaskId] = useState('');
  const [stage, setStage] = useState('');
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<LogQuery['cursor']>();
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const currentFirst = useRef('');
  const generation = useRef(0);
  const query = {
    runId: fixedRunId ?? runId,
    taskId,
    stage,
    level,
    search,
    limit: compact ? 20 : 100,
  };
  useEffect(() => {
    let live = true;
    const revision = ++generation.current;
    currentFirst.current = '';
    follow.current = true;
    setEvents([]);
    setCursor(undefined);
    setError('');
    const refresh = async () => {
      try {
        const [records, page] = await Promise.all([
          command<OperationProgress[]>('log-runs'),
          command<{ events: LogEvent[]; cursor?: LogQuery['cursor'] }>(
            'log-query',
            { query },
          ),
        ]);
        if (!live || generation.current !== revision) return;
        setRuns(records);
        if (follow.current || !currentFirst.current) {
          currentFirst.current = page.events[0]?.id ?? '';
          setEvents(page.events);
          setCursor(page.cursor);
          setUnread(false);
          requestAnimationFrame(() => {
            if (follow.current && list.current)
              list.current.scrollTop = list.current.scrollHeight;
          });
        } else if (page.events[0]?.id !== currentFirst.current) setUnread(true);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : '日志读取失败');
      }
    };
    const initial = setTimeout(() => void refresh(), search ? 300 : 0);
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [fixedRunId, runId, taskId, stage, level, search, compact]);
  async function older() {
    const revision = generation.current;
    follow.current = false;
    try {
      const page = await command<{
        events: LogEvent[];
        cursor?: LogQuery['cursor'];
      }>('log-query', { query: { ...query, cursor } });
      if (revision !== generation.current) return;
      setEvents((old) => [
        ...old,
        ...page.events.filter((e) => !old.some((v) => v.id === e.id)),
      ]);
      setCursor(page.cursor);
    } catch (e) {
      setError(String(e));
    }
  }
  async function exportFile(format: 'json' | 'text') {
    try {
      const data = await command<{
        runs: OperationProgress[];
        events: LogEvent[];
      }>('log-export', { query });
      const text =
        format === 'json'
          ? JSON.stringify(data, null, 2)
          : data.events
              .map(
                (e) =>
                  `${new Date(e.at).toISOString()} [${e.level}] ${e.runId} ${e.stage}${e.questionNumber ? ` 第${e.questionNumber}题` : ''} ${e.message}`,
              )
              .join('\n');
      const url = URL.createObjectURL(
        new Blob([text], {
          type:
            format === 'json' ? 'application/json' : 'text/plain;charset=utf-8',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `chaoxing-log-${Date.now()}.${format === 'json' ? 'json' : 'txt'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className={`log-viewer ${compact ? 'compact' : ''}`}>
      {!compact && (
        <>
          <h2>完整执行日志</h2>
          <p className="subtle">
            默认保留 7 天、最近 100 次已结束运行。日志不包含题目正文或凭据。
          </p>
          <div className="log-filters">
            <select
              aria-label="筛选运行"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
            >
              <option value="">全部运行</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} · {new Date(r.startedAt).toLocaleTimeString()}
                </option>
              ))}
            </select>
            <select
              aria-label="筛选任务"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
            >
              <option value="">全部任务</option>
              {state.tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <select
              aria-label="筛选阶段"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
            >
              <option value="">全部阶段</option>
              {Object.entries(STAGE_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="筛选日志级别"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              <option value="">全部级别</option>
              <option value="info">信息</option>
              <option value="warn">需注意</option>
              <option value="error">错误</option>
            </select>
            <input
              aria-label="搜索日志"
              placeholder="搜索步骤、题号或失败原因"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </>
      )}
      <div className="log-toolbar">
        <button className="text-button" onClick={() => void exportFile('json')}>
          导出 JSON
        </button>
        <button className="text-button" onClick={() => void exportFile('text')}>
          导出文本
        </button>
        {!compact && (
          <button
            className="text-button"
            onClick={() =>
              void command('log-clear')
                .then(() => {
                  setEvents([]);
                  currentFirst.current = '';
                  follow.current = true;
                })
                .catch((e) => setError(String(e)))
            }
          >
            清理已结束日志
          </button>
        )}
      </div>
      {(error || state.logStorageError) && (
        <p role="alert" className="amber">
          {error || state.logStorageError}
        </p>
      )}
      {unread && (
        <button
          className="secondary"
          onClick={() => {
            follow.current = true;
            currentFirst.current = '';
          }}
        >
          有新日志，点击更新
        </button>
      )}
      {cursor && (
        <button className="text-button" onClick={() => void older()}>
          加载更早日志
        </button>
      )}
      <div
        className="log-entries"
        ref={list}
        onScroll={() => {
          if (list.current)
            follow.current =
              list.current.scrollHeight -
                list.current.scrollTop -
                list.current.clientHeight <
              25;
        }}
      >
        {!events.length && !error && (
          <p className="subtle">尚无匹配的日志记录。</p>
        )}
        {[...events].reverse().map((event) => (
          <article className={`log-entry ${event.level}`} key={event.id}>
            <div>
              <time>
                {new Date(event.at).toLocaleTimeString('zh-CN', {
                  hour12: false,
                })}
                .{String(event.at % 1000).padStart(3, '0')}
              </time>
              <span>
                {STAGE_LABEL[event.stage as keyof typeof STAGE_LABEL] ??
                  event.stage}
              </span>
              <span>
                {event.level === 'warn'
                  ? '需注意'
                  : event.level === 'error'
                    ? '错误'
                    : '信息'}
              </span>
            </div>
            <p>{event.message}</p>
            <small>
              {event.questionNumber ? `第 ${event.questionNumber} 题 · ` : ''}
              {event.part ? event.part + ' · ' : ''}
              {event.engine ? event.engine.toUpperCase() + ' · ' : ''}
              {event.durationMs !== undefined
                ? `${(event.durationMs / 1000).toFixed(1)} 秒 · `
                : ''}
              {event.confidence !== undefined
                ? `置信度 ${Math.round(event.confidence)} · `
                : ''}
              {event.code}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}
