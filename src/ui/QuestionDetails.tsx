import { memo, useLayoutEffect, useRef, useState } from 'react';
import type {
  AnswerProposal,
  AppState,
  QuestionRecord,
  TaskAction,
  TaskPreparation,
} from '../domain';
import {
  answerText,
  comparison,
  QUESTION_TYPE_LABEL,
  type QuestionExportOptions,
} from '../question-export';
import { existingProposal } from '../answers';
import { requiresTextRecognition, answerImages } from '../image-content';
import { RecognitionDetails, RecognitionSource } from './RecognitionDetails';
import { MathText } from './MathText';
import { QuestionImages } from './QuestionImages';
export type QuestionFilter = 'all' | 'review' | 'different';
const scrollPositions = new Map<string, number>();
const savedViews = new Map<
  string,
  { filter: QuestionFilter; page: number; jump: string }
>();
export const QuestionCard = memo(function QuestionCard({
  question: q,
  reference,
  busy,
  onAction,
  onConfirm,
}: {
  question: QuestionRecord;
  reference?: AnswerProposal;
  busy: boolean;
  onAction(action: TaskAction, questionId?: string): void;
  onConfirm(
    questionId: string,
    text: { stem?: string; options?: Record<string, string> },
  ): void;
}) {
  const [editing, setEditing] = useState(false),
    [stem, setStem] = useState(q.stem),
    [options, setOptions] = useState(
      Object.fromEntries(q.options.map((o) => [o.id, o.text])),
    );
  const review = q.issues.length > 0 || reference?.needsReview;
  const different =
    reference?.source !== 'own' && comparison(q, reference) === 'different';
  const pendingText =
    (requiresTextRecognition(q) && !q.recognition?.stem.source) ||
    q.options.some(
      (o) =>
        requiresTextRecognition(q, o.id) &&
        !q.recognition?.options[o.id]?.source,
    );
  return (
    <article className="question-card" id={'question-' + q.number}>
      <div className="question-meta">
        <strong>第 {q.number} 题</strong>
        <span>{QUESTION_TYPE_LABEL[q.type]}</span>
        <RecognitionSource trace={q.recognition?.stem} />
      </div>
      <small>
        {pendingText
          ? '未确认文字预览'
          : answerImages(q).length
            ? '文字与原图材料已准备'
            : '已确认文字'}
      </small>
      <p className="question-stem">
        <MathText text={q.stem} />
      </p>
      <QuestionImages question={q} />
      <ul className="question-options">
        {q.options.map((o) => (
          <li key={o.id}>
            <span>{o.label}</span>
            <div className="question-option-content">
              <MathText text={o.text} />
              <QuestionImages question={q} optionId={o.id} />
            </div>
          </li>
        ))}
      </ul>
      {q.issues.map((issue) => (
        <p key={issue} className="warning">
          {issue}
        </p>
      ))}
      <dl className="answer-comparison">
        <dt>我的答案</dt>
        <dd>
          <MathText text={answerText(q, existingProposal(q))} />
        </dd>
        <dt>模型参考</dt>
        <dd>
          <MathText
            text={
              reference?.source === 'own'
                ? '尚未生成参考'
                : answerText(q, reference)
            }
          />
          {reference?.needsReview && <span className="tag warn">需检查</span>}
        </dd>
        {q.publishedAnswer && (
          <>
            <dt>平台公布</dt>
            <dd>
              <MathText text={answerText(q, q.publishedAnswer)} />
              <span
                className={
                  'tag ' +
                  (comparison(q, q.publishedAnswer) === 'same'
                    ? 'good'
                    : 'warn')
                }
              >
                {comparison(q, q.publishedAnswer) === 'same'
                  ? '与标准答案一致'
                  : '请核对标准答案'}
              </span>
            </dd>
          </>
        )}
      </dl>
      {different && <p className="compare-note">与模型参考不同，待核对</p>}
      {reference?.explanation && (
        <details>
          <summary>查看参考解析</summary>
          <p>
            <MathText text={reference.explanation} />
          </p>
        </details>
      )}
      <RecognitionDetails question={q} />
      <div className="question-actions">
        <button
          disabled={busy}
          onClick={() => onAction('decode-question', q.id)}
        >
          重新识别
        </button>
        <button
          disabled={busy || q.issues.length > 0}
          onClick={() => onAction('solve-question', q.id)}
        >
          重新作答
        </button>
        {pendingText && (
          <button
            disabled={busy}
            onClick={() => {
              setStem(q.stem);
              setOptions(
                Object.fromEntries(q.options.map((o) => [o.id, o.text])),
              );
              setEditing((v) => !v);
            }}
          >
            人工确认
          </button>
        )}
      </div>
      {editing && (
        <form
          className="manual-review"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(q.id, { stem, options });
            setEditing(false);
          }}
        >
          <label>
            完整题干
            <textarea
              value={stem}
              onChange={(event) => setStem(event.target.value)}
              rows={4}
            />
          </label>
          {q.options.map((o) => (
            <label key={o.id}>
              选项 {o.label}
              <textarea
                value={options[o.id]}
                onChange={(event) =>
                  setOptions({ ...options, [o.id]: event.target.value })
                }
                rows={2}
              />
            </label>
          ))}
          <small>
            确认文字后再重新作答。题型、选项映射和填空位置保持原样。
          </small>
          <button className="primary" disabled={busy}>
            确认文字
          </button>
        </form>
      )}
      {busy && <small>处理进度显示在顶部。</small>}
      {review && !q.issues.length && (
        <p className="warning">参考答案需人工核对。</p>
      )}
    </article>
  );
});
export function QuestionDetails({
  state,
  record,
  initialFilter = 'all',
  onBack,
  onAction,
  onConfirm,
  onExport,
}: {
  state: AppState;
  record: TaskPreparation;
  initialFilter?: QuestionFilter;
  onBack(): void;
  onAction(action: TaskAction, questionId?: string): void;
  onConfirm(
    questionId: string,
    text: { stem?: string; options?: Record<string, string> },
  ): void;
  onExport(options: QuestionExportOptions): void;
}) {
  const prior = savedViews.get(record.taskId);
  const [filter, setFilter] = useState<QuestionFilter>(
      initialFilter === 'all'
        ? (prior?.filter ?? initialFilter)
        : initialFilter,
    ),
    [page, setPage] = useState(
      initialFilter === 'all' ? (prior?.page ?? 0) : 0,
    ),
    [jump, setJump] = useState(prior?.jump ?? '1');
  const [exports, setExports] = useState<QuestionExportOptions>({});
  const container = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(scrollPositions.get(record.taskId) ?? 0);
  const questions = record.snapshot?.questions ?? [];
  const visible = questions.filter((q) =>
    filter === 'review'
      ? q.issues.length ||
        record.proposals?.find((p) => p.questionId === q.id)?.needsReview
      : filter === 'different'
        ? comparison(
            q,
            record.proposals?.find((p) => p.questionId === q.id),
          ) === 'different'
        : true,
  );
  const displayPage = Math.min(
    page,
    Math.max(0, Math.ceil(visible.length / 20) - 1),
  );
  const busy = Object.values(state.operations).some(
    (r) =>
      r.phase === 'running' &&
      (r.kind === 'queue' || r.kind === 'manual' || r.kind === 'test'),
  );
  const view = useRef({ filter, page, jump });
  view.current = { filter, page: displayPage, jump };
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    lastScroll.current = scrollPositions.get(record.taskId) ?? 0;
    element.scrollTop = lastScroll.current;
    return () => {
      scrollPositions.set(record.taskId, lastScroll.current);
      savedViews.set(record.taskId, view.current);
    };
  }, [record.taskId]);
  function goQuestion() {
    const number = Number(jump),
      index = visible.findIndex((q) => q.number === number);
    if (index < 0) return;
    setPage(Math.floor(index / 20));
    requestAnimationFrame(() =>
      document
        .getElementById('question-' + number)
        ?.scrollIntoView({ block: 'start' }),
    );
  }
  return (
    <div className="details-layout">
      <div className="details-back">
        <button className="back-button" onClick={onBack}>
          ← 返回当前步骤
        </button>
      </div>
      <div
        className="details-page"
        ref={container}
        onScroll={() => {
          if (container.current && container.current.clientHeight > 0) {
            lastScroll.current = container.current.scrollTop;
            scrollPositions.set(record.taskId, lastScroll.current);
          }
        }}
      >
        <div className="detail-heading">
          <h1>题目与答案</h1>
          <p>{record.snapshot?.title}</p>
        </div>
        <div className="detail-tools">
          <select
            aria-label="筛选题目"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as QuestionFilter);
              setPage(0);
            }}
          >
            <option value="all">全部题目（{questions.length}）</option>
            <option value="review">需检查</option>
            <option value="different">与参考不同</option>
          </select>
          <input
            aria-label="跳转题号"
            type="number"
            min={1}
            max={questions.length}
            value={jump}
            onChange={(e) => setJump(e.target.value)}
          />
          <button onClick={goQuestion}>跳转</button>
        </div>
        <details className="export-options">
          <summary>导出 TXT</summary>
          <p>默认导出题型、题干和选项。</p>
          <label>
            <input
              type="checkbox"
              checked={!!exports.own}
              onChange={(e) =>
                setExports({ ...exports, own: e.target.checked })
              }
            />
            加入我的答案
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!exports.reference}
              onChange={(e) =>
                setExports({ ...exports, reference: e.target.checked })
              }
            />
            加入参考答案
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!exports.explanation}
              onChange={(e) =>
                setExports({ ...exports, explanation: e.target.checked })
              }
            />
            加入解析
          </label>
          <button onClick={() => onExport(exports)}>下载 TXT</button>
        </details>
        {!visible.length && (
          <div className="empty-card">此筛选下没有题目。</div>
        )}
        {visible.slice(displayPage * 20, displayPage * 20 + 20).map((q) => (
          <QuestionCard
            key={q.id}
            question={q}
            reference={record.proposals?.find((p) => p.questionId === q.id)}
            busy={busy}
            onAction={onAction}
            onConfirm={onConfirm}
          />
        ))}
        {visible.length > 20 && (
          <div className="pagination">
            <button
              disabled={displayPage === 0}
              onClick={() => setPage(displayPage - 1)}
            >
              上一页
            </button>
            <span>
              {displayPage + 1}/{Math.ceil(visible.length / 20)}
            </span>
            <button
              disabled={(displayPage + 1) * 20 >= visible.length}
              onClick={() => setPage(displayPage + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
