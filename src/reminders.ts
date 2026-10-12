import type { TaskRecord, CourseRecord } from './domain';
export interface Reminder {
  id: string;
  title: string;
  message: string;
  taskId?: string;
}
export function dueReminders(
  tasks: TaskRecord[],
  sent: Record<string, number>,
  now = Date.now(),
  courses: CourseRecord[] = [],
): Reminder[] {
  const result: Reminder[] = [];
  const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const accounts = [...new Set(courses.map((c) => c.accountId))];
  for (const account of accounts) {
    const remaining = courses
      .filter(
        (c) => c.accountId === account && c.state === 'active' && c.taskPoints,
      )
      .reduce(
        (total, course) =>
          total +
          Math.max(0, course.taskPoints!.total - course.taskPoints!.completed),
        0,
      );
    const id = `task-points:${account}:${day}`;
    if (remaining > 0 && !sent[id])
      result.push({
        id,
        title: '还有课程任务点待完成',
        message: `剩余 ${remaining} 个任务点，打开侧栏进入章节学习。`,
      });
  }
  for (const task of tasks) {
    if (
      task.type !== 'homework' ||
      task.listed === false ||
      !['pending', 'review'].includes(task.status) ||
      !task.deadline ||
      task.deadline <= now
    )
      continue;
    const hours = (task.deadline - now) / 3600000;
    const bucket = hours <= 24 ? 24 : hours <= 72 ? 72 : undefined;
    if (!bucket) continue;
    // Remaining-time labels have minute rounding; use the date to keep refreshes from duplicating alerts.
    const deadlineDay = new Date(task.deadline).toISOString().slice(0, 10);
    const id = `deadline:${task.id}:${deadlineDay}:${bucket}`;
    if (!sent[id])
      result.push({
        id,
        title: `任务将在 ${bucket} 小时内截止`,
        message: task.title,
        taskId: task.id,
      });
  }
  return result;
}
