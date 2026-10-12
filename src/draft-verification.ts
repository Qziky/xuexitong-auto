import type { PageSnapshot } from './domain';
import { normalizeText } from './answers';

/** Verify real platform option keys; display order and encrypted font may change. */
export function serverDraftMatches(
  expected: PageSnapshot,
  server?: PageSnapshot,
): boolean {
  if (
    !server ||
    server.status !== 'pending' ||
    !expected.accountId ||
    server.accountId !== expected.accountId ||
    server.taskKey !== expected.taskKey ||
    server.adapter !== expected.adapter ||
    server.questions.length !== expected.questions.length
  )
    return false;
  return expected.questions.every((q) => {
    const other = server.questions.find((r) => r.id === q.id);
    if (!other || other.type !== q.type || other.issues.length) return false;
    if (q.type === 'blank')
      return (
        q.blanks.length === other.blanks.length &&
        q.blanks.every(
          (b, i) =>
            b.id === other.blanks[i]?.id &&
            normalizeText(b.value) === normalizeText(other.blanks[i]!.value),
        )
      );
    const keys = (page: typeof q) =>
      page.options
        .map((o) => o.key)
        .sort()
        .join('|');
    const selected = (page: typeof q) =>
      page.existing
        .map((id) => page.options.find((o) => o.id === id)?.key ?? '?')
        .sort()
        .join('|');
    return keys(q) === keys(other) && selected(q) === selected(other);
  });
}
