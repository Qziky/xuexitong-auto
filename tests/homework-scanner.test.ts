import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
import { inertDocument, parseScanDocument } from '../src/scan-parser';
import { PlatformAccessError, platformBlockFor } from '../src/platform-access';

const mock = vi.hoisted(() => ({
  store: {
    state: undefined as any,
    persist: vi.fn(async () => {}),
    log: vi.fn(),
  },
  offscreen: vi.fn(),
  discoverFrames: vi.fn(),
  frameCall: vi.fn(),
  fail: '',
  paging: false,
  wrong: false,
}));
vi.mock('../src/background/store', () => mock.store);
vi.mock('../src/background/transport', () => ({
  offscreen: mock.offscreen,
  discoverFrames: mock.discoverFrames,
  frameCall: mock.frameCall,
}));
import { refreshHomeworkLists } from '../src/background/homework-scanner';
const ROOT = 'https://mooc2-ans.chaoxing.com/visit/interaction';
const base = 'https://mooc1.chaoxing.com';
const courses = ['100', '101'].map((courseId) => ({
  id: `${courseId}:200`,
  accountId: 'cx:1',
  title: `课程${courseId}`,
  courseId,
  classId: '200',
  cpi: '300',
  state: 'active',
  url: `${base}/mooc2-ans/mycourse/stu?courseid=${courseId}&clazzid=200`,
  source: { at: 0, url: ROOT, label: '样本' },
  warnings: [],
}));
function row(courseId: string, id = '901') {
  return `<li data="${base}/mooc-ans/mooc2/work/task?courseId=${mock.wrong ? '999' : courseId}&amp;classId=200&amp;workId=${id}"><p>普通作业${id}</p><p class="status">未提交</p><span>开始时间：2026-10-01 12:00 截止时间：2027-01-01 12:00</span></li>`;
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.fail = '';
  mock.paging = false;
  mock.wrong = false;
  mock.store.state = initialState();
  mock.store.state.accountId = 'cx:1';
  mock.store.state.courses = structuredClone(courses);
  mock.discoverFrames.mockResolvedValue([
    {
      tabId: 1,
      frameId: 0,
      url: ROOT,
      accountId: 'cx:1',
      loginRequired: false,
    },
  ]);
  mock.offscreen.mockImplementation(async (job: any) => {
    if (job.op === 'parse')
      return parseScanDocument(
        inertDocument(job.html),
        job.url,
        job.accountId,
        job.course,
      );
    if (job.op !== 'fetch') throw new Error(`列表不应调用：${job.op}`);
    const u = new URL(job.url);
    const course =
      u.searchParams.get('courseId') ?? u.searchParams.get('courseid')!;
    if (/\/work\/list$/.test(u.pathname)) {
      if (mock.fail === 'captcha')
        throw new PlatformAccessError(
          platformBlockFor(`${base}/antispiderShowVerify.ac`),
        );
      if (mock.fail === 'rate-limit')
        throw new PlatformAccessError(platformBlockFor(job.url, 'rate-limit'));
      if (mock.fail === 'redirect')
        return {
          url: `${base}/mooc2/work/task?courseId=${course}&classId=200&workId=901`,
          html: row(course),
        };
      if (mock.fail === 'empty')
        return { url: job.url, html: '<div>暂无作业</div>' };
      if (mock.fail === 'unknown')
        return { url: job.url, html: '<div class="work-list"></div>' };
      const next =
        mock.paging && !u.searchParams.has('page')
          ? `<a href="/mooc2/work/list?courseId=${course}&amp;classId=200&amp;page=2">下一页</a>`
          : '';
      return {
        url: job.url,
        html: row(course, u.searchParams.has('page') ? '902' : '901') + next,
      };
    }
    return {
      url: job.url,
      html: '<a data-url="/mooc2/work/list">作业</a><iframe src="/mycourse/studentcourse?knowledgeid=1"></iframe><a href="/knowledge/cards?knowledgeid=1">章节</a><a href="/api/work?workId=9">题目</a>',
    };
  });
});
describe('独立普通作业列表', () => {
  it('只打开个人中心时，通过课程导航字段获取作业，不依赖用户打开课程或作业页', async () => {
    mock.discoverFrames.mockResolvedValue([
      {
        tabId: 1,
        frameId: 0,
        url: 'https://i.chaoxing.com/base?ws=1',
        accountId: 'cx:1',
        loginRequired: false,
      },
    ]);
    const original = mock.offscreen.getMockImplementation()!;
    mock.offscreen.mockImplementation(async (job) => {
      if (job.op === 'fetch' && job.purpose === 'navigation') {
        const courseId = new URL(job.url).searchParams.get('courseid');
        return {
          url: job.url,
          html: `<input id="enc" value="page-${courseId}">
          <input id="workEnc" value="work-${courseId}"><input id="openc" value="open-${courseId}">
          <li dataurl="${base}/mooc2/work/list">作业</li>
          <iframe src="/mycourse/studentcourse"></iframe><a href="/knowledge/cards">章节</a>`,
        };
      }
      if (job.op === 'fetch' && job.purpose === 'homework-list') {
        const params = new URL(job.url).searchParams;
        const id = params.get('courseId');
        expect(params.get('enc')).toBe(`work-${id}`);
        expect(params.get('stuenc')).toBe(`page-${id}`);
        expect(params.get('openc')).toBe(`open-${id}`);
      }
      return original(job);
    });
    await refreshHomeworkLists();
    expect(mock.frameCall).not.toHaveBeenCalled();
    expect(mock.store.state.tasks).toHaveLength(2);
    expect(
      mock.store.state.courses.map(
        (course: any) => course.homeworkCounts.total,
      ),
    ).toEqual([1, 1]);
    expect(
      mock.offscreen.mock.calls
        .filter(([job]) => job.op === 'fetch')
        .map(([job]) => job.purpose),
    ).toEqual(['navigation', 'homework-list', 'navigation', 'homework-list']);
  });
  it('首页刷新自动修复旧版保存但未确认的入口', async () => {
    const key = 'cx:1:100:200';
    mock.store.state.homeworkCache[key] = {
      accountId: 'cx:1',
      courseId: '100:200',
      entryUrls: [
        `${base}/mooc2/work/list?courseId=100&classId=200&enc=old-page-token`,
      ],
      taskIds: [],
      complete: false,
      note: '部分作业列表未确认，保留上次记录',
    };
    await refreshHomeworkLists('100:200', true);
    const fetches = mock.offscreen.mock.calls
      .filter(([job]) => job.op === 'fetch')
      .map(([job]) => job);
    expect(fetches.map((job) => job.purpose)).toEqual([
      'navigation',
      'homework-list',
    ]);
    expect(fetches[1].url).not.toContain('old-page-token');
    expect(mock.store.state.homeworkCache[key].complete).toBe(true);
  });
  it('用户课程页面尚未渲染导航时，读取外壳 HTML 补齐入口', async () => {
    mock.discoverFrames.mockResolvedValue([
      {
        tabId: 1,
        frameId: 0,
        url: courses[0]!.url,
        accountId: 'cx:1',
        loginRequired: false,
      },
    ]);
    mock.frameCall.mockResolvedValue({
      url: courses[0]!.url,
      html: '<div>正在加载</div>',
    });
    await refreshHomeworkLists('100:200');
    expect(mock.frameCall).toHaveBeenCalledOnce();
    expect(
      mock.offscreen.mock.calls
        .filter(([job]) => job.op === 'fetch')
        .map(([job]) => job.purpose),
    ).toEqual(['navigation', 'homework-list']);
    expect(mock.store.state.tasks).toHaveLength(1);
  });
  it('列表没有返回成绩时仍保留已经核验的提交成绩', async () => {
    await refreshHomeworkLists();
    const task = mock.store.state.tasks[0];
    task.status = 'submitted';
    task.grade = '88';
    const original = mock.offscreen.getMockImplementation()!;
    mock.offscreen.mockImplementation(async (job) => {
      const result = await original(job);
      if (job.op === 'fetch' && /\/work\/list/.test(job.url))
        result.html = result.html.replace('未提交', '已提交');
      return result;
    });
    await refreshHomeworkLists('100:200', true);
    expect(
      mock.store.state.tasks.find((item: any) => item.id === task.id),
    ).toMatchObject({ status: 'submitted', grade: '88' });
  });
  it('更新所有课程和分页，只读取导航外壳与作业列表', async () => {
    mock.paging = true;
    await refreshHomeworkLists();
    const jobs = mock.offscreen.mock.calls.map(([job]) => job);
    expect(jobs.every((job) => ['fetch', 'parse'].includes(job.op))).toBe(true);
    expect(
      jobs
        .filter((job) => job.op === 'fetch')
        .every((job) => ['navigation', 'homework-list'].includes(job.purpose)),
    ).toBe(true);
    expect(
      jobs
        .filter((job) => job.op === 'fetch')
        .map((job) => new URL(job.url).pathname),
    ).toEqual([
      '/mooc2-ans/mycourse/stu',
      '/mooc2/work/list',
      '/mooc2/work/list',
      '/mooc2-ans/mycourse/stu',
      '/mooc2/work/list',
      '/mooc2/work/list',
    ]);
    expect(mock.store.state.tasks).toHaveLength(4);
    expect(mock.store.state.courses[0].homeworkCounts).toEqual({
      completed: 0,
      total: 2,
    });
  });
  it('五分钟缓存复用，单课程强制刷新不重读外壳', async () => {
    await refreshHomeworkLists(courses[0]!.id);
    const calls = mock.offscreen.mock.calls.length;
    await refreshHomeworkLists(courses[0]!.id);
    expect(mock.offscreen).toHaveBeenCalledTimes(calls);
    await refreshHomeworkLists(courses[0]!.id, true);
    expect(
      mock.offscreen.mock.calls
        .slice(calls)
        .filter(([job]) => job.op === 'fetch')
        .map(([job]) => job.purpose),
    ).toEqual(['homework-list']);
  });
  it.each(['captcha', 'rate-limit'])(
    '%s 立即中断，不请求后续课程、不重试，保留旧任务',
    async (fail) => {
      await refreshHomeworkLists(courses[0]!.id);
      const tasks = structuredClone(mock.store.state.tasks);
      const key = 'cx:1:100:200';
      const at = mock.store.state.homeworkCache[key].at;
      mock.offscreen.mockClear();
      mock.fail = fail;
      await refreshHomeworkLists(undefined, true);
      expect(mock.store.state.scan.phase).toBe('blocked');
      expect(mock.store.state.tasks).toEqual(tasks);
      expect(mock.store.state.homeworkCache[key].at).toBe(at);
      expect(
        mock.offscreen.mock.calls.filter(([job]) => job.op === 'fetch'),
      ).toHaveLength(1);
    },
  );
  it('动态空容器或题目重定向不能被当作没有作业', async () => {
    await refreshHomeworkLists(courses[0]!.id);
    const key = 'cx:1:100:200';
    mock.fail = 'unknown';
    await refreshHomeworkLists(courses[0]!.id, true);
    expect(mock.store.state.homeworkCache[key].complete).toBe(false);
    expect(mock.store.state.tasks[0].listed).toBe(true);
    mock.fail = 'redirect';
    await refreshHomeworkLists(courses[0]!.id, true);
    expect(mock.store.state.homeworkCache[key].note).toContain('失败');
    expect(mock.store.state.tasks[0].listed).toBe(true);
  });
  it('完整空列表停止展示和提醒旧作业，但保留历史记录', async () => {
    await refreshHomeworkLists(courses[0]!.id);
    mock.fail = 'empty';
    await refreshHomeworkLists(courses[0]!.id, true);
    expect(mock.store.state.homeworkCache['cx:1:100:200'].complete).toBe(true);
    expect(mock.store.state.tasks[0].listed).toBe(false);
    expect(mock.store.state.courses[0].homeworkCounts.total).toBe(0);
  });
  it('跨课程作业链接不覆盖本课程缓存', async () => {
    await refreshHomeworkLists(courses[0]!.id);
    mock.wrong = true;
    await refreshHomeworkLists(courses[0]!.id, true);
    expect(mock.store.state.homeworkCache['cx:1:100:200'].complete).toBe(false);
    expect(mock.store.state.tasks[0].listed).toBe(true);
  });
  it('没有真实导航入口时提示打开作业页，继续其他课程', async () => {
    mock.store.state.courses[0].url = `${base}/mycourse/studentcourse?courseid=100&clazzid=200`;
    await refreshHomeworkLists();
    expect(mock.store.state.homeworkCache['cx:1:100:200'].note).toContain(
      '打开本课程作业页',
    );
    expect(mock.store.state.tasks).toHaveLength(1);
    expect(mock.store.state.tasks[0].courseId).toBe('101:200');
  });
});
