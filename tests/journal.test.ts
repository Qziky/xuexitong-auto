import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  appendEvent,
  clearLogs,
  configureJournal,
  exportLogs,
  initJournal,
  pruneJournal,
  putRun,
  queryLogs,
  queryRuns,
} from '../src/background/journal';
import type { LogEvent, OperationProgress } from '../src/domain';
const now = Date.now();
function run(
  id: string,
  phase: OperationProgress['phase'] = 'done',
  at = now,
): OperationProgress {
  return {
    id,
    title: id,
    kind: 'manual',
    phase,
    stage: 'restoring',
    startedAt: at,
    stageStartedAt: at,
    updatedAt: at,
    lastHeartbeatAt: at,
    lastProgressAt: at,
    note: '测试',
    seq: 0,
  };
}
function event(runId: string, seq: number): LogEvent {
  return {
    id: `${runId}:${String(seq).padStart(4, '0')}`,
    runId,
    seq,
    at: now + seq,
    stage: seq % 2 ? 'restoring' : 'solving',
    taskId: 'task',
    level: seq % 2 ? 'warn' : 'info',
    questionNumber: seq,
    code: 'test',
    message: '步骤已完成',
  };
}
describe('IndexedDB 完整运行日志', () => {
  it('分页、组合筛选、导出排序、脱敏及允许字段', async () => {
    const error = vi.fn();
    configureJournal(error, () => ['custom-secret']);
    await putRun({ ...run('filter'), accountId: 'private-user-id' });
    for (let n = 1; n <= 5; n++)
      await appendEvent({
        ...event('filter', n),
        message:
          n === 1
            ? 'custom-secret https://example.com/a?enc=signed-value&cookie=x'
            : '步骤已完成',
        ...(n === 1
          ? ({ image: 'private-image', response: 'private-response' } as any)
          : {}),
      });
    const first = await queryLogs({ runId: 'filter', limit: 2 });
    const second = await queryLogs({
      runId: 'filter',
      cursor: first.cursor,
      limit: 2,
    });
    expect(first.events.map((e) => e.seq)).toEqual([5, 4]);
    expect(second.events.map((e) => e.seq)).toEqual([3, 2]);
    expect(
      (
        await queryLogs({
          runId: 'filter',
          taskId: 'task',
          stage: 'restoring',
          level: 'warn',
          search: '3',
        })
      ).events.map((e) => e.seq),
    ).toEqual([3]);
    const dump = await exportLogs({ runId: 'filter' });
    expect(dump.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    const json = JSON.stringify(dump);
    for (const text of [
      'custom-secret',
      'signed-value',
      'private-image',
      'private-response',
      '?enc',
      'private-user-id',
    ])
      expect(json).not.toContain(text);
    expect(error).not.toHaveBeenCalled();
  });
  it('只淘汰完整旧运行：7 天、100 次上限，活动运行保留', async () => {
    await clearLogs();
    await putRun(run('active', 'running', now - 20 * 86400000));
    await appendEvent(event('active', 1));
    await putRun(run('waiting', 'waiting-user', now - 20 * 86400000));
    await appendEvent(event('waiting', 1));
    await putRun(run('old', 'done', now - 8 * 86400000));
    await appendEvent(event('old', 1));
    for (let n = 0; n < 101; n++) {
      await putRun(run('ended' + n, 'done', now + n));
      await appendEvent(event('ended' + n, 1));
    }
    await pruneJournal(now + 200);
    const runs = await queryRuns();
    expect(
      runs.filter((r) => !['running', 'waiting-user'].includes(r.phase)),
    ).toHaveLength(100);
    expect(runs.some((r) => r.id === 'active')).toBe(true);
    expect(runs.some((r) => r.id === 'waiting')).toBe(true);
    expect((await queryLogs({ runId: 'old' })).events).toHaveLength(0);
    expect((await queryLogs({ runId: 'ended0' })).events).toHaveLength(0);
    await clearLogs();
    expect((await queryLogs({ runId: 'active' })).events).toHaveLength(1);
    expect((await queryLogs({ runId: 'waiting' })).events).toHaveLength(1);
    await putRun(run('waiting', 'done'));
    await clearLogs();
  });
  it('后台重启中断活动运行，旧日志只导入一次，清理后不复活', async () => {
    const legacy = [{ at: now, level: 'info' as const, text: '旧日志' }];
    await initJournal(legacy);
    expect((await queryRuns()).find((r) => r.id === 'active')?.phase).toBe(
      'cancelled',
    );
    expect(
      (await queryRuns()).find((r) => r.id === 'active')?.seq,
    ).toBeGreaterThan(1);
    expect(
      (await queryLogs({ runId: 'active' })).events.some(
        (e) => e.seq === 1 && e.code === 'test',
      ),
    ).toBe(true);
    expect(
      (await queryLogs({ runId: 'active' })).events.some(
        (e) => e.code === 'interrupted',
      ),
    ).toBe(true);
    expect((await queryLogs({ runId: 'legacy-v2' })).events).toHaveLength(1);
    await clearLogs();
    await initJournal(legacy);
    expect(await queryRuns()).toHaveLength(0);
  });
  it('数据库不可用时提示存储失败，写入调用不会阻塞或抛出原始异常', async () => {
    vi.resetModules();
    const isolated = await import('../src/background/journal');
    const error = vi.fn();
    isolated.configureJournal(error, () => []);
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('private storage detail');
      },
    });
    await expect(isolated.putRun(run('failed'))).resolves.toBeUndefined();
    await isolated.flushJournal();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('当前进度仍可查看'),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      'private storage detail',
    );
    vi.unstubAllGlobals();
  });
});
