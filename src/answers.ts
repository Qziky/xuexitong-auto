import type { AnswerProposal, DraftPolicy, QuestionRecord } from './domain';

export function needsSolve(q: QuestionRecord, policy: DraftPolicy): boolean {
  if (q.type === 'unsupported' || q.issues.length) return false;
  if (policy === 'overwrite') return true;
  if (q.type === 'blank') return q.blanks.some((b) => !b.value.trim());
  return q.existing.length === 0;
}
export function normalizeProposal(
  q: QuestionRecord,
  raw: unknown,
  policy: DraftPolicy,
): AnswerProposal {
  if (!raw || typeof raw !== 'object')
    throw new Error(`第 ${q.number} 题答案格式无效`);
  const a = raw as Record<string, unknown>;
  if (
    a.questionId !== q.id ||
    typeof a.needsReview !== 'boolean' ||
    typeof a.explanation !== 'string'
  )
    throw new Error(`第 ${q.number} 题缺少 ID、检查标记或解析`);
  const result: AnswerProposal = {
    questionId: q.id,
    needsReview: a.needsReview,
    explanation: a.explanation.slice(0, 3000),
    source: 'model',
  };
  if (q.type === 'blank') {
    if (
      !Array.isArray(a.blanks) ||
      a.blanks.length !== q.blanks.length ||
      a.blanks.some((v) => typeof v !== 'string' || v.length > 2000)
    )
      throw new Error(`第 ${q.number} 题填空数量或内容无效`);
    result.blanks = a.blanks.map((v, i) =>
      policy === 'preserve' && q.blanks[i]?.value.trim()
        ? q.blanks[i]!.value
        : String(v).trim(),
    );
    if (result.blanks.some((v) => !v.trim()) && !result.needsReview)
      throw new Error(`第 ${q.number} 题仍有空答案`);
  } else {
    if (
      !Array.isArray(a.optionIds) ||
      a.optionIds.some(
        (v) => typeof v !== 'string' || !q.options.some((o) => o.id === v),
      )
    )
      throw new Error(`第 ${q.number} 题引用了不存在的选项`);
    if (new Set(a.optionIds).size !== a.optionIds.length)
      throw new Error(`第 ${q.number} 题选项重复`);
    if (
      q.type !== 'multiple' &&
      a.optionIds.length !== 1 &&
      !result.needsReview
    )
      throw new Error(`第 ${q.number} 题必须选择一个选项`);
    if (a.optionIds.length === 0 && !result.needsReview)
      throw new Error(`第 ${q.number} 题未选择答案`);
    if (q.type !== 'multiple' && a.optionIds.length > 1)
      throw new Error(`第 ${q.number} 题选项数量无效`);
    result.optionIds = a.optionIds as string[];
  }
  return result;
}
export function validateBatch(
  questions: QuestionRecord[],
  raw: unknown,
  policy: DraftPolicy,
): AnswerProposal[] {
  const container =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).answers
      : raw;
  if (!Array.isArray(container) || container.length !== questions.length)
    throw new Error('模型返回的题目数量不一致');
  if (new Set(container.map((a) => a?.questionId)).size !== container.length)
    throw new Error('模型返回了重复题目 ID');
  return questions.map((q) =>
    normalizeProposal(
      q,
      container.find((a) => a?.questionId === q.id),
      policy,
    ),
  );
}
export function existingProposal(q: QuestionRecord): AnswerProposal {
  return {
    questionId: q.id,
    ...(q.type === 'blank'
      ? { blanks: q.blanks.map((b) => b.value) }
      : { optionIds: [...q.existing] }),
    explanation: '保留已有答案',
    source: 'own',
    needsReview: false,
  };
}
export function completeAnswer(
  q: QuestionRecord,
  proposal?: AnswerProposal,
  allowUncertain = false,
): boolean {
  if (
    q.issues.length ||
    q.type === 'unsupported' ||
    !proposal ||
    (proposal.needsReview && !allowUncertain)
  )
    return false;
  if (q.type === 'blank')
    return (
      proposal.blanks?.length === q.blanks.length &&
      proposal.blanks.every((b) => b.trim().length > 0)
    );
  const ids = proposal.optionIds ?? [];
  return (
    ids.length > 0 &&
    (q.type === 'multiple' || ids.length === 1) &&
    ids.every((id) => q.options.some((o) => o.id === id))
  );
}
export function readbackMatches(
  questions: QuestionRecord[],
  proposals: AnswerProposal[],
): boolean {
  return proposals.every((a) => {
    const q = questions.find((q) => q.id === a.questionId);
    if (!q) return false;
    if (q.type === 'blank')
      return (
        q.blanks.length === a.blanks?.length &&
        q.blanks.every(
          (b, i) => normalizeText(b.value) === normalizeText(a.blanks![i]!),
        )
      );
    return (
      [...q.existing].sort().join('|') ===
      [...(a.optionIds ?? [])].sort().join('|')
    );
  });
}
export function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
}
export function parseAnswerJson(content: string): unknown {
  let value = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(value);
  } catch {
    /* Tolerate a brief prefix, not arbitrary JavaScript. */
  }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) {
    value = value.slice(start, end + 1);
    return JSON.parse(value);
  }
  throw new Error('模型未返回有效 JSON');
}
