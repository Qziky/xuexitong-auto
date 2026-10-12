import { describe, expect, it } from 'vitest';
import { inertDocument, parseScanDocument } from '../src/scan-parser';
import type { CourseRecord } from '../src/domain';

const shell =
  'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=100&clazzid=200&cpi=300&enc=page-token';
const entry = 'https://mooc1.chaoxing.com/mooc2/work/list';
const course: CourseRecord = {
  id: '100:200',
  accountId: 'cx:1',
  courseId: '100',
  classId: '200',
  cpi: '300',
  url: shell,
  title: '样本课程',
  state: 'active',
  source: { url: shell, label: '样本', at: 0 },
  warnings: [],
};
// Synthetic navigation samples. Tokens are deliberately different and contain no credentials.
const fields = `
  <input type="hidden" id="courseid" value="100">
  <input type="hidden" name="clazzid" value="200">
  <input type="hidden" id="cpi" value="300">
  <input type="hidden" id="enc" value="page-token">
  <input type="hidden" name="workEnc" value="work-token">
  <input type="hidden" id="openc" value="open-token">`;
function parse(html: string, url = shell) {
  return parseScanDocument(inertDocument(html), url, 'cx:1', course);
}

describe('首页可读取的课程作业导航', () => {
  it.each(['data-url', 'dataurl', 'data'])(
    '识别 %s 菜单地址，分别使用作业令牌和课程令牌',
    (attr) => {
      const parsed = parse(`${fields}<li ${attr}="${entry}">作业</li>`);
      expect(parsed.links).toHaveLength(1);
      const link = parsed.links[0]!;
      expect(link.kind).toBe('homework-list');
      const url = new URL(link.url);
      expect(url.origin + url.pathname).toBe(entry);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        courseId: '100',
        classId: '200',
        cpi: '300',
        enc: 'work-token',
        stuenc: 'page-token',
        openc: 'open-token',
        ut: 's',
        isdisplaytable: '2',
      });
      expect(Number(url.searchParams.get('t'))).toBeGreaterThan(0);
    },
  );
  it('完整入口保留原始授权参数，不使用另一个令牌覆盖', () => {
    const actual = `${entry}?courseId=100&classId=200&enc=explicit-work&stuenc=explicit-page&t=1`;
    const link = parse(`${fields}<a href="${actual}">作业</a>`).links[0]!;
    expect(new URL(link.url).searchParams.get('enc')).toBe('explicit-work');
    expect(new URL(link.url).searchParams.get('stuenc')).toBe('explicit-page');
    expect(new URL(link.url).searchParams.get('t')).toBe('1');
  });
  it('课程首页的字面量脚本跳转只跟进导航外壳', () => {
    const middle =
      'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=100&clazzid=200';
    const parsed = parse(
      `<script>window.location.href = "${shell}";</script>
       <script>location.href = "/mycourse/studentcourse?courseid=100";</script>
       <a onclick="location.href='/knowledge/cards?knowledgeid=1'">章节</a>`,
      middle,
    );
    expect(parsed.links).toEqual([{ url: shell, kind: 'navigation' }]);
    expect(parsed.tasks).toEqual([]);
  });
  it('不把课程令牌当作作业令牌，也不猜测缺失的作业地址', () => {
    expect(
      parse(
        `<input id="enc" value="page-token"><li data-url="${entry}">作业</li>`,
      ).links,
    ).toEqual([]);
    expect(parse(fields).links).toEqual([]);
  });
  it('不跟进跨课程入口、跨站入口或拼接未完成的脚本地址', () => {
    const parsed = parse(`${fields}
      <li dataurl="${entry}?courseId=999&classId=200">其他课程</li>
      <li dataurl="https://example.com/mooc2/work/list">站外</li>
      <script>location.href = '${entry}?courseId=' + courseId;</script>`);
    expect(parsed.links).toEqual([]);
    expect(
      parse(
        `${fields.replace('value="100"', 'value="999"')}<li dataurl="${entry}">作业</li>`,
      ).links,
    ).toEqual([]);
  });
  it('个人中心识别 dataurl 中的真实课程列表入口', () => {
    const url = 'https://i.chaoxing.com/base?ws=2';
    const actual = 'https://mooc2-ans.chaoxing.com/visit/interaction';
    expect(
      parseScanDocument(
        inertDocument(`<li dataurl="${actual}">课程</li>`),
        url,
        'cx:1',
      ).links,
    ).toEqual([{ url: actual, kind: 'course-list' }]);
  });
  it('相对分页地址继承作业列表令牌，不继承原页码', () => {
    const url = `${entry}?courseId=100&classId=200&enc=work-token&stuenc=page-token&pageNum=1`;
    const parsed = parse(
      `<li data="/mooc2/work/task?workId=900">示例作业</li>
      <a href="?pageNum=2">下一页</a>`,
      url,
    );
    expect(parsed.homeworkListKnown).toBe(true);
    const next = new URL(parsed.links[0]!.url);
    expect(Object.fromEntries(next.searchParams)).toMatchObject({
      courseId: '100',
      classId: '200',
      enc: 'work-token',
      stuenc: 'page-token',
      pageNum: '2',
    });
  });
});
