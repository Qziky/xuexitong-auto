import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
import { inertDocument, parseScanDocument } from '../src/scan-parser';
import {
  isCourseListUrl,
  isCourseShellUrl,
  isHomeworkListUrl,
} from '../src/scan-cache';

const mock = vi.hoisted(() => ({
  store: {
    state: undefined as any,
    persist: vi.fn(async () => {}),
    log: vi.fn(),
  },
  discoverFrames: vi.fn(),
  frameCall: vi.fn(),
  offscreen: vi.fn(),
  blocked: false,
}));
vi.mock('../src/background/store', () => mock.store);
vi.mock('../src/background/transport', () => ({
  discoverFrames: mock.discoverFrames,
  frameCall: mock.frameCall,
  offscreen: mock.offscreen,
  waitForFrames: vi.fn(),
  delay: vi.fn(),
}));
import { refreshOverview } from '../src/background/scanner';

const home = 'https://i.chaoxing.com/base?ws=1';
const list = 'https://mooc2-ans.chaoxing.com/visit/interaction';
const homeHtml = `<li dataurl="${list}">课程</li>`;
beforeEach(() => {
  vi.clearAllMocks();
  mock.blocked = false;
  mock.store.state = initialState();
  mock.discoverFrames.mockResolvedValue([
    {
      tabId: 1,
      frameId: 0,
      url: home,
      top: true,
      accountId: 'cx:1',
      loginRequired: false,
    },
  ]);
  mock.frameCall.mockImplementation(async (_ref, command) => {
    if (command.op !== 'html')
      throw new Error(`首页刷新不应发送 ${command.op}`);
    return { url: home, html: homeHtml };
  });
  mock.offscreen.mockImplementation(async (job) => {
    if (job.op === 'parse')
      return parseScanDocument(
        inertDocument(job.html),
        job.url,
        job.accountId,
        job.course,
      );
    if (job.op !== 'fetch') throw new Error(`首页刷新不应调用 ${job.op}`);
    const current = new URL(job.url);
    if (isCourseListUrl(job.url))
      return {
        url: job.url,
        html:
          current.pathname === '/base'
            ? homeHtml
            : ['100', '101']
                .map(
                  (id) =>
                    `<li class="courseItem"><a title="课程${id}" href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${id}&amp;clazzid=200&amp;cpi=300&amp;ismooc2=1&amp;v=2">课程${id}</a><span>已完成任务点 1/65</span></li>`,
                )
                .join(''),
      };
    if (isCourseShellUrl(job.url)) {
      if (mock.blocked)
        return {
          url: job.url,
          html: '<h1>【9010】操作异常，请输入图片中的验证码</h1><input name="code"><img src="/verify.jpg">',
        };
      const id = current.searchParams.get('courseid')!;
      return {
        url: `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${id}&clazzid=200&cpi=300&enc=page-${id}`,
        html: `<input id="courseid" value="${id}"><input name="clazzid" value="200">
          <input name="workEnc" value="work-${id}"><input id="openc" value="open-${id}">
          <li data-url="https://mooc1.chaoxing.com/mooc2/work/list">作业</li>
          <iframe src="/mycourse/studentcourse?courseid=${id}"></iframe>`,
      };
    }
    if (isHomeworkListUrl(job.url)) {
      const id = current.searchParams.get('courseId')!;
      expect(current.searchParams.get('enc')).toBe(`work-${id}`);
      expect(current.searchParams.get('stuenc')).toBe(`page-${id}`);
      return {
        url: job.url,
        html: `<li data="https://mooc1.chaoxing.com/mooc2/work/task?courseId=${id}&amp;classId=200&amp;workId=900">
        <p>普通作业</p><p class="status">未交</p><div>截止时间：2027-01-01 12:00</div></li>`,
      };
    }
    throw new Error(`超出首页刷新读取范围：${current.pathname}`);
  });
});

describe('只打开个人中心的完整刷新流程', () => {
  it('更新课程进度及所有普通作业，不打开章节或题目，不调用模型', async () => {
    await refreshOverview();
    expect(mock.store.state.scan.phase).toBe('done');
    expect(mock.store.state.courses).toHaveLength(2);
    expect(mock.store.state.tasks).toHaveLength(2);
    expect(
      mock.store.state.courses.every(
        (course: any) =>
          course.taskPoints.completed === 1 &&
          course.taskPoints.total === 65 &&
          course.homeworkCounts.total === 1,
      ),
    ).toBe(true);
    const fetches = mock.offscreen.mock.calls
      .filter(([job]) => job.op === 'fetch')
      .map(([job]) => job);
    expect(fetches.map((job) => job.purpose)).toEqual([
      'catalog',
      'catalog',
      'navigation',
      'homework-list',
      'navigation',
      'homework-list',
    ]);
    expect(
      mock.frameCall.mock.calls.every(([, command]) => command.op === 'html'),
    ).toBe(true);
    expect(
      mock.offscreen.mock.calls.every(([job]) =>
        ['fetch', 'parse'].includes(job.op),
      ),
    ).toBe(true);
    expect(
      mock.store.state.tasks.every(
        (task: any) => task.deadline && task.status === 'pending',
      ),
    ).toBe(true);
  });
  it('导航外壳返回 9010 时整次暂停，保留旧作业，不请求下一门课程', async () => {
    await refreshOverview();
    const tasks = structuredClone(mock.store.state.tasks);
    mock.offscreen.mockClear();
    mock.blocked = true;
    mock.store.state.homeworkCache = {};
    await refreshOverview(true);
    expect(mock.store.state.scan.phase).toBe('blocked');
    expect(mock.store.state.tasks).toEqual(tasks);
    const reads = mock.offscreen.mock.calls
      .filter(([job]) => job.op === 'fetch')
      .map(([job]) => job);
    expect(reads.map((job) => job.purpose)).toEqual([
      'catalog',
      'catalog',
      'navigation',
    ]);
    expect(reads.some((job) => job.purpose === 'homework-list')).toBe(false);
  });
});
