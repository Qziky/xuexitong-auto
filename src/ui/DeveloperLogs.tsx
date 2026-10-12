import { useEffect, useRef, useState } from 'react';
import type { AppState, LogEvent, OperationProgress } from '../domain';
import { command } from './client';
import { STAGE_LABEL } from '../progress';
import { elapsed } from './Clock';
import type { LogQuery } from '../background/journal';
export function DeveloperLogs({ state }: { state: AppState }) {
  const [runs, setRuns] = useState<OperationProgress[]>([]),
    [runId, setRunId] = useState('');
  const [events, setEvents] = useState<LogEvent[]>([]),
    [cursor, setCursor] = useState<LogQuery['cursor']>();
  const [stage, setStage] = useState(''),
    [level, setLevel] = useState(''),
    [search, setSearch] = useState(''),
    [taskId, setTaskId] = useState(''),
    [error, setError] = useState('');
  const revision = Object.values(state.operations)
    .map((r) => r.id + ':' + r.seq + ':' + r.phase)
    .join('|');
  const query = {
    runId: runId || undefined,
    taskId: taskId || undefined,
    stage: stage || undefined,
    level: level || undefined,
    search: search || undefined,
  };
  const queryRef = useRef(query);
  queryRef.current = query;
  const mounted = useRef(true),
    pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    lastFetch = useRef(0),
    queryKey = useRef(''),
    generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pending.current) clearTimeout(pending.current);
    };
  }, []);
  useEffect(() => {
    const key = JSON.stringify(query),
      changed = queryKey.current !== key;
    if (changed) {
      queryKey.current = key;
      generation.current++;
      if (pending.current) clearTimeout(pending.current);
      pending.current = undefined;
    }
    if (pending.current) return;
    pending.current = setTimeout(
      () => {
        pending.current = undefined;
        lastFetch.current = Date.now();
        const currentQuery = queryRef.current,
          currentKey = JSON.stringify(currentQuery),
          sequence = ++generation.current;
        void Promise.all([
          command<OperationProgress[]>('log-runs'),
          command<{ events: LogEvent[]; cursor?: LogQuery['cursor'] }>(
            'log-query',
            { query: currentQuery },
          ),
        ])
          .then(([records, page]) => {
            if (
              mounted.current &&
              sequence === generation.current &&
              currentKey === JSON.stringify(queryRef.current)
            ) {
              setRuns(records);
              setEvents(page.events);
              setCursor(page.cursor);
              setError('');
            }
          })
          .catch((e) => {
            if (mounted.current && sequence === generation.current)
              setError(String(e));
          });
      },
      changed ? 200 : Math.max(0, 500 - (Date.now() - lastFetch.current)),
    );
  }, [revision, runId, taskId, stage, level, search]);
  async function download(format: 'json' | 'txt') {
    try {
      const data = await command<{
        runs: OperationProgress[];
        events: LogEvent[];
      }>('log-export', { query });
      const text =
        format === 'json'
          ? JSON.stringify(data, null, 2)
          : '\uFEFF' +
            data.events
              .map(
                (e) =>
                  new Date(e.at).toLocaleString('zh-CN') +
                  ' [' +
                  e.level +
                  '] ' +
                  e.runId +
                  ' ' +
                  e.stage +
                  ' ' +
                  e.message,
              )
              .join('\r\n');
      const url = URL.createObjectURL(
        new Blob([text], {
          type:
            format === 'json' ? 'application/json' : 'text/plain;charset=utf-8',
        }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = '运行日志.' + format;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="developer-logs">
      <h1>运行日志</h1>
      <p className="subtle">
        阶段和请求记录 · 保留 7 天，最多 100 次已结束运行
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
              {r.title} · {new Date(r.startedAt).toLocaleTimeString('zh-CN')}
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
            <option value={t.id} key={t.id}>
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
          {Object.entries(STAGE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {value === 'restoring' ? '识别文字' : label}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选级别"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="">全部级别</option>
          <option value="info">信息</option>
          <option value="warn">需注意</option>
          <option value="error">错误</option>
        </select>
        <input
          value={search}
          aria-label="搜索日志"
          placeholder="搜索步骤、题号、失败原因"
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="inline-actions">
        <button onClick={() => void download('json')}>导出 JSON</button>
        <button onClick={() => void download('txt')}>导出文本</button>
        <button
          onClick={() =>
            void command('log-clear')
              .then(() => {
                setEvents([]);
                setRuns([]);
              })
              .catch((e) => setError(String(e)))
          }
        >
          清理已结束运行
        </button>
      </div>
      {(error || state.logStorageError) && (
        <p className="warning">{error || state.logStorageError}</p>
      )}
      {runs
        .filter((r) => !runId || r.id === runId)
        .map((run) => (
          <details className="run-card" key={run.id} open={run.id === runId}>
            <summary>
              <strong>{run.title}</strong>
              <span>
                {run.phase === 'running'
                  ? '进行中'
                  : run.phase === 'waiting-user'
                    ? '等待继续'
                    : run.phase === 'done'
                      ? '已结束'
                      : run.note}
              </span>
              <time>
                {elapsed((run.finishedAt ?? run.updatedAt) - run.startedAt)}
              </time>
            </summary>
            <div className="run-meta">
              运行编号 {run.id}
              <br />
              {new Date(run.startedAt).toLocaleString('zh-CN')}
            </div>
            <ol className="stage-timeline">
              {events
                .filter((e) => e.runId === run.id)
                .slice()
                .reverse()
                .map((event) => (
                  <li className={event.level} key={event.id}>
                    <details>
                      <summary>
                        <span>
                          {event.questionNumber
                            ? '第 ' + event.questionNumber + ' 题 · '
                            : ''}
                          {event.message}
                        </span>
                        <time>
                          {new Date(event.at).toLocaleTimeString('zh-CN', {
                            hour12: false,
                          })}
                        </time>
                      </summary>
                      <div className="request-metrics">
                        <span>
                          阶段：
                          {STAGE_LABEL[
                            event.stage as keyof typeof STAGE_LABEL
                          ] ?? event.stage}
                        </span>
                        <span>记录：{event.code}</span>
                        {event.engine && (
                          <span>引擎：{event.engine.toUpperCase()}</span>
                        )}
                        {event.confidence !== undefined && (
                          <span>评分：{Math.round(event.confidence)}</span>
                        )}
                        {event.attempt !== undefined && (
                          <span>尝试：{event.attempt}</span>
                        )}
                        {event.durationMs !== undefined && (
                          <span>耗时：{elapsed(event.durationMs)}</span>
                        )}
                        {event.readSource && (
                          <span>
                            读取来源：
                            {
                              {
                                page: '已加载页面',
                                cache: '缓存',
                                network: '网络',
                                shared: '共享请求',
                              }[event.readSource]
                            }
                          </span>
                        )}
                      </div>
                    </details>
                  </li>
                ))}
            </ol>
          </details>
        ))}
      {cursor && (
        <button
          className="secondary"
          onClick={() =>
            void command<{ events: LogEvent[]; cursor?: LogQuery['cursor'] }>(
              'log-query',
              { query: { ...query, cursor } },
            ).then((p) => {
              setEvents((v) => [...v, ...p.events]);
              setCursor(p.cursor);
            })
          }
        >
          加载更早记录
        </button>
      )}
    </section>
  );
}
