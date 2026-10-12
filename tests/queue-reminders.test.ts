import { describe, expect, it } from 'vitest';
import {
  accountGuard,
  canSubmit,
  createQueue,
  recoverQueue,
} from '../src/queue';
import { dueReminders } from '../src/reminders';
import {
  initialState,
  type TaskRecord,
  type CourseRecord,
} from '../src/domain';
const task: TaskRecord = {
  id: 't1',
  accountId: 'cx:1',
  courseId: 'c1',
  title: '作业',
  type: 'homework',
  status: 'pending',
  url: 'https://mooc1.chaoxing.com/',
  platformId: '1',
  source: { url: '', at: 0, label: '测试' },
};
describe('执行恢复与账号绑定', () => {
  it('过滤视频和已提交任务，单任务串行，默认策略被记录', () => {
    const q = createQueue(
      [
        task,
        { ...task, id: 'v', type: 'video' },
        { ...task, id: 's', status: 'submitted' },
      ],
      'cx:1',
      'preserve',
    );
    expect(q.items).toHaveLength(1);
    expect(q.index).toBe(0);
    expect(q.policy).toBe('preserve');
  });
  it('浏览器中断后暂停，提交标记保持为核验阶段，不能重复提交', () => {
    const q = createQueue([task], 'cx:1', 'preserve');
    q.items[0]!.stage = 'submitting';
    q.items[0]!.submitAttempted = true;
    const r = recoverQueue(q);
    expect(r.phase).toBe('paused');
    expect(r.items[0]!.stage).toBe('verifying');
    expect(canSubmit(r.items[0]!)).toBe(false);
  });
  it('未提交的中断任务重新读取草稿，不沿用旧快照', () => {
    const q = createQueue([task], 'cx:1', 'overwrite');
    q.items[0]!.stage = 'filling';
    expect(recoverQueue(q).items[0]!.stage).toBe('waiting');
  });
  it('换号或未识别账号阻断执行', () => {
    const s = initialState();
    s.accountId = 'cx:1';
    s.queue.accountId = 'cx:1';
    expect(() => accountGuard(s, 'cx:2')).toThrow('变化');
    expect(() => accountGuard(s, undefined)).toThrow('无法确认');
    expect(() => accountGuard(s, 'cx:1')).not.toThrow();
  });
});
describe('提醒去重', () => {
  const now = new Date('2026-10-07T08:00:00+08:00').getTime();
  it('每日一次剩余任务点汇总，不推断视频数量；未知进度不计入', () => {
    const course = {
      id: 'c1',
      accountId: 'cx:1',
      title: '课程',
      state: 'active',
      taskPoints: { completed: 1, total: 65 },
    } as CourseRecord;
    const courses = [
      course,
      { ...course, id: 'unknown', taskPoints: undefined },
    ];
    const r = dueReminders([], {}, now, courses);
    expect(r).toHaveLength(1);
    expect(r[0]!.message).toContain('64 个任务点');
    expect(r[0]!.message).not.toContain('视频');
    expect(
      dueReminders([], { [r[0]!.id]: now }, now + 3600000, courses),
    ).toHaveLength(0);
  });
  it('72h 和 24h 各提醒一次，跳过已提交与已截止任务', () => {
    const t = { ...task, deadline: now + 60 * 3600000 };
    const first = dueReminders([t], {}, now)[0]!;
    expect(first.id.endsWith(':72')).toBe(true);
    const later = dueReminders(
      [t],
      { [first.id]: now },
      now + 40 * 3600000,
    )[0]!;
    expect(later.id.endsWith(':24')).toBe(true);
    expect(
      dueReminders(
        [t],
        { [first.id]: now, [later.id]: now },
        now + 41 * 3600000,
      ),
    ).toEqual([]);
    expect(
      dueReminders(
        [
          { ...t, status: 'submitted' },
          { ...t, deadline: now - 1 },
        ],
        {},
        now,
      ),
    ).toEqual([]);
  });
  it('剩余分钟重新扫描的小幅时间漂移不会重复通知', () => {
    const t = { ...task, deadline: now + 20 * 3600000 };
    const first = dueReminders([t], {}, now)[0]!;
    expect(
      dueReminders(
        [{ ...t, deadline: t.deadline + 30000 }],
        { [first.id]: now },
        now + 60000,
      ),
    ).toEqual([]);
  });
});
