import { useState } from 'react';
import type { AppState } from '../domain';
import {
  readingIntervalFromSeconds,
  validateLearningSettings,
} from '../learning-settings';
import { command } from './client';
export function LearningSettingsPanel({
  state,
  onError,
  onRefresh,
}: {
  state: AppState;
  onError(value: string): void;
  onRefresh(): Promise<void>;
}) {
  const [seconds, setSeconds] = useState(
    String(state.learningSettings.readingIntervalMs / 1000),
  );
  const [busy, setBusy] = useState(false);
  const [rate, setRate] = useState<1 | 2>(
    state.learningSettings.preferredPlaybackRate ?? 2,
  );
  const [saved, setSaved] = useState(false);
  async function save() {
    setBusy(true);
    setSaved(false);
    onError('');
    try {
      const settings = validateLearningSettings({
        readingIntervalMs: readingIntervalFromSeconds(seconds),
        preferredPlaybackRate: rate,
      });
      await command('save-learning-settings', { settings });
      await onRefresh();
      setSaved(true);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <h2>自动学习</h2>
      <label>
        阅读节奏（秒）
        <input
          type="number"
          min={0.25}
          max={5}
          step={0.001}
          value={seconds}
          onChange={(e) => {
            setSeconds(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label>
        播放速度
        <select
          value={rate}
          onChange={(e) => {
            setRate(Number(e.target.value) as 1 | 2);
            setSaved(false);
          }}
        >
          <option value={2}>优先 2 倍速（平台支持时）</option>
          <option value={1}>正常速度</option>
        </select>
      </label>
      <p className="help">
        每 0.25–5 秒翻页或逐屏滚动，默认 0.25
        秒。下一任务生效；平台要求的阅读时长仍需满足。倍速不可用时正常播放，课程访问间隔保持
        1 秒。
      </p>
      <button className="primary" disabled={busy} onClick={() => void save()}>
        保存学习设置
      </button>
      {saved && (
        <p className="success" role="status">
          已保存，从下一任务生效
        </p>
      )}
    </section>
  );
}
