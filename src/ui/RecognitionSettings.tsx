import { useEffect, useState } from 'react';
import type {
  AppState,
  ProviderConfig,
  RecognitionSettings as Settings,
} from '../domain';
import { normalizeBaseUrl, providerPermission } from '../security';
import { command, preview } from './client';
import {
  MAX_VISION_CONCURRENCY,
  MIN_VISION_CONCURRENCY,
} from '../recognition-settings';

export function RecognitionSettings({
  state,
  onError,
  onRefresh,
}: {
  state: AppState;
  onError(value: string): void;
  onRefresh(): Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings>({ ...state.recognition });
  const [base, setBase] = useState(state.visionProvider.baseUrl);
  const [model, setModel] = useState(state.visionProvider.model);
  const [key, setKey] = useState('');
  const [auth, setAuth] = useState(state.visionProvider.auth);
  const [timeout, setTimeoutValue] = useState(state.visionProvider.timeoutSec);
  const [extra, setExtra] = useState(
    JSON.stringify(state.visionProvider.extraBody, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [testRun, setTestRun] = useState<string>();
  useEffect(() => {
    const run = testRun ? state.operations[testRun] : undefined;
    if (run && run.phase !== 'running') setResult(run.note);
  }, [state.operations, testRun]);
  async function save(test = false, removeKey = false) {
    setBusy(true);
    setResult('');
    onError('');
    try {
      const independent = settings.visionService === 'independent';
      const baseUrl = normalizeBaseUrl(
        independent ? base : state.provider.baseUrl,
      );
      if (
        (independent || test) &&
        !preview &&
        !(await chrome.permissions.request({
          origins: [providerPermission(baseUrl)],
        }))
      )
        throw new Error('未获得视觉服务域名访问权限');
      await command('save-recognition', {
        recognition: settings,
        ...(independent
          ? {
              config: {
                baseUrl,
                model: model.trim(),
                ...(key ? { apiKey: key } : {}),
                auth,
                timeoutSec: timeout,
                extraBody: JSON.parse(extra),
              },
            }
          : {}),
        removeKey,
      });
      setKey('');
      await onRefresh();
      setResult(
        removeKey
          ? '独立视觉密钥已清除'
          : '文字识别设置已保存；请重新生成候选答案',
      );
      if (test) {
        const response = await command<{ operationId: string }>('test-vision');
        setTestRun(response.operationId);
        setResult('视觉连接测试已启动，顶部显示实时进度');
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : '文字识别设置失败');
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || state.queue.phase === 'running';
  return (
    <section className="settings-card">
      <h2>文字识别</h2>
      <label>
        识别策略
        <select
          value={settings.strategy}
          onChange={(e) =>
            setSettings({
              ...settings,
              strategy: e.target.value as Settings['strategy'],
            })
          }
        >
          <option value="ocr-first">OCR → 多模态（默认）</option>
          <option value="vision-first">多模态 → OCR</option>
          <option value="ocr-only">仅 OCR</option>
          <option value="vision-only">仅多模态</option>
        </select>
      </label>
      <label>
        题目图片识别策略
        <select
          value={settings.imageStrategy ?? 'vision-first'}
          onChange={(e) =>
            setSettings({
              ...settings,
              imageStrategy: e.target.value as Settings['imageStrategy'],
            })
          }
        >
          <option value="vision-first">多模态 → OCR（默认）</option>
          <option value="vision-only">仅多模态</option>
          <option value="ocr-first">OCR → 多模态</option>
          <option value="ocr-only">仅 OCR</option>
          <option value="manual">人工复核</option>
        </select>
      </label>
      <p className="help">
        用于题干和选项图片。文字与公式优先转录；无法可靠转录的图表、照片或公式保留原图，生成参考时由视觉模型结合文字作答。选择人工复核时仍由你确认文字。
      </p>
      <label className="toggle-row">
        <span>
          <strong>校验 OCR 结果</strong>
          <small>检查两次识别的一致性与置信度</small>
        </span>
        <input
          type="checkbox"
          checked={settings.validateOcr}
          onChange={(e) =>
            setSettings({ ...settings, validateOcr: e.target.checked })
          }
        />
      </label>
      {!settings.validateOcr && (
        <p className="help">
          关闭后直接采用非空 OCR
          结果；识别异常或空结果才触发兜底。填写、答案校验和提交核验仍然生效。
        </p>
      )}
      <p className="help">
        点击识别文字或一键处理后启动文字和图片转录、保存原图材料；点击生成参考答案后才解题。仅打开页面不会启动
        OCR 或模型。
      </p>
      <label>
        多模态服务
        <select
          value={settings.visionService}
          onChange={(e) =>
            setSettings({
              ...settings,
              visionService: e.target.value as Settings['visionService'],
            })
          }
        >
          <option value="shared">共用答题模型服务（默认）</option>
          <option value="independent">独立视觉服务</option>
        </select>
      </label>
      <label>
        多模态最大并发
        <input
          type="number"
          min={MIN_VISION_CONCURRENCY}
          max={MAX_VISION_CONCURRENCY}
          step={1}
          value={settings.visionConcurrency}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (
              Number.isInteger(value) &&
              value >= MIN_VISION_CONCURRENCY &&
              value <= MAX_VISION_CONCURRENCY
            )
              setSettings({ ...settings, visionConcurrency: value });
          }}
        />
      </label>
      <p className="help">
        仅影响多模态文字转录，扩展内所有识图任务共享此上限；答题请求仍串行。数值越高越依赖服务端的并发与限流能力。
      </p>
      {settings.visionService === 'shared' ? (
        <p className="help">
          使用已保存的答题模型 {state.provider.model}
          。可用下方视觉连接测试核实图片输入能力。
        </p>
      ) : (
        <>
          <label>
            视觉 Base URL
            <input
              value={base}
              onChange={(e) => setBase(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            视觉模型名称
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            视觉 API Key
            <span className="field-status">
              {state.visionProvider.hasKey ? '已填写' : '为空'}
            </span>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                state.visionProvider.hasKey
                  ? '留空保留已保存的密钥'
                  : '输入视觉服务 API Key'
              }
            />
          </label>
          <details className="advanced">
            <summary>视觉高级请求参数</summary>
            <label>
              视觉认证方式
              <select
                value={auth}
                onChange={(e) =>
                  setAuth(e.target.value as ProviderConfig['auth'])
                }
              >
                <option value="bearer">Authorization: Bearer</option>
                <option value="api-key">api-key 请求头</option>
              </select>
            </label>
            <label>
              视觉请求超时（秒）
              <input
                type="number"
                min={15}
                max={240}
                value={timeout}
                onChange={(e) => setTimeoutValue(Number(e.target.value))}
              />
            </label>
            <label>
              视觉额外参数（JSON）
              <textarea
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                rows={5}
                spellCheck={false}
              />
            </label>
          </details>
          <p className="help">
            视觉密钥仅保存在本机可信扩展存储；文字图片在处理结束后释放，不写入历史、日志或导出。
          </p>
        </>
      )}
      <div className="settings-actions">
        <button
          className="primary"
          disabled={disabled}
          onClick={() => void save()}
        >
          {busy ? '处理中…' : '保存识别设置'}
        </button>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => void save(true)}
        >
          保存并测试视觉连接
        </button>
      </div>
      {result && (
        <p className="success" role="status">
          {result}
        </p>
      )}
      {settings.visionService === 'independent' &&
        state.visionProvider.hasKey && (
          <button
            className="text-button muted small"
            disabled={disabled}
            onClick={() => void save(false, true)}
          >
            清除独立视觉密钥
          </button>
        )}
    </section>
  );
}
