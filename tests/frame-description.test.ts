import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeFrame } from '../src/frame-description';
import { inertDocument } from '../src/scan-parser';

const URL =
  'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900';
const fixture = (name: string) =>
  inertDocument(readFileSync(`tests/fixtures/${name}.html`, 'utf8'));

describe('已加载答题 iframe 的只读描述', () => {
  it('旧章节测验报告标题、状态和题数，不发送题干或候选答案', () => {
    const info = describeFrame(fixture('legacy'), URL, false, '_uid=1');
    expect(info).toMatchObject({
      accountId: 'cx:1',
      taskKey: '100:200:work:900',
      taskKind: 'quiz',
      adapter: 'legacy',
      taskSummary: { status: 'pending', questionCount: 2 },
    });
    expect(info.taskSummary?.title).toContain('示例测验');
    expect(info.revision).toBeTruthy();
    expect(info).not.toHaveProperty('questions');
    expect(info).not.toHaveProperty('proposals');
    expect(JSON.stringify(info)).not.toContain('合成单选题正文');
  });
  it('普通作业与章节中的新题型按真实入口和 referrer 分类', () => {
    const doc = fixture('modern');
    const url =
      'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=100&classId=200&workId=901';
    expect(describeFrame(doc, url, false, '_uid=1')).toMatchObject({
      adapter: 'modern',
      taskKind: 'homework',
      taskSummary: { questionCount: 4 },
    });
    Object.defineProperty(doc, 'referrer', {
      value: 'https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=9',
    });
    expect(describeFrame(doc, url, false, '_uid=1').taskKind).toBe('quiz');
  });
  it('题目后加载会产生新的报告修订，已选答案变化也会产生新的修订', () => {
    const doc = inertDocument('<title>章节详情</title>');
    expect(describeFrame(doc, URL, false, '_uid=1').adapter).toBeUndefined();
    doc.body.innerHTML = fixture('legacy').body.innerHTML;
    const first = describeFrame(doc, URL, false, '_uid=1');
    (doc.querySelector('#answer900001') as HTMLInputElement).value = 'B';
    const changed = describeFrame(doc, URL, false, '_uid=1');
    expect(first.taskSummary?.questionCount).toBe(2);
    expect(changed.revision).not.toBe(first.revision);
  });
  it('新版章节 doHomeWorkNew 页面同时报告课程绑定和答题结构', () => {
    const url =
      'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?courseId=100&classId=200&workId=900&api=1&knowledgeid=300';
    expect(
      describeFrame(fixture('legacy'), url, false, '_uid=1'),
    ).toMatchObject({
      accountId: 'cx:1',
      adapter: 'legacy',
      taskKind: 'quiz',
      taskKey: '100:200:work:900',
      taskSummary: { questionCount: 2, status: 'pending' },
    });
  });
  it('真实 ceyan_name 页头读取测验名称和截止时间，不使用通用页面标题', () => {
    const doc = fixture('legacy');
    doc.title = '做作业';
    doc.querySelector('.workTitle')!.outerHTML =
      '<div>章节测验 待完成</div><div class="ceyan_name"><h3>1.2节章节测验</h3><p>题量: 2 满分:100.0 截止时间:2027-01-02 14:03:00</p></div>';
    const url =
      'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?courseId=100&classId=200&workId=900&api=1&knowledgeid=300';
    expect(describeFrame(doc, url, false, '_uid=1').taskSummary).toMatchObject({
      title: '1.2节章节测验',
      status: 'pending',
      questionCount: 2,
      deadline: Date.parse('2027-01-02T14:03:00+08:00'),
    });
  });
  it('验证码和登录页不报告可执行题目；课程目录也不报告测验', () => {
    const doc = fixture('legacy');
    doc.body.insertAdjacentHTML(
      'afterbegin',
      '<p>[9010] 操作异常，请输入验证码</p>',
    );
    expect(describeFrame(doc, URL, false, '_uid=1')).toMatchObject({
      verificationRequired: true,
    });
    expect(
      describeFrame(doc, URL, false, '_uid=1').taskSummary,
    ).toBeUndefined();
    const login = fixture('legacy');
    login.body.insertAdjacentHTML('afterbegin', '<input type="password">');
    expect(describeFrame(login, URL, false).taskSummary).toBeUndefined();
    const catalog = describeFrame(
      inertDocument('<div>已完成任务点:28/65</div>'),
      'https://mooc2-ans.chaoxing.com/mycourse/stu?courseid=100&clazzid=200',
      true,
      '_uid=1',
    );
    expect(catalog.adapter).toBeUndefined();
    expect(catalog.taskSummary).toBeUndefined();
  });
});
