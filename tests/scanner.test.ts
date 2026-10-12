import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
import { PlatformAccessError, platformBlockFor } from '../src/platform-access';
import { isCourseListUrl } from '../src/scan-cache';

const mock = vi.hoisted(() => ({
  store: {
    state: undefined as any,
    persist: vi.fn(async () => {}),
    log: vi.fn(),
  },
  offscreen: vi.fn(),
  frameCall: vi.fn(),
  discoverFrames: vi.fn(),
  waitForFrames: vi.fn(),
}));
vi.mock('../src/background/store', () => mock.store);
vi.mock('../src/background/transport', () => ({
  offscreen: mock.offscreen,
  frameCall: mock.frameCall,
  discoverFrames: mock.discoverFrames,
  waitForFrames: mock.waitForFrames,
  delay: vi.fn(async () => {}),
}));
vi.mock('../src/background/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/platform')>()),
  accessPlatform: vi.fn(async (action: () => unknown) => action()),
}));
import { refreshCourseProgress } from '../src/background/scanner';
const ROOT = 'https://mooc2-ans.chaoxing.com/visit/interaction';
const VERIFY = 'https://mooc1.chaoxing.com/antispiderShowVerify.ac';
const NEXT = 'https://mooc2-ans.chaoxing.com/visit/courselist?page=2';
const HOMEWORK =
  'https://mooc1.chaoxing.com/mooc2/work/list?courseId=1&classId=20';
const courses = ['1', '2'].map((id) => ({
  id: `${id}:20`,
  accountId: 'cx:1',
  title: `课程 ${id}`,
  courseId: id,
  classId: '20',
  cpi: '30',
  state: 'active',
  url: `https://mooc1.chaoxing.com/mycourse/studentcourse?courseid=${id}&clazzid=20`,
  source: { at: 0, url: ROOT, label: '样本' },
  warnings: [],
}));
beforeEach(() => {
  vi.clearAllMocks();
  mock.store.state = initialState();
  mock.store.state.accountId = 'cx:1';
  mock.store.state.courses = structuredClone(courses);
  mock.discoverFrames.mockResolvedValue([
    {
      url: ROOT,
      accountId: 'cx:1',
      top: true,
      loginRequired: false,
      tabId: 1,
      frameId: 0,
    },
  ]);
  mock.frameCall.mockImplementation(async (_ref, cmd) =>
    cmd.op === 'catalog-menu'
      ? { actions: [], fingerprint: 'root' }
      : { html: '课程列表', url: ROOT },
  );
  mock.offscreen.mockImplementation(async (job) => {
    if (job.op === 'parse' && !job.course)
      return {
        courses: structuredClone(courses),
        tasks: [],
        chapters: [],
        links: [],
        loginRequired: false,
      };
    if (job.op === 'fetch')
      throw new PlatformAccessError(platformBlockFor(VERIFY));
  });
});
describe('验证码中断扫描', () => {
  it('首个目录遇到验证码立即暂停，不访问下一门课程，保留已有课程和任务', async () => {
    const oldTask = {
      id: 'old',
      accountId: 'cx:1',
      courseId: '1:20',
      title: '已有任务',
      status: 'pending',
    };
    mock.store.state.tasks = [oldTask];
    await refreshCourseProgress();
    expect(mock.store.state.scan.phase).toBe('blocked');
    expect(mock.store.state.platformBlock.kind).toBe('captcha');
    expect(mock.store.state.courses).toHaveLength(2);
    expect(mock.store.state.tasks).toEqual([oldTask]);
    const fetches = mock.offscreen.mock.calls.filter(
      (args) => args[0].op === 'fetch',
    );
    expect(fetches).toHaveLength(1);
    expect(fetches[0]![0].url).toBe(ROOT);
    await expect(refreshCourseProgress()).rejects.toThrow(/验证码/);
    expect(
      mock.offscreen.mock.calls.filter((args) => args[0].op === 'fetch'),
    ).toHaveLength(1);
  });
  it('已有验证码标签页时，不再发送任何页面读取请求', async () => {
    mock.discoverFrames.mockResolvedValue([
      { url: VERIFY, tabId: 7, verificationRequired: true },
    ]);
    await refreshCourseProgress();
    expect(mock.store.state.scan.phase).toBe('blocked');
    expect(mock.store.state.platformBlock.tabId).toBe(7);
    expect(mock.offscreen).not.toHaveBeenCalled();
  });
  it('首次请求遭遇限流时暂停且不重试', async () => {
    mock.offscreen.mockImplementation(async (job) => {
      if (job.op === 'fetch')
        throw new PlatformAccessError(
          platformBlockFor(ROOT, 'rate-limit', Date.now() + 600000),
        );
      throw new Error(`不应发送扫描操作：${job.op}`);
    });

    await refreshCourseProgress();

    expect(mock.store.state.scan.phase).toBe('blocked');
    expect(mock.store.state.platformBlock.kind).toBe('rate-limit');
    expect(
      mock.offscreen.mock.calls.filter((args) => args[0].op === 'fetch'),
    ).toHaveLength(1);
  });
  it('自动进度刷新只读取课程列表分页，不跟进课程目录、章节卡片或作业', async () => {
    mock.offscreen.mockImplementation(async (job) => {
      if (job.op === 'fetch') return { html: '课程列表', url: job.url };
      if (job.op === 'parse')
        return {
          courses: structuredClone(courses),
          tasks: [],
          chapters: [],
          links:
            job.url === ROOT
              ? [
                  { url: NEXT, kind: 'course-list' },
                  {
                    url: courses[0]!.url,
                    kind: 'chapter-list',
                  },
                  { url: HOMEWORK, kind: 'homework-list' },
                ]
              : [],
          loginRequired: false,
        };
      throw new Error(`不应发送扫描操作：${job.op}`);
    });

    await refreshCourseProgress();

    const reads = mock.offscreen.mock.calls.map((args) => args[0]);
    const fetched = reads.filter((job) => job.op === 'fetch');
    expect(fetched.map((job) => job.url)).toEqual([ROOT, NEXT]);
    expect(fetched.every((job) => isCourseListUrl(job.url))).toBe(true);
    expect(
      reads.filter((job) => job.op === 'parse').every((job) => !job.course),
    ).toBe(true);
    expect(mock.store.state.scan.scope).toBe('progress');
    expect(mock.store.state.progressRefreshedAt).toBeGreaterThan(0);
  });
});
