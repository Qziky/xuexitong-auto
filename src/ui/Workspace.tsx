import type {
  AppState,
  PageCapabilities,
  TaskAction,
  TaskPreparation,
  TaskRecord,
} from '../domain';
import { taskCapabilities } from '../page-workspace';
export function workspaceStep(state: AppState, taskId: string): number {
  const workflow = state.workflows[taskId],
    record = state.preparations[taskId];
  if (workflow?.phase === 'running') {
    if (
      ['checking', 'extracting', 'restoring', 'reviewing'].includes(
        workflow.stage,
      )
    )
      return 0;
    if (workflow.stage === 'solving') return 1;
    if (['filling', 'readback'].includes(workflow.stage)) return 2;
    return 3;
  }
  if (!record?.decoded) return 0;
  if (!record.proposals?.some((p) => p.source !== 'own')) return 1;
  if (!workflow?.filled || !workflow.readbackVerified) return 2;
  return 3;
}
export function Workspace({
  state,
  task,
  onAction,
  onDetails,
  onExport,
  onSettings,
  onComplete,
}: {
  state: AppState;
  task?: TaskRecord;
  onAction(action: TaskAction): void;
  onDetails(filter?: 'all' | 'review' | 'different'): void;
  onExport(): void;
  onSettings(): void;
  onComplete(goal: 'submit' | 'draft'): void;
}) {
  if (!task)
    return (
      <div className="empty-card">
        <h1>当前页</h1>
        <p>在学习通打开一份作业或章节题，即可识别文字、查看参考和导出。</p>
        <small>打开页面只检测题目，不会调用模型。</small>
      </div>
    );
  const record: TaskPreparation | undefined = state.preparations[task.id],
    workflow = state.workflows[task.id];
  const bound =
    Object.values(state.workspaces).find(
      (w) => w.task.id === task.id && w.id === state.currentPage?.workspaceId,
    ) ?? Object.values(state.workspaces).find((w) => w.task.id === task.id);
  const capability: PageCapabilities =
    bound?.capabilities ?? taskCapabilities(task);
  const step = workspaceStep(state, task.id),
    readonly = !capability.fill;
  const busy = Object.values(state.operations).some(
    (r) =>
      r.phase === 'running' &&
      (r.kind === 'manual' || r.kind === 'queue' || r.kind === 'test'),
  );
  const currentRun = Object.values(state.operations).find(
    (r) => r.phase === 'running' && r.taskId === task.id,
  );
  const questions = record?.snapshot?.questions ?? [],
    count = questions.length || task.questionCount || 0;
  const textReview = questions.filter((q) => q.issues.length).length;
  const answerReview = (record?.proposals ?? []).filter(
    (p) => p.needsReview,
  ).length;
  const labels = readonly
    ? ['识别文字', '生成参考']
    : ['识别文字', '生成参考', '填写答案', '保存或提交'];
  const current = Math.min(step, labels.length - 1);
  const referenceDone =
    readonly && (record?.proposals ?? []).some((p) => p.source !== 'own');
  const finished = workflow?.phase === 'done' && workflow.submitAttempted;
  const notices = [
    '检测到 ' + count + ' 道题，点击后读取并识别文字。',
    textReview
      ? textReview + ' 道题文字需检查；可先复核，或只为已确认的题目生成参考。'
      : '文字已确认。生成参考只提供答案，不修改网页。',
    answerReview
      ? answerReview + ' 道参考需检查。提交前需要核对，草稿可保留候选。'
      : '参考已生成。填写前会重新核对页面和已有答案。',
    finished
      ? '平台已确认提交。'
      : workflow?.draftVerified
        ? '草稿已核验保存，尚未提交。可继续提交答案。'
        : '答案已填写并回读核对，请选择保存草稿或提交。',
  ];
  return (
    <section className="workspace">
      <div className="page-heading">
        <span className="tag">
          {readonly ? '题目参考' : task.type === 'quiz' ? '章节题' : '普通作业'}
        </span>
        <h1>{task.title}</h1>
        <p>
          {count ? count + ' 道题' : '题目加载中'}
          {task.grade ? ' · 平台成绩 ' + task.grade : ''}
        </p>
      </div>
      {readonly && <p className="soft-note">此页仅供参考，支持核对和导出。</p>}
      <ol className="step-indicator" aria-label="处理步骤">
        {labels.map((label, index) => (
          <li
            key={label}
            className={
              index === current ? 'current' : index < current ? 'complete' : ''
            }
          >
            <span>{index < current ? '✓' : index + 1}</span>
            <small>{label}</small>
          </li>
        ))}
      </ol>
      <section className="focus-step" aria-live="polite">
        <div className="step-caption">
          {busy
            ? currentRun
              ? '正在处理'
              : '等待其他操作结束'
            : referenceDone || finished
              ? '已完成'
              : '当前步骤'}
        </div>
        <h2>{referenceDone ? '参考已生成' : labels[current]}</h2>
        <p>
          {currentRun
            ? [
                '正在识别文字，完成后可查看结果。',
                '参考将随批次返回，可随时查看已有结果。',
                '正在填写并核对网页答案。',
                '正在核验平台保存或提交结果。',
              ][current]
            : referenceDone
              ? '可查看我的答案、模型参考和平台公布答案，也可以导出 TXT。'
              : notices[current]}
        </p>
        {(record?.phase === 'error' ||
          record?.phase === 'cancelled' ||
          workflow?.phase === 'error' || (workflow?.phase === 'review' && !record?.snapshot)) && (
          <p className="warning">{workflow?.note ?? record?.note}</p>
        )}
        {step === 0 && (
          <button
            className="primary main-action"
            disabled={busy || !count}
            onClick={() => onAction('decode')}
          >
            {record?.decoded ? '重新识别文字' : '识别文字'}
          </button>
        )}
        {step === 1 &&
          !referenceDone &&
          (textReview ? (
            <>
              <button
                className="primary main-action"
                disabled={busy}
                onClick={() => onDetails('review')}
              >
                复核 {textReview} 道题
              </button>
              <button
                className="quiet"
                disabled={busy || !state.provider.hasKey}
                onClick={() => onAction('solve')}
              >
                生成已确认题目的参考
              </button>
            </>
          ) : (
            <button
              className="primary main-action"
              disabled={busy}
              onClick={() =>
                state.provider.hasKey ? onAction('solve') : onSettings()
              }
            >
              {state.provider.hasKey ? '生成参考答案' : '配置答题模型'}
            </button>
          ))}
        {step === 2 && !readonly && (
          <button
            className="primary main-action"
            disabled={busy || !capability.fill}
            onClick={() => onAction('fill')}
          >
            填写答案
          </button>
        )}
        {step === 3 && !readonly && !finished && !workflow?.submitAttempted && (
          <div className="final-actions">
            <button
              className="primary"
              disabled={busy || !capability.save || !!workflow?.draftVerified}
              onClick={() => onAction('draft')}
            >
              {workflow?.draftVerified ? '草稿已保存' : '保存草稿'}
            </button>
            <button
              className={workflow?.draftVerified ? 'primary' : undefined}
              disabled={
                busy || !capability.submit || textReview > 0 || answerReview > 0
              }
              onClick={() => onAction('submit')}
            >
              提交答案
            </button>
          </div>
        )}
        {(referenceDone || finished) && (
          <button className="primary main-action" onClick={() => onDetails()}>
            查看题目与答案
          </button>
        )}
        {workflow?.draftAttempted && !workflow.draftVerified && !finished && (
          <>
            <p className="warning">
              保存已触发，服务端结果待确认。{workflow.note}
            </p>
            {!record?.snapshot && !workflow.submitAttempted && (
              <button className="primary" disabled={busy || !capability.save} onClick={() => onAction('draft')}>
                核验上次草稿
              </button>
            )}
          </>
        )}
        {workflow?.submitAttempted && !finished && (
          <>
            <p className="warning">
              提交结果待确认；只核验上次结果，不重复提交。
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => onAction('submit')}
            >
              核验上次提交
            </button>
          </>
        )}
      </section>
      <div className="workspace-tools">
        {record?.decoded && !finished && !workflow?.submitAttempted && (
          <button disabled={busy} onClick={() => onAction('decode')}>
            重新识别文字
          </button>
        )}
        {!(referenceDone || finished) && (
          <button disabled={!record?.decoded} onClick={() => onDetails()}>
            查看题目与答案{textReview + answerReview > 0 ? ' · 需检查' : ''}
          </button>
        )}
        <button disabled={!record?.decoded} onClick={onExport}>
          导出 TXT
        </button>
      </div>
      {!readonly && (
        <details className="one-click">
          <summary>一键处理</summary>
          <p>按顺序识别、生成参考、填写并核验结果。</p>
          <div className="stack-actions">
            <button disabled={busy} onClick={() => onComplete('draft')}>
              一键完成并保存草稿
            </button>
            <button disabled={busy} onClick={() => onComplete('submit')}>
              一键完成并提交
            </button>
          </div>
        </details>
      )}
      <details className="history-steps">
        <summary>已完成的步骤</summary>
        {Object.entries(workflow?.steps ?? {})
          .filter(
            ([, s]) => s?.status === 'done' || s?.status === 'waiting-user',
          )
          .map(([key, s]) => (
            <p key={key}>{s?.note}</p>
          ))}
        {!workflow && <small>尚未开始处理。</small>}
      </details>
    </section>
  );
}
