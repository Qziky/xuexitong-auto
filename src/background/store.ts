import {
  DEFAULT_PROVIDER,
  initialState,
  publicProvider,
  type AppState,
  type ProviderConfig,
  type RecognitionSettings,
  TEXT_PROCESSING_VERSION,
} from '../domain';
import {
  recognitionDefaults,
  MIN_VISION_CONCURRENCY,
  MAX_VISION_CONCURRENCY,
  RECOGNITION_STRATEGIES,
} from '../recognition-settings';
import { normalizeBaseUrl, redact } from '../security';
import { migrateState } from '../state-migration';
import { validateLearningSettings } from '../learning-settings';
import { stripImageResources } from '../image-content';
import { diffState } from '../state-sync';
import {
  invalidateCandidates,
  usesRecognitionEngine,
} from '../cache-invalidation';
import {
  configureJournal,
  initJournal,
  queryRuns,
  appendEvent,
  putRun,
  safeLogText,
} from './journal';

export let state: AppState = initialState();
export let provider: ProviderConfig = { ...DEFAULT_PROVIDER };
export let visionProvider: ProviderConfig = { ...DEFAULT_PROVIDER };
export function effectiveVisionProvider(): ProviderConfig {
  return structuredClone(
    state.recognition.visionService === 'independent'
      ? visionProvider
      : provider,
  );
}
let writes = Promise.resolve();
let published: AppState | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let publishTimer: ReturnType<typeof setTimeout> | undefined;
let lastPublished = 0;
export function publishState(immediate = false): void {
  if (!immediate && Date.now() - lastPublished < 200) {
    publishTimer ??= setTimeout(
      () => {
        publishTimer = undefined;
        publishState(true);
      },
      200 - (Date.now() - lastPublished),
    );
    return;
  }
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = undefined;
  const old = published;
  state.revision = (old?.revision ?? state.revision ?? 0) + 1;
  const copy = structuredClone(state);
  published = copy;
  lastPublished = Date.now();
  void chrome.runtime
    .sendMessage(
      old
        ? {
            target: 'ui',
            kind: 'state-delta',
            delta: diffState(old, copy, copy.revision!),
          }
        : { target: 'ui', kind: 'state-snapshot', state: copy },
    )
    .catch(() => {});
}
export function stateSnapshot(): AppState {
  publishState(true);
  return structuredClone(state);
}
export async function initStore(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  if (publishTimer) clearTimeout(publishTimer);
  saveTimer = publishTimer = undefined;
  published = undefined;
  await chrome.storage.local.setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS',
  });
  await chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS',
  });
  const saved = (await chrome.storage.local.get([
    'app',
    'provider',
    'visionProvider',
  ])) as {
    app?: AppState;
    provider?: ProviderConfig;
    visionProvider?: ProviderConfig;
  };
  state = migrateState(saved.app);
  const session = await chrome.storage.session.get('preparations');
  state.preparations = Object.fromEntries(
    Object.entries(session.preparations ?? {})
      .filter(
        ([, value]) =>
          (value as import('../domain').TaskPreparation).accountId ===
            state.accountId &&
          (value as import('../domain').TaskPreparation).workflowVersion ===
            TEXT_PROCESSING_VERSION,
      )
      .map(([id, value]) => {
        const record = value as import('../domain').TaskPreparation;
        return [
          id,
          ['extracting', 'restoring', 'solving'].includes(record.phase)
            ? {
                ...record,
                phase: 'cancelled',
                note: '上次准备已中断；打开任务后点击开始解密可重新读取',
              }
            : record,
        ];
      }),
  );
  provider = { ...DEFAULT_PROVIDER, ...saved.provider };
  visionProvider = { ...DEFAULT_PROVIDER, ...saved.visionProvider };
  state.provider = publicProvider(provider);
  state.visionProvider = publicProvider(visionProvider);
  configureJournal(
    (note) => {
      state.logStorageError = note;
      void globalThis.chrome?.runtime
        ?.sendMessage?.({ target: 'ui', kind: 'changed' })
        .catch(() => {});
    },
    () => [provider.apiKey, visionProvider.apiKey],
  );
  await initJournal(state.events);
  // Progress is journaled more frequently than local state. Recover its sequence
  // before any resumed run can append, so a restart never overwrites prior events.
  try {
    for (const savedRun of await queryRuns()) {
      const run = state.operations[savedRun.id];
      if (run) run.seq = Math.max(run.seq, savedRun.seq);
    }
  } catch {
    /* initJournal already reports storage failure without blocking progress. */
  }
  // Reconcile interrupted commands; session candidates are revalidated before use.
  for (const run of Object.values(state.operations)) {
    const lostCandidate =
      run.kind === 'manual' &&
      run.phase === 'waiting-user' &&
      run.taskId &&
      !state.preparations[run.taskId];
    if (run.phase === 'running' || lostCandidate) {
      run.phase = 'cancelled';
      run.finishedAt = run.updatedAt = Date.now();
      run.note = lostCandidate
        ? '浏览器会话已结束，请重新解密'
        : '后台重启，上次操作已中断';
      if (lostCandidate) {
        run.seq++;
        void appendEvent({
          id: `${run.id}:${String(run.seq).padStart(9, '0')}`,
          runId: run.id,
          at: Date.now(),
          seq: run.seq,
          level: 'warn',
          stage: run.stage,
          taskId: run.taskId,
          code: 'interrupted',
          message: run.note,
        });
      }
      void putRun(run);
    }
  }
  for (const workflow of Object.values(state.workflows))
    if (
      workflow.phase === 'running' ||
      (workflow.phase === 'waiting-user' &&
        !state.preparations[workflow.taskId])
    ) {
      workflow.phase = 'cancelled';
      workflow.filled = workflow.readbackVerified = false;
      workflow.note = '上次操作中断，请重新检查页面后继续';
      if (workflow.steps[workflow.stage])
        workflow.steps[workflow.stage]!.status = 'interrupted';
    }
  void chrome.runtime
    .sendMessage({ target: 'offscreen', kind: 'cancel-all' })
    .catch(() => {});
  if (state.scan.phase === 'running')
    state.scan = {
      ...state.scan,
      phase: 'cancelled',
      note: '上次扫描已中断，可手动刷新',
    };
  await persist(true);
}
export function log(
  text: string,
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  const safe = safeLogText(text);
  state.operations ??= {};
  const active = Object.values(state.operations).filter(
    (r) => r.phase === 'running',
  );
  let run = active.length === 1 ? active[0] : undefined;
  if (!run) {
    const id = `activity:${new Date().toISOString().slice(0, 10)}`;
    run = state.operations[id] ??= {
      id,
      kind: 'legacy',
      title: '应用活动',
      phase: 'done',
      stage: 'checking',
      startedAt: Date.now(),
      stageStartedAt: Date.now(),
      updatedAt: Date.now(),
      lastHeartbeatAt: 0,
      lastProgressAt: Date.now(),
      note: '应用活动',
      seq: 0,
    };
  }
  run.seq++;
  run.updatedAt = Date.now();
  void appendEvent({
    id: `${run.id}:${String(run.seq).padStart(9, '0')}`,
    runId: run.id,
    taskId: run.taskId,
    at: Date.now(),
    seq: run.seq,
    level,
    stage: run.stage,
    code: 'activity',
    message: safe,
  });
  void putRun(run);
  state.events = [...state.events, { at: Date.now(), level, text: safe }].slice(
    -100,
  );
}
export function persist(critical = false): Promise<void> {
  state.provider = publicProvider(provider);
  state.visionProvider = publicProvider(visionProvider);
  publishState(critical);
  if (!critical) {
    saveTimer ??= setTimeout(() => {
      saveTimer = undefined;
      void persist(true);
    }, 1000);
    return Promise.resolve();
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  // Raw font payloads are only needed during extraction and must not consume storage quota.
  const snapshot = structuredClone(state);
  const preparations = snapshot.preparations;
  const workspaces = snapshot.workspaces;
  const currentPage = snapshot.currentPage;
  snapshot.preparations = {};
  snapshot.workspaces = {};
  snapshot.currentPage = undefined;
  snapshot.currentTaskId = undefined;
  for (const record of Object.values(preparations)) {
    if (record.snapshot) delete record.snapshot.fontCss;
    stripImageResources(record.snapshot);
  }
  // Recognition evidence owns the other half of the 6 MiB session cache budget.
  let bytes = 0;
  for (const record of Object.values(preparations).sort(
    (a, b) =>
      Number(b.taskId === state.currentTaskId) -
        Number(a.taskId === state.currentTaskId) || b.at - a.at,
  )) {
    const size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (bytes + size > 3 * 1024 * 1024) delete preparations[record.taskId];
    else bytes += size;
  }
  for (const item of snapshot.queue.items) {
    if (item.snapshot) delete item.snapshot.fontCss;
    if (item.draftSnapshot) delete item.draftSnapshot.fontCss;
    stripImageResources(item.snapshot);
    stripImageResources(item.draftSnapshot);
  }
  writes = writes
    .catch(() => {})
    .then(async () => {
      await chrome.storage.local.set({ app: snapshot });
      await chrome.storage.session.set({
        preparations,
        workspaces,
        currentPage,
      });
    });
  return writes;
}
function validatedProvider(
  previous: ProviderConfig,
  value: Partial<ProviderConfig>,
  removeKey = false,
): ProviderConfig {
  const next: ProviderConfig = {
    ...previous,
    ...value,
    apiKey: removeKey ? '' : value.apiKey?.trim() || previous.apiKey,
  };
  next.baseUrl = normalizeBaseUrl(next.baseUrl);
  if (!next.model.trim() || next.model.length > 200)
    throw new Error('模型名称无效');
  if (!['bearer', 'api-key'].includes(next.auth))
    throw new Error('认证方式无效');
  if (
    !Number.isInteger(next.timeoutSec) ||
    next.timeoutSec < 15 ||
    next.timeoutSec > 240
  )
    throw new Error('超时须为 15 至 240 秒');
  if (
    !next.extraBody ||
    typeof next.extraBody !== 'object' ||
    Array.isArray(next.extraBody) ||
    JSON.stringify(next.extraBody).length > 10000
  )
    throw new Error('高级参数必须为 JSON 对象');
  if (
    [
      'model',
      'messages',
      'stream',
      'headers',
      'api_key',
      'apiKey',
      'base_url',
      'baseUrl',
      'tools',
      'tool_choice',
    ].some((k) => k in next.extraBody)
  )
    throw new Error('高级参数含保留字段');
  return next;
}
export async function saveProvider(
  value: Partial<ProviderConfig>,
  removeKey = false,
): Promise<void> {
  provider = validatedProvider(provider, value, removeKey);
  state.providerRevision++;
  state.answerRevision++;
  invalidateCandidates(
    state,
    (q) =>
      state.recognition.visionService === 'shared' &&
      usesRecognitionEngine(q, 'vision'),
  );
  await chrome.storage.local.set({ provider });
  log('模型配置已保存');
  await persist(true);
}
export async function saveRecognition(
  value: RecognitionSettings,
  config?: Partial<ProviderConfig>,
  removeKey = false,
): Promise<void> {
  if (
    !value ||
    !RECOGNITION_STRATEGIES.includes(value.strategy) ||
    (value.imageStrategy !== undefined &&
      value.imageStrategy !== 'manual' &&
      !RECOGNITION_STRATEGIES.includes(value.imageStrategy)) ||
    typeof value.validateOcr !== 'boolean' ||
    !['shared', 'independent'].includes(value.visionService) ||
    !Number.isInteger(value.visionConcurrency) ||
    value.visionConcurrency < MIN_VISION_CONCURRENCY ||
    value.visionConcurrency > MAX_VISION_CONCURRENCY
  )
    throw new Error('文字识别设置无效');
  const next =
    config || removeKey
      ? validatedProvider(visionProvider, config ?? {}, removeKey)
      : visionProvider;
  const old = state.recognition;
  const visualChanged =
    value.visionService !== old.visionService ||
    JSON.stringify(next) !== JSON.stringify(visionProvider);
  state.recognition = recognitionDefaults(value);
  visionProvider = next;
  state.providerRevision++;
  state.recognitionRevision++;
  invalidateCandidates(
    state,
    (q) =>
      (usesRecognitionEngine(q, 'ocr') &&
        (old.validateOcr !== value.validateOcr ||
          value.strategy === 'vision-only')) ||
      (usesRecognitionEngine(q, 'vision') &&
        (visualChanged || value.strategy === 'ocr-only')) ||
      (!!q.images?.length &&
        old.imageStrategy !== value.imageStrategy &&
        !usesRecognitionEngine(q, 'manual')),
  );
  await chrome.storage.local.set({ visionProvider });
  log('文字识别设置已保存；请重新生成候选答案');
  await persist(true);
}
export async function saveLearningSettings(value: unknown): Promise<void> {
  state.learningSettings = validateLearningSettings(value);
  log('自动学习设置已保存；从下一任务生效');
  await persist(true);
}
export function exportDiagnostics(): object {
  return {
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    provider: state.provider,
    recognition: state.recognition,
    learningSettings: state.learningSettings,
    visionProvider: state.visionProvider,
    platformBlock: state.platformBlock
      ? {
          kind: state.platformBlock.kind,
          at: state.platformBlock.at,
          retryAfter: state.platformBlock.retryAfter,
        }
      : undefined,
    scan: { ...state.scan, note: redact(state.scan.note) },
    homeworkLists: state.courses.map((course) => {
      const cache = state.homeworkCache[`${course.accountId}:${course.id}`];
      return {
        title: course.title,
        updatedAt: cache?.at,
        complete: cache?.complete,
        note: cache?.note ? redact(cache.note) : undefined,
      };
    }),
    courses: state.courses.map((c) => ({
      title: c.title,
      state: c.state,
      taskPoints: c.taskPoints,
      homeworkCounts: c.homeworkCounts,
      warnings: c.warnings,
    })),
    tasks: state.tasks.map((t) => ({
      title: t.title,
      type: t.type,
      status: t.status,
      deadline: t.deadline,
      grade: t.grade,
      note: t.note,
    })),
    queue: {
      phase: state.queue.phase,
      policy: state.queue.policy,
      items: state.queue.items.map((i) => ({
        stage: i.stage,
        note: i.note,
        grade: i.grade,
      })),
    },
    events: state.events,
  };
}
