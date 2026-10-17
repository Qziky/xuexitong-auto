import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionRecord } from '../src/domain';
import { inertDocument } from '../src/scan-parser';
import { MathText } from '../src/ui/MathText';
import { QuestionCard } from '../src/ui/QuestionDetails';

function render(text: string): Document {
  return inertDocument(renderToStaticMarkup(createElement(MathText, { text })));
}

describe('题目公式显示', () => {
  it('混合中文和行内公式，保留原始 LaTeX 和数学结构', () => {
    const formula = String.raw`A=\{x\mid 2<x\le3\}`;
    const doc = render(
      `已知集合 \\(${formula}\\)，则 \\(A\\) 表示区间为（）。`,
    );
    expect(doc.querySelectorAll('.katex')).toHaveLength(2);
    expect(doc.querySelector('annotation')?.textContent).toBe(formula);
    expect(doc.body.textContent).toContain('已知集合');
    expect(doc.body.textContent).toContain('表示区间为（）。');
  });
  it('显示分式、根号、上下标及四种常用定界符', () => {
    const doc = render(
      String.raw`\(x_1^2\) $y^3$ \[\frac{1}{\sqrt{x+1}}\] $$\sum_{i=1}^{n}i$$`,
    );
    expect(doc.querySelectorAll('.katex')).toHaveLength(4);
    expect(doc.querySelectorAll('.display-math')).toHaveLength(2);
    expect(doc.querySelector('mfrac')).not.toBeNull();
    expect(doc.querySelector('msqrt')).not.toBeNull();
    expect(doc.querySelector('msubsup')).not.toBeNull();
  });
  it('普通金额、转义美元和未闭合公式保持可读', () => {
    for (const source of [
      '$5 and $10',
      String.raw`\$5 和 \$10`,
      String.raw`原文 \(x^2`,
    ]) {
      const doc = render(source);
      expect(doc.querySelector('.katex')).toBeNull();
      expect(doc.body.textContent).toBe(source);
    }
  });
  it('错误公式回退到安全的原文，后面的有效公式仍可渲染', () => {
    const source = String.raw`<img src=x onerror=alert(1)> \(\unknown{<script>bad</script>}\) 后续 \(x^2\)`;
    const doc = render(source);
    expect(doc.querySelectorAll('img,script')).toHaveLength(0);
    expect(doc.querySelectorAll('.katex')).toHaveLength(1);
    expect(doc.body.textContent).toContain(
      String.raw`\(\unknown{<script>bad</script>}\)`,
    );
  });
  it('公式不能创建外部链接、图片或自定义 HTML 属性', () => {
    const doc = render(
      String.raw`\(\href{javascript:alert(1)}{x}\) \(\includegraphics{https://example.com/track.png}\) \(\htmlClass{unsafe}{x}\)`,
    );
    expect(doc.querySelectorAll('a,img,script,.unsafe')).toHaveLength(0);
  });
  it('题干、选项、本人答案、模型参考、平台答案、解析和识别记录都显示公式', () => {
    const q: QuestionRecord = {
      id: 'q',
      number: 1,
      type: 'single',
      required: true,
      issues: [],
      blanks: [],
      stem: String.raw`计算 \(\sqrt{4}\)。`,
      options: [{ id: 'o1', key: 'D', label: 'A', text: String.raw`\(2^1\)` }],
      existing: ['o1'],
      publishedAnswer: {
        questionId: 'q',
        optionIds: ['o1'],
        explanation: '',
        needsReview: false,
        source: 'platform',
      },
      recognition: {
        stem: {
          source: 'vision',
          attempts: [
            { engine: 'vision', success: true, text: String.raw`\(\sqrt{4}\)` },
          ],
        },
        options: { o1: { source: 'vision', attempts: [] } },
      },
    };
    const before = JSON.stringify(q);
    const doc = inertDocument(
      renderToStaticMarkup(
        createElement(QuestionCard, {
          question: q,
          busy: false,
          onAction: vi.fn(),
          onConfirm: vi.fn(),
          reference: {
            questionId: 'q',
            optionIds: ['o1'],
            explanation: String.raw`由 \(2^2=4\) 可得。`,
            needsReview: false,
          },
        }),
      ),
    );
    expect(doc.querySelectorAll('.question-stem .katex')).toHaveLength(1);
    expect(doc.querySelectorAll('.question-options .katex')).toHaveLength(1);
    expect(doc.querySelectorAll('.answer-comparison .katex')).toHaveLength(3);
    expect(
      doc.querySelectorAll('.question-card details p .katex'),
    ).toHaveLength(1);
    expect(
      doc.querySelectorAll('.recognition-details pre .katex'),
    ).toHaveLength(1);
    expect(JSON.stringify(q)).toBe(before);
  });
});
