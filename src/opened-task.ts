import type { CourseRecord, TaskRecord } from './domain';
import type { FrameInfo } from './messages';
import { isChaoxingUrl } from './security';
import { taskIdentifiers } from './task-context';

/** Register a user-opened task from its frame description, never from a guessed URL. */
export function openedTaskFromFrame(
  ref: FrameInfo,
  accountId: string,
  courses: CourseRecord[],
  tasks: TaskRecord[],
  now = Date.now(),
): TaskRecord | undefined {
  if (
    !isChaoxingUrl(ref.url) ||
    ref.accountId !== accountId ||
    ref.loginRequired ||
    ref.verificationRequired ||
    !ref.adapter ||
    !['quiz', 'homework'].includes(ref.taskKind ?? '') ||
    (ref.taskSummary &&
      (!Number.isInteger(ref.taskSummary.questionCount) ||
        ref.taskSummary.questionCount <= 0))
  )
    return undefined;
  const match = ref.taskKey?.match(/^(\d+):(\d+):work:(\d+)$/);
  if (!match) return undefined;
  const identifiers = taskIdentifiers(ref.url);
  if (
    (identifiers.course && identifiers.course !== match[1]) ||
    (identifiers.clazz && identifiers.clazz !== match[2]) ||
    (identifiers.work && identifiers.work !== match[3])
  )
    return undefined;
  const course = courses.find(
    (item) =>
      item.accountId === accountId &&
      item.courseId === match[1] &&
      item.classId === match[2] &&
      item.state === 'active',
  );
  if (!course) return undefined;
  const type = ref.taskKind as 'quiz' | 'homework';
  const id = `${accountId}:${course.id}:${type}:${match[3]}`;
  const old = tasks.find((task) => task.id === id);
  return {
    ...old,
    id,
    accountId,
    courseId: course.id,
    title:
      ref.taskSummary?.title ||
      old?.title ||
      (type === 'quiz' ? '当前章节测验' : '当前普通作业'),
    type,
    status:
      ref.taskSummary?.pageMode === 'preview'
        ? (old?.status ?? 'unknown')
        : (ref.taskSummary?.status ?? old?.status ?? 'unknown'),
    url: ref.url,
    platformId: match[3]!,
    questionCount: ref.taskSummary?.questionCount ?? old?.questionCount,
    grade: ref.taskSummary?.grade ?? old?.grade,
    deadline: ref.taskSummary?.deadline ?? old?.deadline,
    discovery: 'opened',
    listed: true,
    pageMode: ref.taskSummary?.pageMode ?? 'answer',
    note:
      ref.taskSummary?.pageMode === 'preview'
        ? '此页面仅供预览，没有答题控件；已截止的任务不能作答'
        : old?.pageMode === 'preview'
          ? undefined
          : old?.note,
    source: {
      url: ref.url,
      at: now,
      label: type === 'quiz' ? '已打开的章节测验' : '已打开的普通作业',
    },
  };
}
