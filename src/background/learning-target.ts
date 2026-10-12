import type { LearningItem } from '../domain';
import type { FrameRef } from './transport';
function linked(item: LearningItem, frame: FrameRef, all: FrameRef[]): boolean {
  let child = frame;
  const visited = new Set<number>();
  while (!visited.has(child.frameId)) {
    visited.add(child.frameId);
    if (
      child.learningIdentity &&
      (item.jobId
        ? child.learningIdentity.jobId === item.jobId
        : !!item.objectId && child.learningIdentity.objectId === item.objectId)
    )
      return true;
    const parent = all.find((f) => f.frameId === child.parentFrameId);
    if (!parent) break;
    const matching = (parent.learningTargets ?? []).filter(
      (t) => t.src === child.url,
    );
    if (
      matching.length === 1 &&
      ((item.objectId && matching[0]?.objectId === item.objectId) ||
        (item.jobId && matching[0]?.jobId === item.jobId))
    )
      return true;
    child = parent;
  }
  return false;
}
export function learningTarget(
  item: LearningItem,
  all: FrameRef[],
): { ref: FrameRef; targetId?: string } | undefined {
  if (item.type === 'video' || item.type === 'audio') {
    const candidates = all.flatMap((ref) =>
      (ref.media ?? (ref.video ? [ref.video] : []))
        .filter((m) => (m.kind ?? 'video') === item.type)
        .map((m) => ({ ref, m })),
    );
    const exact = candidates.filter(
      ({ ref, m }) =>
        (m.objectId === item.objectId && !!item.objectId) ||
        linked(item, ref, all),
    );
    const selected = exact.length
      ? exact
      : candidates.length === 1 && !candidates[0]?.m.objectId
        ? candidates
        : [];
    return selected.length === 1
      ? { ref: selected[0]!.ref, targetId: selected[0]!.m.targetId }
      : undefined;
  }
  const readers = all.filter((f) => !!f.reader);
  const exact = readers.filter((f) => linked(item, f, all));
  const selected = exact.length
    ? exact
    : readers.length === 1 &&
        !readers[0]?.learningIdentity?.jobId &&
        !readers[0]?.learningIdentity?.objectId
      ? readers
      : [];
  return selected.length === 1 ? { ref: selected[0]! } : undefined;
}
