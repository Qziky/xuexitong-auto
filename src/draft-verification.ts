import type { PageSnapshot } from './domain';
import { isTextEntryType } from './domain';
import { normalizeText } from './answers';

/** 核验服务端的文本内容或真实选项键，不能仅凭本地填写判断已保存。 */
export function serverDraftMatches(
  expected: PageSnapshot,
  server?: PageSnapshot,
): boolean {
  if (
    !server ||
    expected.pageMode === 'preview' ||
    server.pageMode === 'preview' ||
    !expected.questions.length ||
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
    if (isTextEntryType(q.type))
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
