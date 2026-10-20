import { useLayoutEffect, useState, type ChangeEvent } from 'react';
import { DEFAULT_ANSWER_SETTINGS, type AppState } from '../domain';
import { validateAnswerSettings } from '../answer-settings';
import { command } from './client';

/** Keep answer batching and concurrency separate from image transcription settings. */
export function AnswerSettingsPanel({
  state,
  onError,
  onRefresh,
}: {
  state: AppState;
  onError(value: string): void;
  onRefresh(): Promise<void>;
}) {
  const saved = state.answerSettings ?? DEFAULT_ANSWER_SETTINGS;
  const [concurrency, setConcurrency] = useState(String(saved.concurrency));
  const [batchSize, setBatchSize] = useState(String(saved.batchSize));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // Synchronize before paint so the initial effect cannot overwrite fresh input.
  useLayoutEffect(
    function syncSavedSettings() {
      setConcurrency(String(saved.concurrency));
      setBatchSize(String(saved.batchSize));
    },
    [saved.concurrency, saved.batchSize],
  );
  const values = [Number(concurrency), Number(batchSize)];
  const valid = values.every(
    (value) => Number.isInteger(value) && value >= 1 && value <= 50,
  );
  /** Preserve empty input while a user replaces a number. */
  function updateConcurrency(event: ChangeEvent<HTMLInputElement>) {
    setConcurrency(event.target.value);
    setMessage('');
  }
  /** Update batch size independently of simultaneous request count. */
  function updateBatchSize(event: ChangeEvent<HTMLInputElement>) {
    setBatchSize(event.target.value);
    setMessage('');
  }
  /** Validate and persist settings for the next candidate-generation operation. */
  async function save(): Promise<void> {
    setBusy(true);
    setMessage('');
    onError('');
    try {
      const settings = validateAnswerSettings({
        concurrency: Number(concurrency),
        batchSize: Number(batchSize),
      });
      await command('save-answer-settings', { settings });
      await onRefresh();
      setMessage('已保存，从下一次生成答案生效');
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <h2>答题请求</h2>
      <label>
        同时请求数（1–50）
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          value={concurrency}
          onChange={updateConcurrency}
          disabled={busy}
        />
      </label>
      <label>
        每个请求题数（1–50）
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          value={batchSize}
          onChange={updateBatchSize}
          disabled={busy}
        />
      </label>
      <p className="help">
        同时请求数控制并行发送几个答题请求；每个请求题数控制一批带几题。建议先用
        3 个请求、每批 5 题，遇到限流或输出不完整时调低。
      </p>
      <p className="help">
        已保存：同时最多 {saved.concurrency} 个答题请求，每批最多{' '}
        {saved.batchSize} 题。从下一次生成生效，当前任务的批次划分保持不变。
      </p>
      <button className="primary" disabled={busy || !valid} onClick={save}>
        {busy ? '保存中…' : '保存答题设置'}
      </button>
      {message && (
        <p className="success" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
