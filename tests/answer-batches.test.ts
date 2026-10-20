import { describe, expect, it, vi } from 'vitest';
import type { AnswerProposal, QuestionRecord } from '../src/domain';
import { initialState } from '../src/domain';
import { migrateState } from '../src/state-migration';
import {
  answerSettingsDefaults,
  validateAnswerSettings,
} from '../src/answer-settings';
import { solveAnswerBatches } from '../src/answer-batches';
import { SerialChannel } from '../src/serial-channel';

/** Create synthetic questions without course or account data. */
function questions(count: number): QuestionRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index),
    number: index + 1,
    type: 'single',
    stem: 'Synthetic question',
    options: [],
    blanks: [],
    existing: [],
    issues: [],
    required: true,
  }));
}
/** Hold a simulated response until the test chooses its completion order. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Produce a candidate tied to a stable synthetic question ID. */
function answer(question: QuestionRecord): AnswerProposal {
  return {
    questionId: question.id,
    optionIds: [],
    explanation: 'fixture',
    needsReview: false,
  };
}

describe('independent bounded answer requests', () => {
  it('migrates missing settings and retains valid 50 independently of vision concurrency', () => {
    const state = initialState();
    expect(
      migrateState({ ...state, answerSettings: undefined }).answerSettings,
    ).toEqual({ concurrency: 3, batchSize: 5 });
    expect(
      migrateState({
        ...state,
        answerSettings: { concurrency: 50, batchSize: 12 },
      }).answerSettings,
    ).toEqual({ concurrency: 50, batchSize: 12 });
    expect(answerSettingsDefaults({ concurrency: 99, batchSize: 0 })).toEqual({
      concurrency: 50,
      batchSize: 1,
    });
    for (const value of [
      null,
      {},
      { concurrency: 51, batchSize: 5 },
      { concurrency: 2.5, batchSize: 5 },
    ])
      expect(() => validateAnswerSettings(value)).toThrow('1 至 50');
  });
  it('starts 50 requests, queues the remainder, and merges out-of-order responses by batch', async () => {
    const gates = Array.from({ length: 60 }, deferred);
    let active = 0,
      peak = 0;
    const execute = vi.fn(async (batch: QuestionRecord[]) => {
      active++;
      peak = Math.max(peak, active);
      await gates[Number(batch[0]!.id)]!.promise;
      active--;
      return batch.map(answer);
    });
    const result = solveAnswerBatches(
      questions(60),
      { concurrency: 50, batchSize: 1 },
      new AbortController().signal,
      execute,
      () => {},
      () => {},
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(50));
    for (let index = 49; index >= 0; index--) gates[index]!.resolve();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(60));
    for (let index = 59; index >= 50; index--) gates[index]!.resolve();
    expect((await result).answers.map((value) => value.questionId)).toEqual(
      questions(60).map((value) => value.id),
    );
    expect(peak).toBe(50);
  });
  it('supports batches larger than five and monotonically increasing completion counts', async () => {
    const progress: number[] = [],
      sizes: number[] = [];
    const result = await solveAnswerBatches(
      questions(17),
      { concurrency: 2, batchSize: 7 },
      new AbortController().signal,
      async (batch) => {
        sizes.push(batch.length);
        return batch.map(answer);
      },
      () => {},
      (_, __, done) => {
        progress.push(done);
      },
    );
    expect(sizes).toEqual([7, 7, 3]);
    expect(result.answers).toHaveLength(17);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(17);
  });
  it.each(['failure', 'user cancellation'])(
    'stops sibling and remaining requests on %s',
    async (mode) => {
      const first = deferred(),
        controller = new AbortController();
      const signals: AbortSignal[] = [];
      const execute = vi.fn(
        async (batch: QuestionRecord[], signal: AbortSignal) => {
          signals.push(signal);
          if (batch[0]!.id === '0' && mode === 'failure') {
            await first.promise;
            throw new Error('API Key 鉴权失败');
          }
          return new Promise<AnswerProposal[]>((_, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            ),
          );
        },
      );
      const result = solveAnswerBatches(
        questions(10),
        { concurrency: 3, batchSize: 1 },
        controller.signal,
        execute,
        () => {},
        () => {},
      );
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
      if (mode === 'failure') {
        first.resolve();
        expect((await result).error).toMatchObject({
          message: 'API Key 鉴权失败',
        });
      } else {
        const rejected = expect(result).rejects.toThrow('操作已取消');
        controller.abort();
        await rejected;
      }
      expect(execute).toHaveBeenCalledTimes(3);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    },
  );
  it('preserves priority, queued cancellation and idempotent release with multiple slots', async () => {
    const lane = new SerialChannel(2),
      controller = new AbortController();
    const one = await lane.acquire(),
      two = await lane.acquire();
    let lowStarted = false;
    const low = lane.acquire(undefined, 0).then((release) => {
      lowStarted = true;
      return release;
    });
    const high = lane.acquire(undefined, 1);
    const cancelled = expect(
      lane.acquire(controller.signal, 2),
    ).rejects.toThrow('取消');
    controller.abort();
    await cancelled;
    one();
    const releaseHigh = await high;
    expect(lowStarted).toBe(false);
    two();
    const releaseLow = await low;
    releaseHigh();
    releaseLow();
    one();
    expect(lane.details()).toEqual({ active: 0, queued: 0, limit: 2 });
  });
});
