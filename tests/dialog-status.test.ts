import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmVisible } from '../src/page-actions';
import { readPageStatus } from '../src/page-parser';
import { inertDocument } from '../src/scan-parser';
afterEach(() => vi.restoreAllMocks());
describe('提交弹窗与真实状态', () => {
  it('旧式章节测验 confirmSubWin 仅在实际可见且为提交确认时操作', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{width:322,height:139}] as unknown as DOMRectList);
    document.body.innerHTML = '<div id="workpop" style="display:none">旧弹窗</div><div id="confirmSubWin" role="alertdialog" style="display:none"><p>确认提交？</p><a onclick="submitCheckTimes()">确定</a></div>';
    const click = vi.fn();
    document.querySelector('#confirmSubWin a')!.addEventListener('click',click);
    expect(confirmVisible('100:200:work:900').confirmed).toBe(false);
    (document.getElementById('confirmSubWin') as HTMLElement).style.display='block';
    expect(confirmVisible('100:200:work:900').confirmed).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });
  it('确认框尚未出现或隐藏时不确认，可见提交确认框才点击', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      { width: 200, height: 100 },
    ] as unknown as DOMRectList);
    document.body.innerHTML =
      '<div id="workpop" style="display:none">确定提交本次作业？<a id="popok">确定</a></div>';
    const click = vi.fn();
    document.querySelector('#popok')!.addEventListener('click', click);
    expect(confirmVisible('100:200:work:900').confirmed).toBe(false);
    expect(click).not.toHaveBeenCalled();
    (document.querySelector('#workpop') as HTMLElement).style.display = 'block';
    expect(confirmVisible('100:200:work:900').confirmed).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });
  it('可见无关确认框不被接受', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      { width: 200, height: 100 },
    ] as unknown as DOMRectList);
    document.body.innerHTML =
      '<div id="workpop">确定退出课程？<a id="popok">确定</a></div>';
    expect(confirmVisible('100:200:work:900').confirmed).toBe(false);
  });
  it('脚本中的“已提交”和题目内容都不能作为成功证据', () => {
    const doc = inertDocument(
      '<script>const messages={success:"已提交"};</script><div class="questionLi">已完成是哪个状态？</div><a onclick="submitValidate()">提交</a>',
    );
    expect(
      readPageStatus(
        doc,
        'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=900',
      ).status,
    ).toBe('pending');
  });
  it('平台查看页和明确状态文字可确认提交并读取成绩', () => {
    expect(
      readPageStatus(
        inertDocument('<div>已批阅 成绩：100</div>'),
        'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/view?workId=900',
      ),
    ).toMatchObject({ status: 'submitted', grade: '100' });
  });
});
