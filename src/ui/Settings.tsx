import { useEffect, useState } from 'react';
import { version } from '../../package.json';
import type { AppState, PublicProvider } from '../domain';
import { normalizeBaseUrl, providerPermission } from '../security';
import { command, preview } from './client';
import { RecognitionSettings } from './RecognitionSettings';
import { LearningSettingsPanel } from './LearningSettings';
export function Settings({
  state,
  onError,
  onRefresh,
}: {
  state: AppState;
  onError(value: string): void;
  onRefresh(): Promise<void>;
}) {
  const [base, setBase] = useState(state.provider.baseUrl);
  const [model, setModel] = useState(state.provider.model);
  const [key, setKey] = useState('');
  const [auth, setAuth] = useState(state.provider.auth);
  const [timeout, setTimeoutValue] = useState(state.provider.timeoutSec);
  const [extra, setExtra] = useState(
    JSON.stringify(state.provider.extraBody, null, 2),
  );
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState('');
  const [testRun, setTestRun] = useState<string>();
  useEffect(() => {
    const run = testRun ? state.operations[testRun] : undefined;
    if (run && run.phase !== 'running') setResult(run.note);
  }, [state.operations, testRun]);
  async function save(test = false) {
    setWorking(true);
    onError('');
    setResult('');
    try {
      const baseUrl = normalizeBaseUrl(base);
      const parsed = JSON.parse(extra);
      if (
        !preview &&
        !(await chrome.permissions.request({
          origins: [providerPermission(baseUrl)],
        }))
      )
        throw new Error('未获得模型服务域名访问权限');
      await command('save-provider', {
        config: {
          baseUrl,
          model: model.trim(),
          ...(key ? { apiKey: key } : {}),
          auth,
          timeoutSec: timeout,
          extraBody: parsed,
        },
      });
      setKey('');
      await onRefresh();
      setResult('设置已保存');
      if (test) {
        const response = await command<{ operationId: string }>(
          'test-provider',
        );
        setTestRun(response.operationId);
        setResult('连接测试已启动，顶部显示实时进度');
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : '设置失败');
    } finally {
      setWorking(false);
    }
  }
  async function download() {
    try {
      const data = await command<object>('export');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `chaoxing-diagnostics-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <>
      <h1>设置</h1>
      <p className="subtle">支持 OpenAI 兼容的 Chat Completions 服务。</p>
      <section className="settings-card">
        <h2>模型服务</h2>
        <label>
          Base URL
          <input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="https://api.xiaomimimo.com/v1"
            spellCheck={false}
          />
        </label>
        <label>
          模型名称
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="mimo-v2.6-pro"
            spellCheck={false}
          />
        </label>
        <label>
          API Key
          <span className="field-status">
            {state.provider.hasKey ? '已填写' : '为空'}
          </span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              state.provider.hasKey
                ? '留空保留已保存的密钥'
                : '输入你的 API Key'
            }
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="help">
          密钥仅保存在本机扩展存储中，配置导出和日志不包含密钥。
        </p>
        <details className="advanced">
          <summary>高级请求参数</summary>
          <label>
            认证方式
            <select
              value={auth}
              onChange={(e) =>
                setAuth(e.target.value as PublicProvider['auth'])
              }
            >
              <option value="bearer">Authorization: Bearer</option>
              <option value="api-key">api-key 请求头</option>
            </select>
          </label>
          <label>
            请求超时（秒）
            <input
              type="number"
              min={15}
              max={240}
              value={timeout}
              onChange={(e) => setTimeoutValue(Number(e.target.value))}
            />
          </label>
          <label>
            额外参数（JSON）
            <textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              spellCheck={false}
              rows={5}
            />
          </label>
          <p className="help">
            例如 temperature 或 max_completion_tokens。模型、消息和 stream
            由扩展管理。
          </p>
        </details>
        <div className="settings-actions">
          <button
            className="primary"
            disabled={working || state.queue.phase === 'running'}
            onClick={() => void save()}
          >
            {working ? '处理中…' : '保存设置'}
          </button>
          <button
            className="secondary"
            disabled={working || state.queue.phase === 'running'}
            onClick={() => void save(true)}
          >
            保存并测试连接
          </button>
        </div>
        {result && (
          <p className="success" role="status">
            <span aria-hidden="true">✓</span>
            {result}
          </p>
        )}
        {state.provider.hasKey && (
          <button
            className="text-button muted small"
            disabled={working || state.queue.phase === 'running'}
            onClick={async () => {
              try {
                await command('save-provider', { config: {}, removeKey: true });
                await onRefresh();
                setResult('本机密钥已清除');
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            清除本机密钥
          </button>
        )}
      </section>
      <RecognitionSettings
        state={state}
        onError={onError}
        onRefresh={onRefresh}
      />
      <LearningSettingsPanel
        state={state}
        onError={onError}
        onRefresh={onRefresh}
      />
      <section className="settings-card">
        <h2>扫描与提醒</h2>
        <label className="toggle-row">
          <span>
            <strong>自动刷新课程</strong>
            <small>
              登录后及每 30 分钟更新课程进度和所有课程的普通作业列表
            </small>
          </span>
          <input
            type="checkbox"
            checked={state.preferences.autoScan}
            onChange={async (e) => {
              try {
                await command('preferences', {
                  value: { autoScan: e.target.checked },
                });
                await onRefresh();
              } catch (err) {
                onError((err as Error).message);
              }
            }}
          />
        </label>
        <label className="toggle-row">
          <span>
            <strong>浏览器通知</strong>
            <small>每日一次未完成任务点汇总，作业截止前 72 / 24 小时提醒</small>
          </span>
          <input
            type="checkbox"
            checked={state.preferences.notifications}
            onChange={async (e) => {
              try {
                await command('preferences', {
                  value: { notifications: e.target.checked },
                });
                await onRefresh();
              } catch (err) {
                onError((err as Error).message);
              }
            }}
          />
        </label>
      </section>
      <section className="settings-card">
        <h2>本机诊断</h2>
        <p className="help">
          导出任务状态和最近活动，便于排查识别问题。账号、题目、页面令牌和密钥不会导出。
        </p>
        <button className="secondary" onClick={() => void download()}>
          导出诊断记录
        </button>
      </section>
      <p className="version">课程任务助手 · {version}</p>
    </>
  );
}
