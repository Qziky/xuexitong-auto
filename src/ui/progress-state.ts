import type { AppState, OperationProgress } from '../domain';

export function newerProgress(
  a: OperationProgress,
  b?: OperationProgress,
): boolean {
  return (
    !b ||
    a.seq > b.seq ||
    (a.seq === b.seq &&
      a.lastHeartbeatAt >= b.lastHeartbeatAt &&
      a.updatedAt >= b.updatedAt)
  );
}
export function reconcileState(
  current: AppState,
  incoming: AppState,
): AppState {
  if (current.accountId !== incoming.accountId) return incoming;
  const operations = { ...incoming.operations };
  for (const [id, run] of Object.entries(current.operations))
    if (operations[id] && newerProgress(run, operations[id]))
      operations[id] = run;
  return { ...incoming, operations };
}
