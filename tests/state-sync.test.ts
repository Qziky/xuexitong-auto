import { expect, it } from 'vitest';
import { initialState } from '../src/domain';
import { applyStateDelta, diffState } from '../src/state-sync';
import type { TaskPreparation } from '../src/domain';
it('single question changes preserve other question and candidate identities for rendering', () => {
  const before = initialState();
  const q = {
    id: 'q',
    number: 1,
    type: 'single',
    stem: 'a',
    options: [],
    existing: [],
    blanks: [],
    issues: [],
    required: true,
  };
  before.preparations.t = {
    snapshot: { questions: [q, { ...q, id: 'q2' }] },
    proposals: [
      { questionId: 'q', needsReview: false },
      { questionId: 'q2', needsReview: false },
    ],
  } as unknown as TaskPreparation;
  const after = structuredClone(before);
  after.preparations.t!.snapshot!.questions[0]!.stem = 'changed';
  after.preparations.t!.proposals![0]!.needsReview = true;
  const applied = applyStateDelta(before, diffState(before, after, 1))!;
  expect(applied.preparations.t!.snapshot!.questions[0]).not.toBe(q);
  expect(applied.preparations.t!.snapshot!.questions[1]).toBe(
    before.preparations.t!.snapshot!.questions[1],
  );
  expect(applied.preparations.t!.proposals![1]).toBe(
    before.preparations.t!.proposals![1],
  );
});
it('increments changed maps without replacing unrelated question preparations and rejects gaps', () => {
  const before = initialState();
  before.revision = 3;
  const after = structuredClone(before);
  after.scan.note = '完成';
  after.currentTaskId = 'a';
  const delta = diffState(before, after, 4);
  expect(delta.fields).toEqual({ scan: after.scan, currentTaskId: 'a' });
  const applied = applyStateDelta(before, delta)!;
  expect(applied.preparations).toBe(before.preparations);
  expect(applied.scan.note).toBe('完成');
  expect(applyStateDelta(initialState(), delta)).toBeUndefined();
});
it('removed optional fields clear stale UI state', () => {
  const before = initialState();
  before.currentTaskId = 'old';
  const after = initialState();
  expect(
    applyStateDelta(
      before,
      JSON.parse(JSON.stringify(diffState(before, after, 1))),
    )?.currentTaskId,
  ).toBeUndefined();
});
