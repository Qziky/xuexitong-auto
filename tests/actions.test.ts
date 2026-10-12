import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPage } from '../src/page-parser';
import { fillPage, assertBinding } from '../src/page-actions';
const url =
  'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=100&classId=200&workId=901';
function setup() {
  document.documentElement.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/modern.html'),
    'utf8',
  );
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(url);
  const clicks: Record<string, number> = {};
  for (const node of document.querySelectorAll<HTMLElement>('[qid]'))
    node.addEventListener('click', () => {
      const id = node.getAttribute('qid')!;
      const key = node.querySelector('.num_option')!.getAttribute('data')!;
      const input = document.getElementById(`answer${id}`) as HTMLInputElement;
      clicks[`${id}:${key}`] = (clicks[`${id}:${key}`] ?? 0) + 1;
      if (node.getAttribute('qtype') === '1') {
        const values = new Set(input.value.split(''));
        values.has(key) ? values.delete(key) : values.add(key);
        input.value = [...values].sort().join('');
        node.setAttribute('aria-checked', String(values.has(key)));
      } else {
        input.value = input.value === key ? '' : key;
        node
          .parentElement!.querySelectorAll('[qid]')
          .forEach((n) =>
            n.setAttribute(
              'aria-checked',
              String(
                n.querySelector('.num_option')!.getAttribute('data') ===
                  input.value,
              ),
            ),
          );
      }
    });
  const page = extractPage(document, url)!;
  return {
    page,
    clicks,
    binding: { taskKey: page.taskKey, fingerprint: page.fingerprint },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('实际填写适配器', () => {
  it('已确认的图片题可填写；回读图片改变后拒绝旧绑定', async () => {
    const { clicks } = setup();
    const image = document.createElement('img');
    image.src = 'https://p.ananas.chaoxing.com/formula.png';
    document.querySelector('.mark_name')!.append(image);
    const page = extractPage(document, url)!;
    const binding = {
      taskKey: page.taskKey,
      fingerprint: page.fingerprint,
      operationId: 'image-run',
    };
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: true, value: undefined })),
      },
    });
    const answer = {
      questionId: '900011',
      optionIds: ['q900011:o1'],
      explanation: '',
      needsReview: false,
    };
    const result = await fillPage(binding, [answer]);
    expect(result.questions[0]!.existing).toEqual(['q900011:o1']);
    expect(clicks['900011:A']).toBe(1);
    image.src = 'https://p.ananas.chaoxing.com/another-formula.png';
    await expect(fillPage(binding, [answer])).rejects.toThrow('页面已变化');
    expect(clicks['900011:A']).toBe(1);
  });
  it('只读预览即使有相同题目也禁止写入', () => {
    const { page, binding } = setup();
    expect(() =>
      assertBinding({ ...page, pageMode: 'preview' }, binding),
    ).toThrow('仅供预览');
  });
  it('快照读取后操作已取消时，拒绝迟到的原生选项写入', async () => {
    const { binding, clicks } = setup();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async () => ({
          ok: false,
          error: '写入操作已取消',
        })),
      },
    });
    await expect(
      fillPage({ ...binding, operationId: 'cancelled-run' }, [
        {
          questionId: '900011',
          optionIds: ['q900011:o1'],
          explanation: '',
          needsReview: false,
        },
      ]),
    ).rejects.toThrow('已取消');
    expect(Object.keys(clicks)).toHaveLength(0);
  });
  it('选中答案相同时不会再次点击取消，覆盖时切换到目标真实键', async () => {
    const { binding, clicks } = setup();
    await fillPage(binding, [
      {
        questionId: '900011',
        optionIds: ['q900011:o2'],
        explanation: '',
        needsReview: false,
      },
    ]);
    expect(Object.keys(clicks)).toHaveLength(0);
    const after = await fillPage(binding, [
      {
        questionId: '900011',
        optionIds: ['q900011:o1'],
        explanation: '',
        needsReview: false,
      },
    ]);
    expect(clicks['900011:A']).toBe(1);
    expect(after.questions[0]!.existing).toEqual(['q900011:o1']);
  });
  it('多选只操作差异，避免重复取消已有正确选择', async () => {
    const { binding, clicks } = setup();
    const after = await fillPage(binding, [
      {
        questionId: '900012',
        optionIds: ['q900012:o1', 'q900012:o2'],
        explanation: '',
        needsReview: false,
      },
    ]);
    expect(clicks['900012:A']).toBeUndefined();
    expect(clicks['900012:B']).toBe(1);
    expect(clicks['900012:C']).toBe(1);
    expect(after.questions[1]!.existing).toEqual(['q900012:o1', 'q900012:o2']);
  });
  it('原生多空输入按真实 DOM 顺序填写并产生 input/change 事件', async () => {
    const { binding } = setup();
    const event = vi.fn();
    document
      .querySelector('#answer900013_1')!
      .addEventListener('change', event);
    const after = await fillPage(binding, [
      {
        questionId: '900013',
        blanks: ['已有第一空', '第二空'],
        explanation: '',
        needsReview: false,
      },
    ]);
    expect(after.questions[2]!.blanks.map((b) => b.value)).toEqual([
      '已有第一空',
      '第二空',
    ]);
    expect(event).toHaveBeenCalledOnce();
  });
  it('页面题目变动后禁止写入旧答案', async () => {
    const { binding } = setup();
    document.querySelector('.mark_name')!.textContent = '另一份题目';
    await expect(
      fillPage(binding, [
        {
          questionId: '900011',
          optionIds: ['q900011:o1'],
          explanation: '',
          needsReview: false,
        },
      ]),
    ).rejects.toThrow('页面已变化');
  });
});
