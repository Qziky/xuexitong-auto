import type { AppState } from '../domain';
import { elapsed } from './Clock';
import { LEARNING_LABELS as learningTypeLabel } from '../learning-policy';
import {
  learningPhaseLabels as itemPhases,
  learningProgress,
} from './learning-progress';
const phases = {
  idle: '尚未开始',
  running: '进行中',
  paused: '已暂停',
  stopped: '已停止',
  done: '已结束',
};
export function Queues({
  state,
  onAction,
  onCurrent,
  onLogs,
}: {
  state: AppState;
  onAction(kind: string, extra?: Record<string, unknown>): void;
  onCurrent(id: string): void;
  onLogs(): void;
}) {
  const learning = state.learning,
    item = learning.items[learning.index];
  const completed = learning.items.filter((i) => i.phase === 'done').length;
  const failed = learning.items.filter(
    (i) => i.phase === 'failed' || i.phase === 'review',
  ).length;
  const pending = learning.items.filter(
    (i) => i.phase === 'review' && /待确认/.test(i.note ?? ''),
  ).length;
  return (
    <section className="queues">
      <h1>队列与记录</h1>
      {learning.phase !== 'idle' && (
        <section className="queue-card">
          <div className="section-heading">
            <h2>自动学习</h2>
            <span className="tag">{phases[learning.phase]}</span>
          </div>
          <p>{learning.note}</p>
          <div className="learning-counts">
            <span>
              {learning.discovered ? '任务' : '已发现'}{' '}
              <strong>{learning.items.length}</strong>
            </span>
            <span>
              完成 <strong>{completed}</strong>
            </span>
            <span>
              需检查 <strong>{failed - pending}</strong>
            </span>
            <span>
              待确认 <strong>{pending}</strong>
            </span>
          </div>
          {item && (
            <div className="playing-item">
              <small>
                {state.courses.find((c) => c.id === item.courseId)?.title}{' '}
                {item.chapterTitle && ' / ' + item.chapterTitle}
              </small>
              <strong>{item.title}</strong>
              <p>
                {learningTypeLabel[item.type]} · {itemPhases[item.phase]}
              </p>
              {['video', 'audio'].includes(item.type) && (
                <>
                  <div className="play-position">{learningProgress(item)}</div>
                  <small>
                    {item.platformComplete
                      ? '平台确认已完成'
                      : '等待平台确认任务点状态'}
                  </small>
                </>
              )}
              {['document', 'image'].includes(item.type) && (
                <p className="play-position">{learningProgress(item)}</p>
              )}
              {item.note && (
                <small className="learning-note">{item.note}</small>
              )}
              {(item.completionEvidence || item.attempts || item.errorCode) && (
                <details className="learning-detail">
                  <summary>核验与恢复详情</summary>
                  {item.attempts ? (
                    <p>已使用恢复次数：{Math.min(item.attempts, 2)} / 2</p>
                  ) : null}
                  {item.errorCode && <p>错误：{item.errorCode}</p>}
                  {item.completionEvidence && (
                    <p>
                      完成证据：
                      {item.completionEvidence.source === 'configuration'
                        ? '平台任务配置'
                        : item.completionEvidence.source === 'catalog'
                          ? '章节目录'
                          : '任务容器标记'}{' '}
                      ·{' '}
                      {item.completionEvidence.fresh
                        ? '最新服务器读取'
                        : '已加载页面'}
                      {item.completionState === 'conflict' && ' · 证据冲突'}
                    </p>
                  )}
                </details>
              )}
              <button onClick={() => onAction('open-learning')}>
                打开处理页
              </button>
            </div>
          )}
          <div className="inline-actions">
            {learning.phase === 'paused' && (
              <button
                className="primary"
                onClick={() => onAction('resume-learning')}
              >
                继续学习
              </button>
            )}
            {learning.phase === 'running' && (
              <button onClick={() => onAction('pause-learning')}>
                暂停学习
              </button>
            )}
            {['running', 'paused'].includes(learning.phase) && (
              <button
                onClick={() => onAction('pause-learning', { stop: true })}
              >
                停止学习
              </button>
            )}
            {learning.phase !== 'running' &&
              learning.items.some(
                (i) =>
                  ['failed', 'review'].includes(i.phase) &&
                  i.type !== 'unknown',
              ) && (
                <button onClick={() => onAction('retry-learning')}>
                  重试失败项
                </button>
              )}
          </div>
          <details className="learning-detail">
            <summary>查看任务与问题（{learning.items.length}）</summary>
            <ul className="queue-items">
              {learning.items.map((it, index) => (
                <li
                  key={it.id}
                  className={index === learning.index ? 'current' : ''}
                >
                  <strong>{it.title}</strong>
                  <span>
                    {learningTypeLabel[it.type]} · {itemPhases[it.phase]}
                  </span>
                  {it.note && <small>{it.note}</small>}
                  {['review', 'failed'].includes(it.phase) && (
                    <button
                      className="quiet"
                      onClick={() =>
                        onAction('open-learning', { itemId: it.id })
                      }
                    >
                      打开检查
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      {state.queue.items.length > 0 && (
        <section className="queue-card">
          <div className="section-heading">
            <h2>答题队列</h2>
            <span className="tag">{phases[state.queue.phase]}</span>
          </div>
          <p>{state.queue.note}</p>
          <div className="inline-actions">
            {state.queue.phase === 'paused' &&
              (!state.queue.learningId ||
                (state.queue.learningId === state.learning.id &&
                  ['paused', 'stopped'].includes(state.learning.phase))) && (
                <button
                  className="primary"
                  onClick={() =>
                    onAction(
                      state.queue.learningId ? 'resume-learning' : 'resume',
                    )
                  }
                >
                  {state.queue.learningId ? '继续学习' : '继续答题'}
                </button>
              )}
            {state.queue.phase === 'running' && (
              <button onClick={() => onAction('pause')}>暂停</button>
            )}
            {['paused', 'running'].includes(state.queue.phase) && (
              <button onClick={() => onAction('stop')}>停止</button>
            )}
          </div>
          <ul className="queue-items">
            {state.queue.items.map((it) => (
              <li key={it.taskId}>
                <button className="quiet" onClick={() => onCurrent(it.taskId)}>
                  {state.tasks.find((t) => t.id === it.taskId)?.title ?? '任务'}
                </button>
                <span>
                  {it.stage === 'submitted'
                    ? '已完成'
                    : it.stage === 'review'
                      ? '需检查'
                      : it.stage === 'draft-saved'
                        ? '草稿'
                        : it.stage}
                </span>
                {it.note && <small>{it.note}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!state.queue.items.length && learning.phase === 'idle' && (
        <div className="empty-card">
          还没有执行队列。可从待办选择作业或开始学习。
        </div>
      )}
      <details className="run-history">
        <summary>最近处理结果</summary>
        {Object.values(state.operations)
          .filter((r) => r.phase !== 'running')
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, 20)
          .map((r) => (
            <div key={r.id}>
              <strong>{r.title}</strong>
              <small>{r.note}</small>
              <time>{new Date(r.startedAt).toLocaleString('zh-CN')}</time>
              {r.taskId &&
                (state.tasks.some((t) => t.id === r.taskId) ||
                  Object.values(state.workspaces).some(
                    (w) => w.task.id === r.taskId,
                  )) && (
                  <button
                    className="quiet"
                    onClick={() => onCurrent(r.taskId!)}
                  >
                    查看处理结果
                  </button>
                )}
            </div>
          ))}
      </details>
      {state.preferences.developerMode && (
        <button className="secondary" onClick={onLogs}>
          查看开发者日志
        </button>
      )}
    </section>
  );
}
