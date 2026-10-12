import { useEffect, useRef, useState } from 'react';
import type { AppState, TaskRecord, LearningTaskType } from '../domain';
import {
  LEARNING_TYPES,
  LEARNING_LABELS as learningTypeLabel,
} from '../learning-policy';
import { useClock } from './Clock';
function updated(at?: number) {
  return at
    ? new Date(at).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '尚未更新';
}
function deadline(task: TaskRecord, now: number) {
  if (!task.deadline) return '未提供截止时间';
  const minutes = Math.max(0, Math.ceil((task.deadline - now) / 60000));
  const left =
    minutes === 0
      ? '已截止'
      : minutes >= 1440
        ? Math.floor(minutes / 1440) +
          ' 天 ' +
          Math.floor((minutes % 1440) / 60) +
          ' 小时'
        : minutes >= 60
          ? Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分钟'
          : minutes + ' 分钟';
  return (
    (task.deadlineEstimated ? '预计 ' : '') +
    new Date(task.deadline).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }) +
    ' 截止 · ' +
    left
  );
}
const statusLabel = {
  pending: '待完成',
  submitted: '已提交',
  complete: '已完成',
  expired: '已截止',
  review: '需检查',
  unknown: '状态待确认',
};
export function Todos({
  state,
  courseId,
  onAction,
  onCurrent,
  onQueue,
}: {
  state: AppState;
  courseId?: string;
  onAction(kind: string, extra?: Record<string, unknown>): void;
  onCurrent(id: string): void;
  onQueue(): void;
}) {
  const now = useClock(),
    [category, setCategory] = useState<'homework' | 'points'>('homework'),
    [course, setCourse] = useState(courseId ?? '');
  const [selected, setSelected] = useState<string[]>([]),
    [showHistory, setShowHistory] = useState(false),
    [learning, setLearning] = useState(false);
  const [courses, setCourses] = useState<string[]>(courseId ? [courseId] : []),
    [types, setTypes] = useState<LearningTaskType[]>([...LEARNING_TYPES]),
    [goal, setGoal] = useState<'submit' | 'draft'>('submit');
  const learningForm = useRef<HTMLElement>(null);
  useEffect(() => {
    if (learning)
      learningForm.current?.scrollIntoView({
        block: 'start',
        behavior: 'instant',
      });
  }, [learning]);
  useEffect(() => {
    setCourse(courseId ?? '');
  }, [courseId]);
  const activeCourses = state.courses.filter(
    (c) => c.accountId === state.accountId && c.state === 'active',
  );
  const visibleCourses = activeCourses.filter(
    (c) => !course || c.id === course,
  );
  const busy =
    state.scan.phase === 'running' ||
    state.queue.phase === 'running' ||
    state.learning.phase === 'running';
  const tasks = state.tasks.filter(
    (t) =>
      t.accountId === state.accountId &&
      t.type === 'homework' &&
      !t.analysisOnly &&
      t.listed !== false,
  );
  const eligible = tasks.filter(
    (t) =>
      ['pending', 'review'].includes(t.status) &&
      (!t.deadline || t.deadline > now),
  );
  const selection = selected.filter((id) => eligible.some((t) => t.id === id));
  return (
    <section className="todos">
      <div className="section-heading">
        <h1>
          {course
            ? state.courses.find((c) => c.id === course)?.title
            : '学习待办'}
        </h1>
        <button
          className="quiet"
          disabled={busy}
          onClick={() => onAction('refresh-overview')}
        >
          {state.scan.phase === 'running' ? '正在刷新…' : '刷新进度和作业'}
        </button>
      </div>
      <div className="category-tabs">
        <button
          className={category === 'homework' ? 'active' : ''}
          onClick={() => setCategory('homework')}
        >
          作业
        </button>
        <button
          className={category === 'points' ? 'active' : ''}
          onClick={() => setCategory('points')}
        >
          任务点
        </button>
        <select
          aria-label="筛选课程"
          value={course}
          onChange={(e) => {
            setCourse(e.target.value);
            setSelected([]);
          }}
        >
          <option value="">全部课程</option>
          {activeCourses.map((c) => (
            <option value={c.id} key={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>
      <div className="list-caption">
        <small>进度更新：{updated(state.progressRefreshedAt)}</small>
        <button className="quiet" onClick={onQueue}>
          队列与记录
        </button>
      </div>
      {!activeCourses.length && (
        <div className="empty-card">
          <p>
            {state.accountId
              ? '尚未读取课程，请刷新列表。'
              : '请先登录学习通。'}
          </p>
          <button onClick={() => onAction('open-login')}>打开学习通</button>
        </div>
      )}
      {visibleCourses.map((c) => {
        const cache = state.homeworkCache[c.accountId + ':' + c.id];
        const works = tasks.filter(
          (t) =>
            t.courseId === c.id &&
            (showHistory || !['submitted', 'expired'].includes(t.status)),
        );
        const remaining = c.taskPoints
          ? Math.max(0, c.taskPoints.total - c.taskPoints.completed)
          : undefined;
        return (
          <section className="course-card" key={c.id}>
            <div className="course-heading">
              <h2>{c.title}</h2>
              <button
                className="quiet"
                onClick={() =>
                  onAction(
                    category === 'homework'
                      ? 'open-homework-list'
                      : 'open-course',
                    { id: c.id },
                  )
                }
              >
                {category === 'homework' ? '进入作业' : '进入章节'} ↗
              </button>
            </div>
            {category === 'points' ? (
              <>
                <div className="points-total">
                  <strong>
                    {remaining === undefined ? '待获取' : remaining}
                  </strong>
                  <span>
                    {remaining === undefined
                      ? '任务点进度尚未获取'
                      : '个任务点待完成'}
                  </span>
                </div>
                {c.taskPoints && (
                  <>
                    <progress
                      max={Math.max(1, c.taskPoints.total)}
                      value={c.taskPoints.completed}
                    />
                    <small>
                      已完成 {c.taskPoints.completed} / 共 {c.taskPoints.total}
                    </small>
                  </>
                )}
                <button
                  className="secondary"
                  disabled={state.learning.phase === 'running'}
                  onClick={() => {
                    setCourses([c.id]);
                    setLearning(true);
                  }}
                >
                  开始学习
                </button>
              </>
            ) : (
              <>
                <div className="list-caption">
                  <small>
                    作业更新：{updated(cache?.at)}
                    {cache?.at && now - cache.at > 5 * 60000
                      ? ' · 缓存待刷新'
                      : ''}
                  </small>
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() =>
                      onAction('refresh-homework-list', { courseId: c.id })
                    }
                  >
                    刷新作业
                  </button>
                </div>
                {(!cache?.complete || cache.note) && (
                  <p className="warning">
                    {cache?.note ??
                      '作业列表尚未完整获取，请刷新或打开课程作业页。'}
                  </p>
                )}
                {!works.length && (
                  <p className="empty-inline">
                    {cache?.complete
                      ? '此分类下没有待办作业。'
                      : '已有信息保留，暂无可靠的完整列表。'}
                  </p>
                )}
                {works.map((t) => (
                  <article className="todo-row" key={t.id}>
                    <label className="task-title">
                      <input
                        aria-label={'选择 ' + t.title}
                        type="checkbox"
                        disabled={!eligible.some((x) => x.id === t.id)}
                        checked={selection.includes(t.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, t.id]
                              : selected.filter((x) => x !== t.id),
                          )
                        }
                      />
                      <strong>{t.title}</strong>
                    </label>
                    <div className="task-info">
                      <span
                        className={
                          'tag ' +
                          (t.status === 'submitted'
                            ? 'good'
                            : t.status === 'review'
                              ? 'warn'
                              : '')
                        }
                      >
                        {statusLabel[t.status]}
                      </span>
                      {t.grade && <span>成绩 {t.grade}</span>}
                    </div>
                    <small className="deadline">{deadline(t, now)}</small>
                    {t.note && <p className="subtle">{t.note}</p>}
                    <div className="row-actions">
                      <button
                        onClick={() => {
                          onAction('open-task', { id: t.id });
                          onCurrent(t.id);
                        }}
                      >
                        打开作业
                      </button>
                      {eligible.some((x) => x.id === t.id) && (
                        <details className="task-menu">
                          <summary>一键处理</summary>
                          <button
                            disabled={busy}
                            onClick={() =>
                              onAction('complete-tasks', {
                                ids: [t.id],
                                policy: state.draftPolicy,
                                goal: 'draft',
                              })
                            }
                          >
                            完成并保存草稿
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              onAction('complete-tasks', {
                                ids: [t.id],
                                policy: state.draftPolicy,
                                goal: 'submit',
                              })
                            }
                          >
                            完成并提交
                          </button>
                        </details>
                      )}
                    </div>
                  </article>
                ))}
              </>
            )}
          </section>
        );
      })}
      {category === 'homework' && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(e) => setShowHistory(e.target.checked)}
          />
          显示已提交和已截止作业
        </label>
      )}
      {category === 'points' && visibleCourses.length > 1 && (
        <button
          className="secondary"
          disabled={state.learning.phase === 'running'}
          onClick={() => {
            setCourses(visibleCourses.map((c) => c.id));
            setLearning(true);
          }}
        >
          选择多门课程学习
        </button>
      )}
      {selection.length > 0 && (
        <section className="batch-bar">
          <strong>已选 {selection.length} 份作业</strong>
          <div className="final-actions">
            <button
              disabled={busy}
              onClick={() =>
                onAction('complete-tasks', {
                  ids: selection,
                  policy: state.draftPolicy,
                  goal: 'draft',
                })
              }
            >
              完成并保存草稿
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                onAction('complete-tasks', {
                  ids: selection,
                  policy: state.draftPolicy,
                  goal: 'submit',
                })
              }
            >
              完成并提交
            </button>
          </div>
        </section>
      )}
      {learning && (
        <section className="learning-form" ref={learningForm}>
          <div className="section-heading">
            <h2>开始前台学习</h2>
            <button className="quiet" onClick={() => setLearning(false)}>
              关闭
            </button>
          </div>
          <p>
            按卡片连续处理所选任务。学习期间保持当前任务页在前台；切到其他标签页或窗口时会自动切回。音视频保持静音，并按学习设置优先使用平台支持的
            2 倍速；完成以平台确认为准。
          </p>
          <fieldset>
            <legend>选择课程</legend>
            {activeCourses.map((c) => (
              <label className="checkbox-row" key={c.id}>
                <input
                  type="checkbox"
                  checked={courses.includes(c.id)}
                  onChange={(e) =>
                    setCourses(
                      e.target.checked
                        ? [...courses, c.id]
                        : courses.filter((id) => id !== c.id),
                    )
                  }
                />
                {c.title}
              </label>
            ))}
          </fieldset>
          <fieldset className="learning-types">
            <legend>处理类型</legend>
            {LEARNING_TYPES.map((type) => (
              <label className="checkbox-row" key={type}>
                <input
                  type="checkbox"
                  checked={types.includes(type)}
                  onChange={(e) =>
                    setTypes(
                      e.target.checked
                        ? [...types, type]
                        : types.filter((t) => t !== type),
                    )
                  }
                />
                {learningTypeLabel[type]}
              </label>
            ))}
          </fieldset>
          {types.includes('quiz') && (
            <>
              <label>
                章节题完成目标
                <select
                  value={goal}
                  onChange={(e) => setGoal(e.target.value as typeof goal)}
                >
                  <option value="submit">完成并提交</option>
                  <option value="draft">完成并保存草稿</option>
                </select>
              </label>
              {goal === 'submit' && (
                <small className="subtle">
                  会自动提交结构完整的最高可信候选，包括模型标记低置信的答案；题目文字未确认或没有有效候选时会停止该题。
                </small>
              )}
            </>
          )}
          <button
            className="primary"
            disabled={!courses.length || !types.length || busy}
            onClick={() => {
              onAction('start-learning', {
                courseIds: courses,
                range: types.includes('quiz')
                  ? types.includes('video')
                    ? 'both'
                    : 'quiz'
                  : 'video',
                selectedTypes: types,
                goal,
                policy: state.draftPolicy,
              });
              setLearning(false);
              onQueue();
            }}
          >
            开始前台学习
          </button>
        </section>
      )}
    </section>
  );
}
