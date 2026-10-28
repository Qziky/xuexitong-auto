import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const foregroundRelease = vi.hoisted(() => vi.fn());
vi.mock('../src/background/learning-foreground', () => ({
  releaseLearningForeground: foregroundRelease,
}));
import { TEXT_PROCESSING_VERSION } from '../src/domain';
import {
  initialState,
  type AppState,
  type PageSnapshot,
  type TaskPreparation,
} from '../src/domain';
import { platformBlockFor, PlatformAccessError } from '../src/platform-access';
import {
  initStore,
  persist,
  state,
  saveRecognition,
  saveAnswerSettings,
  saveProvider,
  effectiveVisionProvider,
  exportDiagnostics,
} from '../src/background/store';
import {
  assertPlatformReady,
  holdPlatform,
  releasePlatformHold,
} from '../src/background/platform';

const VERIFY = 'https://mooc1.chaoxing.com/antispiderShowVerify.ac';
const COURSE = 'https://mooc1.chaoxing.com/mycourse/studentcourse';
let saved: AppState;
let sessionSaved: Record<string, TaskPreparation>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  saved = initialState();
  sessionSaved = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        setAccessLevel: vi.fn(async () => {}),
        get: vi.fn(async () => ({ app: structuredClone(saved) })),
        set: vi.fn(async ({ app }: { app: AppState }) => {
          if (app) saved = structuredClone(app);
        }),
      },
      session: {
        setAccessLevel: vi.fn(async () => {}),
        get: vi.fn(async () => ({
          preparations: structuredClone(sessionSaved),
        })),
        set: vi.fn(async ({ preparations }) => {
          sessionSaved = structuredClone(preparations);
        }),
      },
    },
    runtime: {
      sendMessage: vi.fn(async () => {}),
      getManifest: () => ({ version: '0.2.2' }),
    },
  });
});

