import { memo, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

function escaped(text: string, position: number): boolean {
  let slashes = 0;
  while (position > 0 && text[--position] === '\\') slashes++;
  return slashes % 2 === 1;
}

function mathEnd(text: string, start: number, closing: string): number {
  let braces = 0;
  for (let i = start; i < text.length; i++) {
    if (braces === 0 && text.startsWith(closing, i)) return i;
    if (text[i] === '\\') i++;
    else if (text[i] === '{') braces++;
    else if (text[i] === '}') braces = Math.max(0, braces - 1);
  }
  return -1;
}

/** Render only explicitly delimited math; ordinary text remains React text. */
export const MathText = memo(function MathText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const opening = /\\\(|\\\[|\$\$|\$/g;
  let cursor = 0;
  for (let match; (match = opening.exec(text));) {
    const start = match.index;
    if (escaped(text, start)) continue;
    const left = match[0];
    const right = left === '\\(' ? '\\)' : left === '\\[' ? '\\]' : left;
    const end = mathEnd(text, start + left.length, right);
    if (end < 0) continue;
    const formula = text.slice(start + left.length, end);
    // Do not mistake currency such as "$5 and $10" for an inline formula.
    if (!formula.trim() || (left === '$' && formula !== formula.trim()))
      continue;
    if (formula.length > 12000) continue;
    const display = left === '\\[' || left === '$$';
    let html: string;
    try {
      html = katex.renderToString(formula, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxSize: 20,
        maxExpand: 1000,
        macros: {},
      });
    } catch {
      // Invalid or unsupported LaTeX stays readable and safely escaped by React.
      opening.lastIndex = end + right.length;
      continue;
    }
    parts.push(text.slice(cursor, start));
    parts.push(
      <span
        key={start}
        className={'math-expression' + (display ? ' display-math' : '')}
        dangerouslySetInnerHTML={{ __html: html }}
      />,
    );
    cursor = end + right.length;
    opening.lastIndex = cursor;
  }
  parts.push(text.slice(cursor));
  return <span className="math-text">{parts}</span>;
});
