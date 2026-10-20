import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  extractPage,
  extractAccount,
  readPageStatus,
} from '../src/page-parser';
import { inertDocument, parseScanDocument } from '../src/scan-parser';
import type { CourseRecord } from '../src/domain';
import { hashText } from '../src/security';
const fixture = (name: string) =>
  readFileSync(resolve(process.cwd(), `tests/fixtures/${name}.html`), 'utf8');
const URL_OLD =
  'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900';
const URL_NEW =
  'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=100&classId=200&workId=901';

describe('提交回执', () => {
  it.each(['script', 'textarea'])(
    '从未初始化的%s编辑器读取服务端草稿',
    (tag) => {
      const content =
        tag === 'script'
          ? '<p>保存 &amp; 文本</p>'
          : '&lt;p&gt;保存 &amp;amp; 文本&lt;/p&gt;';
      const html = `<input name="uid" value="1"><div class="questionLi" id="question101" typename="填空题"><div class="mark_name">示例（ ）</div><${tag} id="answerEditor1011" type="text/plain">${content}</${tag}></div>`;
      const page = extractPage(inertDocument(html), URL_NEW)!;
      expect(page.questions[0]!.blanks).toEqual([
        { id: 'answerEditor1011', kind: 'ueditor', value: '保存 & 文本' },
      ]);
    },
  );
  it('旧版批阅页面读取总成绩和非编辑选项，不能把单题分数当总成绩', () => {
    const url = URL_OLD.replace(
      '/api/work?',
      '/work/selectWorkQuestionYiPiYue?',
    );
    const html =
      '<div class="ceyan_name"><h3>已批阅任务</h3>满分100</div><div class="DividerBox"><span class="achievement">本次成绩<i>80</i>分</span></div><div>已完成</div><div class="TiMu" id="question123"><div class="Zy_TItle"><div class="fontLabel"><span class="newZy_TItle">【单选题】</span>题干</div></div><ul class="Zy_ulTop"><li><i>A、</i><a>选项甲</a></li><li><i>B、</i><a>选项乙</a></li></ul><div class="myAnswerBx"><span>我的答案：</span><div class="answerCon">B</div><span class="scoreNum">20.0</span>分</div><div class="correctAnswerBx"><span>正确答案：</span><div class="answerCon">A</div></div></div>';
    const page = extractPage(inertDocument(html), url)!;
    expect(page).toMatchObject({
      title: '已批阅任务',
      status: 'submitted',
      grade: '80',
    });
    const q = page.questions[0]!;
    expect(q.options.map((o) => o.text)).toEqual(['选项甲', '选项乙']);
    expect(q.existing).toEqual([q.options[1]!.id]);
    expect(q.publishedAnswer?.optionIds).toEqual([q.options[0]!.id]);
    expect(q.options.every((o) => o.key.startsWith('readonly:'))).toBe(true);
    expect(q.issues).toEqual([]);
    expect(
      readPageStatus(
        inertDocument(
          html.replace(
            '<span class="achievement">本次成绩<i>80</i>分</span>',
            '',
          ),
        ),
        url,
      ).grade,
    ).toBeUndefined();
  });
  it('已提交详情只读取作业头部的实际成绩，不将单题分数或满分当成绩', () => {
    const url = URL_NEW.replace('/dowork?', '/view?');
    const doc = inertDocument(
      '<div class="workTitle">满分100</div><div class="detailsHead"><div class="resultNum"><i>80</i>分</div></div><div class="questionLi"><div class="resultNum">5分</div></div>',
    );
    expect(readPageStatus(doc, url)).toMatchObject({
      status: 'submitted',
      grade: '80',
    });
    expect(readPageStatus(doc, URL_NEW).grade).toBeUndefined();
  });
  const receiptUrl =
    'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/prompt?courseId=100&classId=200&workId=901&answerId=123';
  it('识别带提交时间的真实成功容器及不带成绩前缀的分数', () => {
    expect(
      readPageStatus(
        inertDocument(
          '<div class="workCen"><div class="subSucess">100分</div><p class="subTime">提交时间：10-10 10:23</p><a>查看详情</a></div>',
        ),
        receiptUrl,
      ),
    ).toMatchObject({ status: 'submitted', grade: '100' });
  });
  it('无分数但明确待批阅的有效回执也证明提交', () => {
    expect(
      readPageStatus(
        inertDocument(
          '<div class="subSucess">待批阅<p>提交时间：10-10 10:23</p></div>',
        ),
        receiptUrl,
      ).status,
    ).toBe('submitted');
  });
  it('失败提示、满分说明、缺少提交时间或答卷绑定不能报告成功', () => {
    for (const html of [
      '<div>满分100分</div>',
      '<div class="subSucess">100分</div>',
      '<div class="subSucess">操作失败<p>提交时间：10-10 10:23</p></div>',
    ])
      expect(readPageStatus(inertDocument(html), receiptUrl).status).toBe(
        'unknown',
      );
    expect(
      readPageStatus(
        inertDocument(
          '<div class="subSucess">100分<p>提交时间：10-10 10:23</p></div>',
        ),
        receiptUrl.replace('&answerId=123', ''),
      ).status,
    ).toBe('unknown');
  });
});
describe('两种答题页面', () => {
  it('新版已提交详情读取纯文本选项、本人答案和明确公布答案，不能用于写入键', () => {
    const html =
      '<div class="questionLi" id="question123"><h3 class="mark_name"><span class="colorShallow">单选题</span>题干</h3><ul class="mark_letter"><li>A. 3</li><li>B. 4</li></ul><div class="mark_answer"><span><i>我的答案:</i><span class="stuAnswerContent">B</span></span><span><i>正确答案:</i><span class="rightAnswerContent">A</span></span></div></div>';
    const q = extractPage(
      inertDocument(html),
      URL_NEW.replace('/dowork?', '/view?'),
    )!.questions[0]!;
    expect(q.options.map((o) => [o.label, o.text, o.key])).toEqual([
      ['A', '3', 'readonly:0'],
      ['B', '4', 'readonly:1'],
    ]);
    expect(q.existing).toEqual(['q123:o2']);
    expect(q.publishedAnswer?.optionIds).toEqual(['q123:o1']);
    expect(q.issues).toEqual([]);
    // A writable page still requires real controls/keys; no guessing letter keys.
    expect(
      extractPage(inertDocument(html), URL_NEW)!.questions[0]!.issues,
    ).toContain('选项内容或答案键不完整');
  });
  it('旧测验保留真实键，而非显示字母，判断使用 true/false', () => {
    const page = extractPage(inertDocument(fixture('legacy')), URL_OLD)!;
    expect(page.adapter).toBe('legacy');
    expect(page.taskKey).toBe('100:200:work:900');
    expect(page.questions[0]!.options.map((o) => o.key)).toEqual([
      'D',
      'B',
      'C',
      'A',
    ]);
    expect(page.questions[0]!.existing).toEqual(['q900001:o1']);
    expect(page.questions[0]!.obfuscated).toBe(true);
    expect(page.questions[1]!.type).toBe('boolean');
    expect(page.questions[1]!.options.map((o) => o.key)).toEqual([
      'true',
      'false',
    ]);
  });
  it('新作业从 aria-hidden 的 DOM 提取题干，多选读取现有状态', () => {
    const page = extractPage(inertDocument(fixture('modern')), URL_NEW)!;
    expect(page.adapter).toBe('modern');
    expect(page.questions[0]!.stem).toContain('参数 a=3,b=4');
    expect(page.questions[0]!.stem).not.toContain('(单选题)');
    expect(page.questions[1]!.existing).toEqual(['q900012:o1', 'q900012:o3']);
    expect(page.questions[3]!.type).toBe('unsupported');
    expect(page.questions[3]!.issues).toContain('不支持的题型，需人工处理');
  });
  it('答案变化不改变快照，题目或真实答案键变化会改变快照', () => {
    const doc = inertDocument(fixture('modern'));
    const before = extractPage(doc, URL_NEW)!;
    (doc.querySelector('#answer900011') as HTMLInputElement).value = 'A';
    expect(extractPage(doc, URL_NEW)!.fingerprint).toBe(before.fingerprint);
    doc.querySelector('.num_option')!.setAttribute('data', 'Z');
    expect(extractPage(doc, URL_NEW)!.fingerprint).not.toBe(before.fingerprint);
  });
  it('图片被绑定到题干位置，解密前保持待识别', () => {
    const doc = inertDocument(fixture('modern'));
    doc
      .querySelector('.mark_name')!
      .insertAdjacentHTML('beforeend', '<img src="question.png">');
    expect(extractPage(doc, URL_NEW)!.questions[0]!.issues.join()).toContain(
      '图片待识别',
    );
    const q = extractPage(doc, URL_NEW)!.questions[0]!;
    expect(q.stem).toContain('〔图片1〕');
    expect(q.images?.[0]).toMatchObject({
      part: 'stem',
      src: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/question.png',
    });
    const before = extractPage(doc, URL_NEW)!.fingerprint;
    doc.querySelector('.mark_name img')!.setAttribute('src', 'different.png');
    expect(extractPage(doc, URL_NEW)!.fingerprint).not.toBe(before);
  });
  it('文字还原规则升级后，旧候选的题目指纹不能继续复用', () => {
    const page = extractPage(inertDocument(fixture('legacy')), URL_OLD)!;
    const previousFingerprint = hashText(
      JSON.stringify({
        key: page.taskKey,
        adapter: page.adapter,
        font: page.fontCss ? hashText(page.fontCss) : undefined,
        questions: page.questions.map((q) => ({
          id: q.id,
          type: q.type,
          stem: q.stem,
          options: q.options.map((o) => [o.id, o.key, o.text]),
          blanks: q.blanks.map((b) => [b.id, b.kind]),
        })),
      }),
    );
    expect(page.fingerprint).not.toBe(previousFingerprint);
    expect(
      extractPage(inertDocument(fixture('legacy')), URL_OLD)!.fingerprint,
    ).toBe(page.fingerprint);
  });
  it('账号只从身份字段读取，不将 cpi 当成用户 ID', () => {
    expect(
      extractAccount(inertDocument('<input name="cpi" value="300">')),
    ).toBeUndefined();
    expect(extractAccount(inertDocument(''), 'a=x; _uid=123456; b=y')).toBe(
      'cx:123456',
    );
  });
});
describe('课程和任务扫描', () => {
  const course: CourseRecord = {
    id: '100:200',
    accountId: 'cx:123456',
    courseId: '100',
    classId: '200',
    cpi: '300',
    title: '示例课程',
    url: URL_NEW,
    state: 'active',
    source: { at: 1, url: '', label: 'fixture' },
    warnings: [],
  };
  it('课程封面与标题链接去重，缺失汇总保留 unknown，并发现分页和文件夹', () => {
    const parsed = parseScanDocument(
      inertDocument(fixture('course-list')),
      'https://mooc2-ans.chaoxing.com/visit/interaction',
      'cx:123456',
    );
    expect(parsed.courses).toHaveLength(3);
    expect(parsed.courses[0]!.title).toBe('示例课程');
    expect(parsed.courses[0]!.taskPoints).toEqual({ completed: 1, total: 65 });
    expect(parsed.courses[1]!.taskPoints).toBeUndefined();
    expect(parsed.courses[2]!.state).toBe('ended');
    expect(parsed.links.filter((l) => l.kind === 'course-list')).toHaveLength(
      2,
    );
  });
  it('不生成章节、卡片或题目链接，仅保留普通作业导航', () => {
    const parsed = parseScanDocument(
      inertDocument(
        '<li class="chapter_item" id="cur1">2 个待完成任务点</li><iframe src="/knowledge/cards?knowledgeid=1"></iframe><a href="/api/work?workId=9">测验</a><a data-url="/mooc2/work/list">作业</a>',
      ),
      'https://mooc1.chaoxing.com/mooc2-ans/mycourse/stu?courseid=100&clazzid=200',
      'cx:123456',
      course,
    );
    expect(parsed).not.toHaveProperty('chapters');
    expect(parsed.tasks).toEqual([]);
    expect(parsed.links.map((link) => link.kind)).toEqual(['homework-list']);
  });
  it('开始日期不会冒充截止日期；显式结束时间和剩余时长分别读取', () => {
    const parse = (label: string) =>
      parseScanDocument(
        inertDocument(
          `<li data="https://mooc1.chaoxing.com/mooc2/work/task?courseId=100&classId=200&workId=9"><p>示例作业</p><p class="status">未提交</p><span>${label}</span></li>`,
        ),
        'https://mooc1.chaoxing.com/mooc2/work/list?courseId=100&classId=200',
        'cx:123456',
        course,
      ).tasks[0]!;
    expect(parse('开始时间：2026-01-01 12:00').deadline).toBeUndefined();
    expect(
      parse('开始时间：2026-01-01 12:00 截止时间：2027-02-01 15:30').deadline,
    ).toBe(Date.parse('2027-02-01T15:30:00+08:00'));
    expect(parse('结束日期：2027年2月1日').deadline).toBe(
      Date.parse('2027-02-01T23:59:59+08:00'),
    );
    expect(parse('剩余 2 天 3 小时 10 分钟').deadlineEstimated).toBe(true);
  });
  it('普通作业与平台任务点分别计数，已提交作业只显示状态', () => {
    const doc = inertDocument(
      '<div>已完成 1/2</div><li onclick="goTask(this)" data="https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?courseId=100&amp;classId=200&amp;workId=901"><p>示例作业</p><p class="status">已完成</p></li>',
    );
    const parsed = parseScanDocument(
      doc,
      'https://mooc1.chaoxing.com/mooc2/work/list?courseId=100',
      'cx:123456',
      course,
    );
    expect(parsed.homeworkCounts).toEqual({ completed: 1, total: 2 });
    expect(parsed.tasks[0]!.status).toBe('submitted');
    expect(parsed.tasks[0]!.type).toBe('homework');
  });
});
