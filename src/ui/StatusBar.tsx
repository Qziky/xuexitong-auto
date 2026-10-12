import { useEffect, useRef } from 'react';
import type { AppState, OperationProgress } from '../domain';
import { STAGE_LABEL, connectionHealth } from '../progress';
import { elapsed, useClock } from './Clock';
import { learningPhaseLabels, learningProgress } from './learning-progress';
export function stageLabel(run: OperationProgress): string {
  return run.kind === 'learning'
    ? '自动学习'
    : run.kind === 'scan'
      ? '更新待办'
      : run.stage === 'restoring'
        ? '识别文字'
        : run.stage === 'solving'
          ? '生成参考'
          : STAGE_LABEL[run.stage];
}
export function StatusBar({
  state,
  onAction,
  onQueue,
}: {
  state: AppState;
  onAction(kind: string, extra?: Record<string, unknown>): void;
  onQueue(): void;
}) {
  const now = useClock(),
    stopped = useRef(new Set<string>());
  const runs = Object.values(state.operations)
    .filter((r) => r.phase === 'running')
    .sort((a, b) => b.startedAt - a.startedAt);
  const run =
    runs.find((r) => r.kind === 'manual') ??
    runs.find((r) => r.kind === 'queue') ??
    runs[0];
  const health = run ? connectionHealth(run.lastHeartbeatAt, now) : 'online';
  useEffect(() => {
    if (!run || health !== 'lost' || stopped.current.has(run.id)) return;
    stopped.current.add(run.id);
    onAction(
      run.kind === 'manual'
        ? 'cancel-workflow'
        : run.kind === 'learning'
          ? 'pause-learning'
          : run.kind === 'scan'
            ? 'cancel-scan'
            : run.kind === 'test'
              ? 'cancel-operation'
              : 'pause',
      { id: run.taskId, operationId: run.id },
    );
  }, [run?.id, health]);
  if (!run) return null;
  const learningItem =
    run.kind === 'learning' && state.learning.runId === run.id
      ? state.learning.items[state.learning.index]
      : undefined;
  const platformRemaining = Math.max(
    0,
    ((run.platformWaitUntil ?? 0) - Date.now()) / 1000,
  );
  const cancel =
    run.kind === 'manual'
      ? 'cancel-workflow'
      : run.kind === 'learning'
        ? 'pause-learning'
        : run.kind === 'scan'
          ? 'cancel-scan'
          : run.kind === 'test'
            ? 'cancel-operation'
            : 'stop';
  return (
    <section className="status-strip" aria-live="polite">
      <div className="status-line">
        <span className="spinner" />
        <strong>{stageLabel(run)}</strong>
        <time>{elapsed(now - run.startedAt)}</time>
        <button onClick={onQueue} className="quiet">
          详情
        </button>
        {run.kind !== 'scan' && (
          <button
            className="quiet"
            onClick={() =>
              onAction(run.kind === 'learning' ? 'pause-learning' : 'pause')
            }
          >
            暂停
          </button>
        )}
        <button
          className="quiet"
          onClick={() =>
            onAction(cancel, {
              id: run.taskId,
              operationId: run.id,
              stop: run.kind === 'learning',
            })
          }
        >
          取消
        </button>
      </div>
      {learningItem && run.waiting !== 'platform' ? (
        <>
          <small>
            {state.courses.find((c) => c.id === learningItem.courseId)?.title}
            {learningItem.chapterTitle && ' / ' + learningItem.chapterTitle}
          </small>
          <p>
            {learningItem.title} · {learningPhaseLabels[learningItem.phase]}
          </p>
          <p>{learningProgress(learningItem)}</p>
          {learningItem.note && <small>{learningItem.note}</small>}
          {state.learning.note?.startsWith('连接异常') && (
            <small className="warning">{state.learning.note}</small>
          )}
        </>
      ) : (
        <p>{run.note}</p>
      )}
      {run.waiting === 'platform' &&
        run.platformWaitUntil !== undefined &&
        platformRemaining > 0 && (
          <small>访问间隔剩余 {platformRemaining.toFixed(1)} 秒</small>
        )}
      {!learningItem && run.total !== undefined && run.done !== undefined && (
        <div className="actual-progress">
          <progress max={Math.max(1, run.total)} value={run.done} />
          <span>
            {run.done}/{run.total}
          </span>
        </div>
      )}
      {run.waiting === 'model' && (
        <small>
          等待模型响应 ·{' '}
          {elapsed(now - (run.requestStartedAt ?? run.stageStartedAt))} / 最长{' '}
          {run.timeoutSec ?? 180} 秒 · 第 {run.attempt ?? 1} 次请求
        </small>
      )}
      {health !== 'online' && (
        <small className="warning">
          后台连接异常 · 最后心跳{' '}
          {Math.floor((now - run.lastHeartbeatAt) / 1000)} 秒前；60 秒失联将中止
        </small>
      )}
      <details>
        <summary>查看进度明细</summary>
        <div className="metric-chips">
          {run.readSource && (
            <span>
              读取来源：
              {
                {
                  page: '已加载页面',
                  cache: '缓存',
                  network: '网络',
                  shared: '共享请求',
                }[run.readSource]
              }
            </span>
          )}
          {run.platformRequests !== undefined && (
            <span>实际访问 {run.platformRequests} 次</span>
          )}
          {run.questionNumber !== undefined && (
            <span>
              第 {run.questionNumber} 题 {run.part}
            </span>
          )}
          {run.success !== undefined && (
            <span>
              确认 {run.success} · 检查 {run.review ?? 0}
            </span>
          )}
          {run.active !== undefined && (
            <span>
              进行中 {run.active} · 排队 {run.queued ?? 0}
            </span>
          )}
          {run.globalLimit !== undefined && (
            <span>
              总并发 {run.globalActive ?? 0}/{run.globalLimit}
            </span>
          )}
          <span>最后实际进展 {elapsed(now - run.lastProgressAt)} 前</span>
        </div>
      </details>
    </section>
  );
}
