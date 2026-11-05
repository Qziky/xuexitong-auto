import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractPage } from '../src/page-parser';
import { inertDocument } from '../src/scan-parser';
import { fillPage } from '../src/page-actions';
import { solveBatch } from '../src/provider';
import { DEFAULT_PROVIDER } from '../src/domain';
import {
  completeAnswer,
  existingProposal,
  needsSolve,
  normalizeProposal,
  readbackMatches,
} from '../src/answers';
import { serverDraftMatches } from '../src/draft-verification';
import { answerText, comparison } from '../src/question-export';
import { validateRecognitionMarkers } from '../src/recognition-settings';

const url =
  'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=100&classId=200&workId=901';
const stem = '合成计算：X=0101B，Y=1010B。X∧Y=____B，X∨Y=____B。';
const solution = 'X∧Y=0000B\nX∨Y=1111B';

/** 构造无账号隐私的新版/旧版文本题，覆盖不同平台题型标记。 */
function fixture(
  type = '计算题',
  editor = '<textarea id="answer101"></textarea>',
  legacy = false,
): string {
  return `<input name="uid" value="1"><div class="workTitle">示例 未交</div>
    <div class="${legacy ? 'TiMu' : 'questionLi'}" id="question101" ${type ? `typename="${type}"` : 'data="4"'}>
    <div class="${legacy ? 'Zy_TItle' : 'mark_name'}">${stem}</div>${editor}</div>`;
}

