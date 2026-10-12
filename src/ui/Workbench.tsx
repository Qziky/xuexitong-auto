import { useEffect, useState } from 'react';
import type {
  AppState,
  OperationProgress,
  TaskAction,
  WorkflowStage,
} from '../domain';
import { completeAnswer, needsSolve } from '../answers';
import { STAGE_LABEL, connectionHealth } from '../progress';
import { LogViewer } from './LogViewer';

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function useClock(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
const PHASE = {
  running: '正在执行',
  'waiting-user': '等待你继续',
  done: '已完成',
  review: '需检查',
  error: '执行失败',
  cancelled: '已中断',
  paused: '已暂停',
};
export function LiveProgress({
  run,
  compact = false,
}: {
  run: OperationProgress;
  compact?: boolean;
}) {
  const now = useClock();
  const platformRemaining = Math.max(
    0,
    ((run.platformWaitUntil ?? 0) - Date.now()) / 1000,
  );
  const end = run.phase === 'running' ? now : (run.finishedAt ?? run.updatedAt);
  const health =
    run.phase === 'running'
      ? connectionHealth(run.lastHeartbeatAt, now)
      : 'online';
  return (
    <div
      className={`live-progress ${compact ? 'compact' : ''}`}
      aria-live="polite"
    >
      <div className="live-heading">
        <span className={`live-dot ${run.phase}`} />
        <strong>
          {STAGE_LABEL[run.stage]} · {PHASE[run.phase]}
        </strong>
        <time>{elapsed(end - run.startedAt)}</time>
      </div>
      <p className="live-note">{run.note}</p>
      {!compact && (
        <>
          <div className="live-metrics">
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
            <span>本步骤 {elapsed(end - run.stageStartedAt)}</span>
            {run.questionNumber !== undefined && (
              <span>
                第 {run.questionNumber} 题{run.part ? ` · ${run.part}` : ''}
              </span>
            )}
            {run.total !== undefined && (
              <span>
                已处理 {run.done ?? 0}/{run.total}
              </span>
            )}
            {run.success !== undefined && (
              <span>
                已确认 {run.success} · 待检查 {run.review ?? 0}
              </span>
            )}
            {(run.active !== undefined || run.queued !== undefined) && (
              <span>
                本次进行中 {run.active ?? 0} · 本次排队 {run.queued ?? 0}
              </span>
            )}
            {run.globalLimit !== undefined && (
              <span>
                扩展总并发 {run.globalActive ?? 0}/{run.globalLimit} · 总排队{' '}
                {run.globalQueued ?? 0}
              </span>
            )}
          </div>
          {run.phase === 'running' && run.waiting === 'vision-lane' && (
            <div className="model-wait">
              等待多模态并发名额 · 扩展总并发 {run.globalActive ?? 0}/
              {run.globalLimit ?? '—'} · 总排队 {run.globalQueued ?? 0}
            </div>
          )}
          {run.phase === 'running' &&
            run.waiting === 'platform' &&
            run.platformWaitUntil !== undefined &&
            platformRemaining > 0 && (
              <div className="model-wait">
                访问间隔剩余 {platformRemaining.toFixed(1)} 秒
              </div>
            )}
          {run.phase === 'running' &&
            run.waiting === 'model' &&
            run.requestStartedAt && (
              <div className="model-wait">
                等待模型响应 {elapsed(now - run.requestStartedAt)} · 本次超时{' '}
                {run.timeoutSec ?? 180} 秒 · 请求 {run.attempt ?? 1}/3
              </div>
            )}
          {run.phase === 'running' && (
            <div className="connection-note">
              {health === 'online'
                ? '后台在线'
                : health === 'delayed'
                  ? '后台心跳延迟，正在检查连接'
                  : '后台连接中断，正在停止本步骤'}
              {' · '}最近心跳{' '}
              {Math.max(0, Math.floor((now - run.lastHeartbeatAt) / 1000))} 秒前
              {' · '}最近实际进展{' '}
              {Math.max(0, Math.floor((now - run.lastProgressAt) / 1000))} 秒前
            </div>
          )}
          {run.phase === 'running' && (
            <div className="activity-line">
              <i />
            </div>
          )}
        </>
      )}
    </div>
  );
}
export function RunBanner({
  state,
  onOpen,
}: {
  state: AppState;
  onOpen(id?: string): void;
}) {
  const runs = Object.values(state.operations ?? {}).filter(
    (r) => r.kind !== 'legacy',
  );
  const run =
    runs
      .filter((r) => r.phase === 'running')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
    runs
      .filter((r) => r.phase === 'waiting-user')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!run) return null;
  return (
    <button
      className="run-banner"
      onClick={() => onOpen(run.taskId)}
      aria-label="查看当前执行步骤"
    >
      <span className="run-title">{run.title}</span>
      <LiveProgress run={run} compact />
      <span className="run-link">查看步骤与日志 →</span>
    </button>
  );
}
const GROUPS: { title: string; stages: WorkflowStage[] }[] = [
  { title: '读取题目', stages: ['checking', 'extracting'] },
  { title: '解密文字', stages: ['restoring'] },
  { title: '复核文字', stages: ['reviewing'] },
  { title: '生成答案', stages: ['solving'] },
  { title: '填写与回读', stages: ['filling', 'readback'] },
  { title: '保存或提交核验', stages: ['saving', 'submitting', 'verifying'] },
];
export function Workbench({
  state,
  taskId,
  busy,
  onAction,
  onComplete,
  onDetail,
  onConfigure,
  onCancel,
}: {
  state: AppState;
  taskId?: string;
  busy: boolean;
  onAction(id: string, action: TaskAction): void;
  onComplete(ids: string[], goal: 'submit' | 'draft'): void;
  onDetail(id: string): void;
  onConfigure(): void;
  onCancel(id: string, queue: boolean): void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [logs, setLogs] = useState(false);
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task)
    return (
      <section className="workbench empty compact">
        <p>打开具体测验或在作业列表选择“按步骤处理”。</p>
        <p>检测题目后，由你决定是否解密、作答、填写及提交。</p>
      </section>
    );
  const workflow = state.workflows?.[task.id];
  const boundRun = workflow ? state.operations?.[workflow.runId] : undefined;
  const run = boundRun?.taskId === task.id ? boundRun : undefined;
  const record = state.preparations[task.id];
  const item = state.queue.items.find((i) => i.taskId === task.id);
  const page = record?.snapshot ?? item?.snapshot;
  const proposals = record?.proposals ?? item?.proposals;
  const active = run?.phase === 'running';
  const blocked =
    busy ||
    active ||
    Boolean(state.platformBlock) ||
    state.queue.phase === 'running';
  const terminal =
    ['submitted', 'complete', 'expired'].includes(task.status) ||
    task.pageMode === 'preview';
  const complete = Boolean(
    page &&
    proposals &&
    page.questions.every((q) =>
      completeAnswer(
        q,
        proposals.find((a) => a.questionId === q.id),
      ),
    ),
  );
  const needModel = page?.questions.some(
    (q) => !q.issues.length && needsSolve(q, state.draftPolicy),
  );
  const good = page?.questions.filter(
    (q) => !q.issues.length && q.type !== 'unsupported',
  ).length;
  return (
    <section className="workbench">
      <div className="workbench-heading">
        <div>
          <span className="eyebrow">TASK WORKBENCH</span>
          <h2>{task.title}</h2>
        </div>
        <span className="status">
          {task.type === 'quiz' ? '章节测验' : '普通作业'}
        </span>
      </div>
      <p className="workflow-intro">
        {task.questionCount ?? page?.questions.length ?? '待读取'} 道题 ·{' '}
        {task.pageMode === 'preview'
          ? '当前为只读预览，没有答题控件'
          : terminal
            ? '任务已提交或已截止，不能作答'
            : workflow
              ? PHASE[workflow.phase]
              : '已检测到题目，是否开始解密？'}
      </p>
      {run && <LiveProgress run={run} />}
      <div className="workflow-controls">
        {active && (
          <button
            className="secondary"
            onClick={() => onCancel(task.id, run?.kind === 'queue')}
          >
            取消当前步骤
          </button>
        )}
        {!terminal && !workflow?.submitAttempted && (
          <button
            className="secondary"
            disabled={blocked}
            onClick={() => onAction(task.id, 'decode')}
          >
            {record?.decoded ? '重新解密' : '开始解密'}
          </button>
        )}
        {record?.decoded && !terminal && !workflow?.submitAttempted && (
          <button
            className={record.proposals?.length ? 'secondary' : 'primary'}
            disabled={blocked || Boolean(needModel && !state.provider.hasKey)}
            onClick={() => onAction(task.id, 'solve')}
          >
            {record.proposals?.length ? '重新生成答案' : '生成答案'}
          </button>
        )}
        {proposals && !terminal && (
          <button
            className="primary"
            disabled={
              blocked ||
              !record?.proposals?.length ||
              Boolean(workflow?.submitAttempted)
            }
            onClick={() => onAction(task.id, 'fill')}
          >
            填写答案
          </button>
        )}
        {workflow?.filled && !terminal && (
          <button
            className="secondary"
            disabled={blocked || Boolean(workflow.submitAttempted)}
            onClick={() => onAction(task.id, 'draft')}
          >
            {workflow.draftAttempted ? '核验上次草稿' : '保存草稿（不提交）'}
          </button>
        )}
        {(workflow?.filled || workflow?.submitAttempted) && !terminal && (
          <button
            className="primary"
            disabled={
              blocked ||
              (!workflow.submitAttempted &&
                (!complete || !workflow.readbackVerified))
            }
            onClick={() => onAction(task.id, 'submit')}
          >
            {workflow.submitAttempted ? '核验上次提交' : '提交答案'}
          </button>
        )}
        {!state.provider.hasKey && !terminal && (
          <button className="text-button" onClick={onConfigure}>
            配置答题模型服务
          </button>
        )}
      </div>
      <ol className="workflow-steps">
        {GROUPS.map((group, index) => {
          const current = Boolean(run && group.stages.includes(run.stage));
          const steps = group.stages
            .map((s) => workflow?.steps[s])
            .filter(Boolean);
          const interrupted = steps.some((s) => s?.status === 'interrupted');
          const review = steps.some((s) => s?.status === 'review');
          const done =
            steps.length > 0 &&
            steps.every((s) => ['done', 'waiting-user'].includes(s!.status));
          const label =
            current && run
              ? PHASE[run.phase]
              : interrupted
                ? '已中断'
                : review
                  ? '需检查'
                  : done
                    ? '已完成'
                    : '未开始';
          const open = current || expanded.has(index);
          return (
            <li
              className={`workflow-step ${current ? 'current' : ''} ${done ? 'done' : ''}`}
              key={group.title}
            >
              <button
                className="workflow-step-heading"
                onClick={() =>
                  setExpanded((old) => {
                    const next = new Set(old);
                    next.has(index) ? next.delete(index) : next.add(index);
                    return next;
                  })
                }
                aria-expanded={open}
              >
                <span className="workflow-number">
                  {done ? '✓' : index + 1}
                </span>
                <strong>{group.title}</strong>
                <span>{label}</span>
              </button>
              {open && (
                <div className="workflow-step-body">
                  {steps.length ? (
                    steps.map((s, i) => <p key={i}>{s?.note}</p>)
                  ) : (
                    <p>
                      {index === 0
                        ? '完整题目在点击开始解密后读取。'
                        : '前置步骤完成后，由你选择是否继续。'}
                    </p>
                  )}
                  {index === 2 && page && (
                    <p>
                      可作答 {good}/{page.questions.length} 题 · 待检查{' '}
                      {page.questions.length - (good ?? 0)} 题
                    </p>
                  )}
                  {index === 3 && proposals && (
                    <p>
                      候选 {proposals.length} 题 · 模型不确定{' '}
                      {proposals.filter((a) => a.needsReview).length} 题
                    </p>
                  )}
                  {index === 4 && workflow?.filled && (
                    <p>
                      答案已写入网页 ·{' '}
                      {workflow.readbackVerified ? '回读一致' : '回读需检查'}
                    </p>
                  )}
                  {index === 5 && workflow?.draftAttempted && (
                    <p>
                      {workflow.draftVerified
                        ? '草稿已核验保存，尚未提交'
                        : '保存已触发，服务端保存待确认'}
                    </p>
                  )}
                  {page && [2, 3].includes(index) && (
                    <button
                      className="text-button"
                      onClick={() => onDetail(task.id)}
                    >
                      查看题目、识别证据与候选答案 →
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!terminal && (
        <div className="workflow-shortcuts">
          <p>也可以连续执行以上步骤：</p>
          <button
            className="primary"
            disabled={
              blocked ||
              !state.provider.hasKey ||
              Boolean(workflow?.submitAttempted)
            }
            onClick={() => onComplete([task.id], 'submit')}
          >
            一键完成并提交
          </button>
          <button
            className="secondary"
            disabled={
              blocked ||
              !state.provider.hasKey ||
              Boolean(workflow?.submitAttempted)
            }
            onClick={() => onComplete([task.id], 'draft')}
          >
            一键完成并保存草稿
          </button>
          <small>草稿可包含不确定候选；存在待检查项时禁止提交。</small>
        </div>
      )}
      {workflow && (
        <div className="workflow-log">
          <button className="text-button" onClick={() => setLogs(!logs)}>
            {logs ? '收起' : '展开'}本次执行日志
          </button>
          {logs && (
            <LogViewer state={state} fixedRunId={workflow.runId} compact />
          )}
        </div>
      )}
    </section>
  );
}