describe('候选答案只在可信会话存储中保存', () => {
  it('四种识别设置使旧候选失效，共用和独立视觉服务均仅公开是否已填写密钥', async () => {
    await initStore();
    await saveProvider({ apiKey: 'answer-test-credential' });
    expect(effectiveVisionProvider().apiKey).toBe('answer-test-credential');
    const revision = state.providerRevision;
    for (const strategy of [
      'ocr-only',
      'vision-only',
      'ocr-first',
      'vision-first',
    ] as const) {
      state.preparations.stale = {} as TaskPreparation;
      await saveRecognition(
        {
          ...state.recognition,
          strategy,
          validateOcr: false,
          visionService: 'independent',
        },
        {
          baseUrl: 'https://vision.example/v1',
          model: 'vision',
          apiKey: 'vision-test-credential',
          auth: 'api-key',
        },
      );
      expect(state.preparations).toEqual({});
      expect(effectiveVisionProvider().apiKey).toBe('vision-test-credential');
      expect(effectiveVisionProvider().auth).toBe('api-key');
      expect(state.visionProvider.hasKey).toBe(true);
      expect(state.recognition.strategy).toBe(strategy);
      expect(JSON.stringify(saved)).not.toContain('vision-test-credential');
      expect(JSON.stringify(exportDiagnostics())).not.toContain(
        'vision-test-credential',
      );
      expect(JSON.stringify(exportDiagnostics())).not.toContain(
        'answer-test-credential',
      );
    }
    expect(state.providerRevision).toBe(revision + 4);
    await saveRecognition({ ...state.recognition, visionService: 'shared' });
    expect(effectiveVisionProvider().apiKey).toBe('answer-test-credential');
    await saveRecognition(
      { ...state.recognition, visionService: 'independent' },
      {},
      true,
    );
    expect(effectiveVisionProvider().apiKey).toBe('');
    expect(state.provider.hasKey).toBe(true);
    state.preparations.stale = {} as TaskPreparation;
    await saveRecognition({ ...state.recognition, visionConcurrency: 128 });
    expect(state.recognition.visionConcurrency).toBe(128);
    expect(saved.recognition.visionConcurrency).toBe(128);
    expect(state.preparations).toEqual({});
    state.preparations.imageStale = {} as TaskPreparation;
    const imageRevision = state.providerRevision;
    await saveRecognition({ ...state.recognition, imageStrategy: 'ocr-only' });
    expect(saved.recognition.imageStrategy).toBe('ocr-only');
    expect(state.providerRevision).toBe(imageRevision + 1);
    expect(state.preparations).toEqual({});
  });
  it('独立保存答题调度，不改变识图配置、答案修订或已有候选', async () => {
    await initStore();
    const recognition = structuredClone(state.recognition),
      revision = state.answerRevision;
    await saveAnswerSettings({ concurrency: 50, batchSize: 12 });
    expect(saved.answerSettings).toEqual({ concurrency: 50, batchSize: 12 });
    expect(state.recognition).toEqual(recognition);
    expect(state.answerRevision).toBe(revision);
    await expect(
      saveAnswerSettings({ concurrency: 51, batchSize: 5 }),
    ).rejects.toThrow('1 至 50');
    expect(state.answerSettings.concurrency).toBe(50);
  });
  it('无效识别设置和视觉请求参数不修改当前配置', async () => {
    await initStore();
    const revision = state.providerRevision;
    await expect(
      saveRecognition({ ...state.recognition, strategy: 'invalid' as any }),
    ).rejects.toThrow('无效');
    await expect(
      saveRecognition({
        ...state.recognition,
        imageStrategy: 'invalid' as any,
      }),
    ).rejects.toThrow('无效');
    await expect(
      saveRecognition(state.recognition, { extraBody: { messages: [] } }),
    ).rejects.toThrow('保留');
    await expect(
      saveRecognition(state.recognition, { timeoutSec: 3 }),
    ).rejects.toThrow('超时');
    await expect(
      saveRecognition({ ...state.recognition, visionConcurrency: 0 }),
    ).rejects.toThrow('无效');
    await expect(
      saveRecognition({ ...state.recognition, visionConcurrency: 129 }),
    ).rejects.toThrow('无效');
    expect(state.providerRevision).toBe(revision);
  });
  it('本地状态保留执行历史，候选只进入 session；字体及图片资源地址均不保存', async () => {
    saved.accountId = 'cx:1';
    await initStore();
    const snapshot: PageSnapshot = {
      adapter: 'legacy' as const,
      taskKey: '100:200:work:900',
      fingerprint: 'fixture',
      accountId: 'cx:1',
      url: '',
      title: '示例题目',
      status: 'pending' as const,
      questions: [
        {
          id: 'q1',
          number: 1,
          type: 'blank',
          stem: '极限〔图片1〕',
          options: [],
          blanks: [],
          existing: [],
          required: true,
          issues: [],
          images: [
            {
              id: 'q1:image1',
              part: 'stem',
              placeholder: '〔图片1〕',
              resourceKey: 'fixture',
              src: 'https://p.ananas.chaoxing.com/math.png?sign=temporary-image-resource',
            },
          ],
        },
      ],
      fontCss: 'temporary-font-resource',
    };
    state.preparations.one = {
      workflowVersion: TEXT_PROCESSING_VERSION,
      taskId: 'one',
      accountId: 'cx:1',
      courseId: '100:200',
      tabId: 1,
      frameId: 3,
      taskKey: snapshot.taskKey,
      fingerprint: snapshot.fingerprint,
      existingDigest: 'none',
      providerRevision: 0,
      policy: 'preserve',
      phase: 'ready',
      at: 100000,
      snapshot,
      proposals: [],
    };
    state.currentTaskId = 'one';
    state.operations.waiting = {
      id: 'waiting',
      kind: 'manual',
      taskId: 'one',
      accountId: 'cx:1',
      phase: 'waiting-user',
      stage: 'filling',
      title: '测试',
      note: '等待继续',
      seq: 3,
      startedAt: 100000,
      stageStartedAt: 100000,
      updatedAt: 100000,
      lastHeartbeatAt: 100000,
      lastProgressAt: 100000,
    };
    state.workflows.one = {
      taskId: 'one',
      runId: 'waiting',
      phase: 'waiting-user',
      stage: 'filling',
      steps: {},
      filled: true,
      readbackVerified: true,
    };
    state.queue.items = [{ taskId: 'one', stage: 'review', snapshot }];
    await persist(true);
    expect(saved.preparations).toEqual({});
    expect(saved.currentTaskId).toBeUndefined();
    expect(sessionSaved.one?.snapshot?.fontCss).toBeUndefined();
    expect(saved.queue.items[0]?.snapshot?.fontCss).toBeUndefined();
    expect(
      sessionSaved.one?.snapshot?.questions[0]?.images?.[0]?.src,
    ).toBeUndefined();
    expect(
      saved.queue.items[0]?.snapshot?.questions[0]?.images?.[0]?.src,
    ).toBeUndefined();
    expect(
      state.preparations.one?.snapshot?.questions[0]?.images?.[0]?.src,
    ).toContain('temporary-image-resource');
    expect(state.preparations.one?.snapshot?.fontCss).toBe(
      'temporary-font-resource',
    );
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_CONTEXTS',
    });
    expect(chrome.storage.session.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_CONTEXTS',
    });
    await initStore();
    expect(state.preparations.one?.phase).toBe('ready');
    expect(state.operations.waiting?.phase).toBe('waiting-user');
    sessionSaved = {};
    await initStore();
    expect(state.preparations).toEqual({});
    expect(state.operations.waiting?.phase).toBe('cancelled');
    expect(state.workflows.one?.readbackVerified).toBe(false);
    expect(state.queue.items[0]?.stage).toBe('review');
  });
  it('后台重启取消未完成的准备并剔除其他账号的会话候选', async () => {
    saved.accountId = 'cx:1';
    const record = {
      workflowVersion: TEXT_PROCESSING_VERSION,
      taskId: 'one',
      accountId: 'cx:1',
      courseId: '100:200',
      tabId: 1,
      frameId: 3,
      taskKey: '100:200:work:900',
      fingerprint: 'fixture',
      existingDigest: 'none',
      providerRevision: 0,
      policy: 'preserve' as const,
      phase: 'solving' as const,
      at: 100000,
    };
    sessionSaved = {
      one: record,
      other: { ...record, accountId: 'cx:2', taskId: 'other' },
      oldOptions: { ...record, workflowVersion: 5, taskId: 'oldOptions' },
    };
    await initStore();
    expect(state.preparations.one?.phase).toBe('cancelled');
    expect(state.preparations.other).toBeUndefined();
    expect(state.preparations.oldOptions).toBeUndefined();
    expect(sessionSaved.other).toBeUndefined();
    expect(sessionSaved.oldOptions).toBeUndefined();
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('平台暂停的持久化与人工恢复', () => {
  it('平台拦截立即释放前台控制器', async () => {
    await initStore();
    state.learning.id = 'learning-platform-block';
    state.learning.phase = 'running';
    await holdPlatform(platformBlockFor(COURSE, 'rate-limit', 220000));
    expect(foregroundRelease).toHaveBeenCalledWith('learning-platform-block');
  });

  it('重新加载存储仍保留验证暂停和提交标记，恢复访问不会自动运行队列', async () => {
    await initStore();
    state.queue.phase = 'running';
    state.queue.items = [
      { taskId: 'one', stage: 'submitting', submitAttempted: true },
    ];
    await holdPlatform({ ...platformBlockFor(VERIFY), tabId: 7 });
    expect(saved.platformBlock?.kind).toBe('captcha');
    expect(saved.queue.items[0]?.stage).toBe('verifying');
    await initStore();
    expect(() => assertPlatformReady()).toThrow(PlatformAccessError);
    expect(state.platformBlock?.tabId).toBe(7);
    expect(state.queue.phase).toBe('paused');
    expect(state.queue.items[0]?.submitAttempted).toBe(true);
    await releasePlatformHold();
    expect(saved.platformBlock).toBeUndefined();
    expect(state.queue.phase).toBe('paused');
  });
  it('遵守服务器等待时间，到期仍暂停，直到用户主动恢复', async () => {
    await initStore();
    await holdPlatform(platformBlockFor(COURSE, 'rate-limit', 220000));
    await expect(releasePlatformHold()).rejects.toThrow(/等待/);
    expect(state.platformBlock?.kind).toBe('rate-limit');
    await vi.advanceTimersByTimeAsync(120000);
    expect(() => assertPlatformReady()).toThrow(PlatformAccessError);
    await releasePlatformHold();
    expect(() => assertPlatformReady()).not.toThrow();
    expect(saved.platformBlock).toBeUndefined();
  });
  it('后续拦截不会缩短等待时间，也不会用普通课程地址覆盖真实验证码入口', async () => {
    await initStore();
    await holdPlatform(platformBlockFor(COURSE, 'rate-limit', 400000));
    await holdPlatform(platformBlockFor(COURSE, 'rate-limit', 220000));
    await holdPlatform({ ...platformBlockFor(VERIFY), tabId: 7 });
    await holdPlatform(platformBlockFor(COURSE));
    expect(state.platformBlock).toMatchObject({
      kind: 'captcha',
      url: VERIFY,
      tabId: 7,
      retryAfter: 400000,
    });
  });
});
