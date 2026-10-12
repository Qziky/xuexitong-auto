import type { ProviderConfig } from '../domain';
import { beginOperation, finishOperation } from './operations';
import { offscreen } from './transport';
import { state, persist } from './store';
const jobs = new Map<
  string,
  { kind: 'test' | 'test-vision'; controller: AbortController }
>();
export function cancelConnectionTests(id?: string): void {
  for (const [runId, job] of jobs)
    if (!id || id === runId) job.controller.abort();
}
export function startConnectionTest(
  kind: 'test' | 'test-vision',
  provider: ProviderConfig,
  visionConcurrency = 5,
): { operationId: string } {
  if (
    state.queue.phase === 'running' ||
    Object.values(state.operations).some(
      (r) => r.phase === 'running' && ['manual', 'queue'].includes(r.kind),
    )
  )
    throw new Error('请先结束当前任务步骤再测试连接');
  const previous = [...jobs].find(([, job]) => job.kind === kind);
  if (previous) return { operationId: previous[0] };
  const id = beginOperation(
    'test',
    kind === 'test' ? '答题模型连接测试' : '视觉模型连接测试',
  );
  const controller = new AbortController();
  jobs.set(id, { kind, controller });
  void Promise.resolve().then(async () => {
    try {
      const job =
        kind === 'test-vision'
          ? {
              op: 'test-vision' as const,
              provider: {
                ...provider,
                timeoutSec: Math.min(provider.timeoutSec, 45),
              },
              concurrency: visionConcurrency,
            }
          : {
              op: 'test' as const,
              provider: {
                ...provider,
                timeoutSec: Math.min(provider.timeoutSec, 45),
              },
            };
      const result = await offscreen<{ elapsedMs: number }>(
        job,
        controller.signal,
        id,
      );
      if (controller.signal.aborted) throw new Error('已取消');
      await finishOperation(
        id,
        'done',
        `连接测试成功，用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒`,
      );
    } catch (error) {
      const note = error instanceof Error ? error.message : '连接测试失败';
      await finishOperation(
        id,
        controller.signal.aborted
          ? 'cancelled'
          : /心跳/.test(note)
            ? 'paused'
            : 'error',
        note,
      );
    } finally {
      jobs.delete(id);
    }
  });
  void persist();
  return { operationId: id };
}