/** 从合成 HTML 读取真实解析器的结果。 */
function page(html = fixture(), address = url) {
  return extractPage(inertDocument(html), address)!;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('文本作答与多空计算题', () => {
  it.each(['简答题', '计算题', '论述题', '问答题', '解答题'])(
    '识别%s但不把正文里的横线当作多个输入框',
    (type) => {
      const q = page(fixture(type)).questions[0]!;
      expect(q.type).toBe('text');
      expect(q.blanks).toHaveLength(1);
      expect(q.issues).toEqual([]);
      expect(needsSolve(q, 'preserve')).toBe(true);
      expect(
        validateRecognitionMarkers(stem, stem, {
          questionType: q.type,
          part: 'stem',
          blankCount: 1,
        }).valid,
      ).toBe(true);
      expect(
        validateRecognitionMarkers(stem, stem.replace('____B', 'B'), {
          questionType: q.type,
          part: 'stem',
          blankCount: 1,
        }).valid,
      ).toBe(false);
    },
  );

  it('旧版缺少题型名称时按单编辑器识别正文，服务端保留分行结果', () => {
    const q = page(
      fixture(
        '',
        '<script type="text/plain" id="answerEditor101"><p>X∧Y=0000B</p><p>X∨Y=1111B</p></script>',
        true,
      ),
    ).questions[0]!;
    expect(q.type).toBe('text');
    expect(q.blanks).toEqual([
      { id: 'answerEditor101', kind: 'ueditor', value: solution },
    ]);
    expect(needsSolve(q, 'preserve')).toBe(false);
    expect(needsSolve(q, 'overwrite')).toBe(true);
  });

  it('无题型名称的多输入框只在与题干空位对应时采用填空流程', () => {
    const html = fixture(
      '',
      '<input type="text" id="answer1011"><input type="text" id="answer1012">',
    );
    const q = page(html).questions[0]!;
    expect(q.type).toBe('blank');
    expect(q.blanks.map((b) => b.id)).toEqual(['answer1011', 'answer1012']);
    expect(page(html.replace('____B', 'B')).questions[0]!.type).toBe(
      'unsupported',
    );
  });

  it('单正文从模型请求、原生填写、回读到服务端草稿核验贯通', async () => {
    document.documentElement.innerHTML = fixture();
    (
      window as unknown as { happyDOM: { setURL(url: string): void } }
    ).happyDOM.setURL(url);
    const before = extractPage(document, url)!;
    const fetch = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body);
      const input = JSON.parse(body.messages[1].content);
      expect(body.messages[0].content).toContain('type=text');
      expect(input.questions[0]).toMatchObject({
        type: 'text',
        blanks: [{ index: 1, preserve: false }],
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answers: [
                    {
                      questionId: '101',
                      blanks: [solution],
                      explanation: '合成参考',
                      needsReview: false,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const answers = await solveBatch(
      { ...DEFAULT_PROVIDER, apiKey: 'fixture-only' },
      before.questions,
      'preserve',
    );
    expect(completeAnswer(before.questions[0]!, answers[0])).toBe(true);
    const changed = vi.fn();
    document.querySelector('#answer101')!.addEventListener('change', changed);
    const after = await fillPage(
      { taskKey: before.taskKey, fingerprint: before.fingerprint },
      answers,
    );
    expect(changed).toHaveBeenCalledOnce();
    expect(readbackMatches(after.questions, answers)).toBe(true);
    expect(answerText(after.questions[0]!, answers[0])).toBe(solution);
    expect(comparison(after.questions[0]!, answers[0])).toBe('same');
    const saved = page(
      fixture('计算题', `<textarea id="answer101">${solution}</textarea>`),
    );
    expect(serverDraftMatches(after, saved)).toBe(true);
    saved.questions[0]!.blanks[0]!.value = '不同的答案';
    expect(serverDraftMatches(after, saved)).toBe(false);
    expect(readbackMatches(saved.questions, answers)).toBe(false);
  });

  it('富文本正文使用编辑器通道填写与回读，并过滤内部辅助输入框', async () => {
    document.documentElement.innerHTML = fixture(
      '计算题',
      '<div id="answerEditor101"><div class="edui-editor-toolbarbox"><input id="search101"></div><textarea id="internal101"></textarea></div>',
    );
    (
      window as unknown as { happyDOM: { setURL(url: string): void } }
    ).happyDOM.setURL(url);
    const before = extractPage(document, url)!;
    expect(before.questions[0]!.blanks).toHaveLength(1);
    let saved = '';
    const sendMessage = vi.fn(async (message: any) => {
      if (message.action === 'write') {
        expect(message.values).toEqual([
          { id: 'answerEditor101', value: solution },
        ]);
        saved = message.values[0].value;
      }
      return { ok: true, value: { answerEditor101: {
        html: saved.replace(/\n/g, '<br>'),
        text: saved.replace(/\n/g, ''),
      } } };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const proposal = {
      questionId: '101',
      blanks: [solution],
      explanation: '',
      needsReview: false,
    };
    const after = await fillPage(
      { taskKey: before.taskKey, fingerprint: before.fingerprint },
      [proposal],
    );
    expect(after.questions[0]!.existing).toEqual([solution]);
    expect(readbackMatches(after.questions, [proposal])).toBe(true);
    expect(
      serverDraftMatches(
        after,
        page(
          fixture(
            '计算题',
            '<script id="answerEditor101" type="text/plain">X∧Y=0000B<br>X∨Y=1111B</script>',
          ),
        ),
      ),
    ).toBe(true);
  });

  it('正文候选数量必须对应实际输入框，保留已有答案，空内容不可判为完成', () => {
    const q = page().questions[0]!;
    const base = { questionId: q.id, explanation: '', needsReview: false };
    expect(() =>
      normalizeProposal(
        q,
        { ...base, blanks: ['0000B', '1111B'] },
        'overwrite',
      ),
    ).toThrow('数量');
    expect(() =>
      normalizeProposal(q, { ...base, blanks: [''] }, 'overwrite'),
    ).toThrow('空答案');
    expect(completeAnswer(q, { ...base, blanks: [''] })).toBe(false);
    q.blanks[0]!.value = '已有正文';
    expect(
      normalizeProposal(q, { ...base, blanks: [solution] }, 'preserve').blanks,
    ).toEqual(['已有正文']);
    expect(existingProposal(q).blanks).toEqual(['已有正文']);
  });

  it('批阅页分别读取本人正文与平台答案，不混入分数', () => {
    const html = fixture(
      '计算题',
      '<div class="myAnswerBx">我的答案：<div class="answerCon">我的结果</div><span class="scoreNum">5</span>分</div><div class="correctAnswerBx">正确答案：<div class="answerCon">标准结果</div></div>',
    );
    const q = page(html, url.replace('/dowork?', '/view?')).questions[0]!;
    expect(q.existing).toEqual(['我的结果']);
    expect(q.publishedAnswer?.blanks).toEqual(['标准结果']);
  });

  it('两框计算题按实际数量请求模型、保留已有项、逐框填写与展示', async () => {
    const html = fixture('计算题', '<textarea id="answer1011">保留第一问</textarea><textarea id="answer1012"></textarea>');
    document.documentElement.innerHTML = html;
    (window as any).happyDOM.setURL(url);
    const before = extractPage(document, url)!;
    const q = before.questions[0]!;
    expect(q.type).toBe('text');
    expect(q.issues).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => {
      const input = JSON.parse(JSON.parse(init.body).messages[1].content);
      expect(input.questions[0].blanks).toEqual([
        { index: 1, preserve: true, existing: '保留第一问' },
        { index: 2, preserve: false, existing: '' },
      ]);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: [
        { questionId: q.id, blanks: ['新的第一问', '第二问结果'], explanation: '合成参考', needsReview: false },
      ] }) } }] }));
    }));
    const answers = await solveBatch({ ...DEFAULT_PROVIDER, apiKey: 'fixture-only' }, [q], 'preserve');
    expect(answers[0]!.blanks).toEqual(['保留第一问', '第二问结果']);
    expect(completeAnswer(q, answers[0])).toBe(true);
    expect(completeAnswer(q, { ...answers[0]!, blanks: ['只有第一问'] })).toBe(false);
    expect(() => normalizeProposal(q, { ...answers[0]!, blanks: ['只有第一问'] }, 'overwrite')).toThrow('数量');
    const after = await fillPage({ taskKey: before.taskKey, fingerprint: before.fingerprint }, answers);
    expect(after.questions[0]!.existing).toEqual(answers[0]!.blanks);
    expect(answerText(after.questions[0]!, answers[0])).toBe('第1空：保留第一问；第2空：第二问结果');
    expect(readbackMatches(after.questions, answers)).toBe(true);
    const server = page(html.replace('<textarea id="answer1012"></textarea>', '<textarea id="answer1012">第二问结果</textarea>'));
    expect(serverDraftMatches(after, server)).toBe(true);
    server.questions[0]!.blanks.reverse();
    expect(serverDraftMatches(after, server)).toBe(false);
  });

  it('多框计算题的批阅答案按平台空位分组读取', () => {
    const html = fixture('计算题', '<div class="myAnswerBx">我的答案：<span class="myAnswer">第1空：第一问</span><span class="myAnswer">第2空：第二问</span></div><div class="correctAnswerBx">正确答案：<span class="correctAnswer">第1空：参考一</span><span class="correctAnswer">第2空：参考二</span></div>');
    const q = page(html, url.replace('/dowork?', '/view?')).questions[0]!;
    expect(q.blanks).toHaveLength(2);
    expect(q.existing).toEqual(['第一问', '第二问']);
    expect(q.publishedAnswer?.blanks).toEqual(['参考一', '参考二']);
  });

  it('未确认位置、附件和有明确特殊类型的题仍停止，不盲目填写', () => {
    for (const html of [
      fixture('计算题', ''),
      fixture('附件题'),
      fixture('', '<input id="answer101" type="file">'),
    ]) {
      const q = page(html).questions[0]!;
      expect(needsSolve(q, 'overwrite')).toBe(false);
      expect(q.issues.length).toBeGreaterThan(0);
    }
  });
});
