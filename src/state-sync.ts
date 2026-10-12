import type { AppState, TaskPreparation } from './domain';

const MAP_KEYS = [
  'preparations',
  'workspaces',
  'operations',
  'workflows',
] as const;
export interface StateDelta {
  version: number;
  previous: number;
  fields: Partial<AppState>;
  clear: (keyof AppState)[];
  maps: Partial<
    Record<
      (typeof MAP_KEYS)[number],
      { put: Record<string, unknown>; remove: string[] }
    >
  >;
}
/** Snapshots are sent only on connection; subsequent messages contain changed records. */
export function diffState(
  before: AppState,
  after: AppState,
  version: number,
): StateDelta {
  const fields: Partial<AppState> = {};
  const clear: (keyof AppState)[] = [];
  const maps: StateDelta['maps'] = {};
  for (const key of Object.keys(after) as (keyof AppState)[]) {
    if (key === 'revision') continue;
    if ((MAP_KEYS as readonly string[]).includes(key)) {
      const old = (before[key] ?? {}) as Record<string, unknown>;
      const next = (after[key] ?? {}) as Record<string, unknown>;
      const put: Record<string, unknown> = {};
      for (const id of Object.keys(next))
        if (JSON.stringify(old[id]) !== JSON.stringify(next[id]))
          put[id] = structuredClone(next[id]);
      const remove = Object.keys(old).filter((id) => !(id in next));
      if (Object.keys(put).length || remove.length)
        maps[key as (typeof MAP_KEYS)[number]] = { put, remove };
    } else if (after[key] === undefined && before[key] !== undefined) {
      clear.push(key);
    } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      (fields as Record<string, unknown>)[key] = structuredClone(after[key]);
    }
  }
  // Chromium extension messages use JSON serialization; undefined cannot carry a clear.
  for (const key of Object.keys(before) as (keyof AppState)[])
    if (!(key in after)) clear.push(key);
  return { previous: before.revision ?? 0, version, fields, clear, maps };
}
export function applyStateDelta(
  state: AppState,
  delta: StateDelta,
): AppState | undefined {
  if ((state.revision ?? 0) !== delta.previous) return undefined;
  const next = { ...state, ...delta.fields, revision: delta.version };
  for (const key of delta.clear ?? [])
    delete (next as unknown as Record<string, unknown>)[key];
  for (const key of MAP_KEYS) {
    const patch = delta.maps[key];
    if (!patch) continue;
    const entries = { ...state[key], ...patch.put };
    if (key === 'preparations')
      for (const [id, value] of Object.entries(patch.put)) {
        const previous = state.preparations[id],
          incoming = value as TaskPreparation;
        if (!previous?.snapshot || !incoming.snapshot) continue;
        const oldQuestions = new Map(
          previous.snapshot.questions.map((q) => [q.id, q]),
        );
        const questions = incoming.snapshot.questions.map((q) => {
          const old = oldQuestions.get(q.id);
          return old && JSON.stringify(old) === JSON.stringify(q) ? old : q;
        });
        const oldProposals = new Map(
          previous.proposals?.map((p) => [p.questionId, p]),
        );
        const proposals = incoming.proposals?.map((p) => {
          const old = oldProposals.get(p.questionId);
          return old && JSON.stringify(old) === JSON.stringify(p) ? old : p;
        });
        entries[id] = {
          ...incoming,
          snapshot: { ...incoming.snapshot, questions },
          proposals,
        };
      }
    for (const id of patch.remove) delete entries[id];
    (next as unknown as Record<string, unknown>)[key] = entries;
  }
  return next;
}
