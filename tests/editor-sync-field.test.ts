import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
import { extractPage } from '../src/page-parser';
import { inertDocument } from '../src/scan-parser';
import { fillPage, liveSnapshot } from '../src/page-actions';
import { normalizeProposal, readbackMatches } from '../src/answers';
import { serverDraftMatches } from '../src/draft-verification';
const mock = vi.hoisted(() => ({ state: undefined as any }));
vi.mock('../src/background/store', () => mock);
import { editorBridge } from '../src/background/editor';

const url = 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=100&classId=200&workId=901';

/** 复现平台结构：单正文使用 answer…，分项正文使用多个 answerEditor…。 */
function question(id: string, multiple = false): string {
  if (multiple)
    return `<div class="questionLi" id="question${id}" typename="计算题"><h3 class="mark_name">合成计算题，分别给出转换和加法结果。</h3>${[1, 2].map(index => `<div class="textDIV">第${index}空<div class="edui-editor"><div class="edui-editor-iframeholder"><iframe></iframe></div></div><textarea id="answerEditor${id}${index}" style="display:none"></textarea></div>`).join('')}</div>`;
  return `<div class="questionLi" id="question${id}" typename="简答题">
    <h3 class="mark_name">合成题，请解释运算结果。</h3>
    <div class="eidtDiv"><div class="edui-editor"><div class="edui-editor-iframeholder"><iframe></iframe></div></div>
    <textarea id="answer${id}" name="answer${id}" style="display:none"></textarea></div>
    <script>var editor1 = UE.getEditor("answer${id}", {'pasteplain':true});</script></div>`;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (window as any).UE; });

describe('简答题 UEditor 隐藏同步字段', () => {
  it.each([false, true])('通过实际 editorBridge 保留及填写多行正文并按框回读（多框题=%s）', async (multiple) => {
    document.body.innerHTML = '<input name="uid" value="1"><div class="workTitle">示例 未交</div>' + question('101', multiple) + question('102');
    (window as any).happyDOM.setURL(url);
    const before = extractPage(document, url)!;
    expect(before.questions.map((q) => q.blanks[0]!.kind)).toEqual(['ueditor', 'ueditor']);
    expect(before.questions.map((q) => q.blanks.length)).toEqual([multiple ? 2 : 1, 1]);
    expect(before.questions.every((q) => !q.issues.length)).toBe(true);
    const instances: Record<string, any> = {};
    const editorIds = multiple ? ['answerEditor1011', 'answerEditor1012', 'answer102'] : ['answer101', 'answer102'];
    for (const editorId of editorIds) {
      const field = document.getElementById(editorId) as HTMLTextAreaElement;
      const body = field.parentElement!.querySelector('iframe')!.contentDocument!.body;
      // 模拟上一版留下的隐藏值；真实正文为空时必须以正文为准。
      field.value = '旧的隐藏值';
      if (editorId === editorIds[0])
        body.innerHTML = '<p>已有第一行 &lt; 200</p><p>已有第二行</p>';
      instances[field.id] = {
        ready: (callback: () => void) => callback(),
        setContent: vi.fn((html: string) => { body.innerHTML = html; }),
        getContent: () => body.innerHTML,
        // 复现 UEditor 非 IE 的真实行为：textContent 会丢掉 br 和段落间换行。
        getContentTxt: () => body.textContent ?? '',
        fireEvent: vi.fn(),
        sync: vi.fn(() => { field.value = body.innerHTML; }),
      };
    }
    (window as any).UE = { getEditor: vi.fn((id: string) => instances[id]) };
    mock.state = initialState();
    mock.state.queue.phase = 'running';
    mock.state.queue.index = 0;
    mock.state.queue.items = [{ tabId: 1, stage: 'filling', snapshot: before }];
    vi.stubGlobal('chrome', {
      scripting: { executeScript: vi.fn(async (request: any) => [{ result: await request.func(...request.args) }]) },
      runtime: { sendMessage: vi.fn(async (request: any) => ({ ok: true,
        value: await editorBridge(1, 0, request.binding, request.action,
          request.values ?? request.ids.map((id: string) => ({ id }))),
      })) },
    });
    const live = (await liveSnapshot())!;
    const preserved = '已有第一行 < 200\n已有第二行';
    expect(live.questions.map((q) => q.existing)).toEqual([multiple ? [preserved, ''] : [preserved], ['']]);
    const proposals = live.questions.map((q) => normalizeProposal(q, {
      questionId: q.id,
      blanks: q.blanks.map((b) => `合成结果 ${b.id} < 200\n第二行\n\n第四行`),
      explanation: '', needsReview: false,
    }, 'preserve'));
    const after = await fillPage({ taskKey: before.taskKey, fingerprint: before.fingerprint }, proposals);
    for (const editorId of editorIds) {
      const field = document.getElementById(editorId) as HTMLTextAreaElement;
      const body = field.parentElement!.querySelector('iframe')!.contentDocument!.body;
      const expected = editorId === editorIds[0]
        ? preserved : `合成结果 ${editorId} < 200\n第二行\n\n第四行`;
      expect(body.textContent).toBe(expected.replace(/\n/g, ''));
      if (editorId === editorIds[0]) {
        expect(instances[field.id].setContent).not.toHaveBeenCalled();
        expect(field.value).toBe('旧的隐藏值');
      } else {
        expect(field.value).toContain('&lt;');
        expect(instances[field.id].sync).toHaveBeenCalledOnce();
        expect(field.value).toContain('<br>');
      }
    }
    expect(after.questions.map((q) => q.existing)).toEqual(proposals.map((a) => a.blanks));
    expect(readbackMatches(after.questions, proposals)).toBe(true);
    const serverDocument = inertDocument(document.body.innerHTML);
    for (const editorId of editorIds)
      serverDocument.getElementById(editorId)!.textContent = instances[editorId].getContent();
    const server = extractPage(serverDocument, url)!;
    expect(serverDraftMatches(after, server)).toBe(true);
  });

  it('离线服务端草稿按初始化声明识别编辑器，并解码 HTML 内容', () => {
    const html = question('101').replace(/<div class="edui-editor">.*?<\/iframe><\/div><\/div>/, '')
      .replace('style="display:none"></textarea>', '>&lt;p&gt;服务端 &amp;amp; 正文&lt;/p&gt;</textarea>');
    const q = extractPage(inertDocument(html), url)!.questions[0]!;
    expect(q.blanks).toEqual([{ id: 'answer101', kind: 'ueditor', value: '服务端 & 正文' }]);
  });

  it('未确认的隐藏字段拒绝直接写入，可见原生 textarea 仍保持原生类型', async () => {
    document.body.innerHTML = '<div class="workTitle">示例 未交</div><div class="questionLi" id="question101" typename="简答题"><h3 class="mark_name">合成题</h3><textarea id="answer101" hidden></textarea></div>';
    (window as any).happyDOM.setURL(url);
    const before = extractPage(document, url)!;
    expect(before.questions[0]!.blanks[0]!.kind).toBe('textarea');
    await expect(fillPage({ taskKey: before.taskKey, fingerprint: before.fingerprint }, [{ questionId: '101', blanks: ['结果'], explanation: '', needsReview: false }])).rejects.toThrow('隐藏同步字段');
    const field = document.getElementById('answer101') as HTMLTextAreaElement;
    expect(field.value).toBe('');
    field.hidden = false;
    expect(extractPage(document, url)!.questions[0]!.blanks[0]!.kind).toBe('textarea');
  });
});
