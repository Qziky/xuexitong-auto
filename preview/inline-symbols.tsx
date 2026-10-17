import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_RECOGNITION, type PageSnapshot } from '../src/domain';
import { restoreSnapshot } from '../src/ocr';
import { QuestionCard } from '../src/ui/QuestionDetails';
import '../src/ui/style.css';

function symbol(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 24;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 24, 24);
  context.fillStyle = '#000';
  context.font = 'italic 20px "Times New Roman"';
  context.fillText('A', 3, 21);
  return canvas.toDataURL('image/png');
}
function SymbolQA() {
  const [page, setPage] = useState<PageSnapshot>();
  const [status, setStatus] = useState('正在识别行内字符');
  useEffect(() => {
    const input: PageSnapshot = {
      adapter: 'modern',
      taskKey: 'inline-symbol-qa',
      fingerprint: 'inline-symbol-qa',
      url: 'https://mooc1.chaoxing.com/work/dowork',
      title: '行内字符识别验收',
      status: 'pending',
      questions: [
        {
          id: '1',
          number: 1,
          type: 'single',
          required: true,
          existing: [],
          blanks: [],
          stem: '已知集合〔图片1〕，则〔图片2〕表示成区间为( )。',
          issues: ['题目文字识别需检查（图片待识别）'],
          options: ['(2,3]', '[2,3]', '[2,3)', '(2,3)'].map((text, index) => ({
            id: 'o' + index,
            key: String.fromCharCode(65 + index),
            label: String.fromCharCode(65 + index),
            text,
          })),
          images: [
            {
              id: 'q1:image1',
              part: 'stem',
              placeholder: '〔图片1〕',
              resourceKey: 'set',
              latex: String.raw`A=\{x\mid2<x\le3\}`,
            },
            {
              id: 'q1:image2',
              part: 'stem',
              placeholder: '〔图片2〕',
              resourceKey: 'letter',
              src: new URLSearchParams(location.search).get('src') || symbol(),
            },
          ],
        },
      ],
    };
    const controller = new AbortController();
    void restoreSnapshot(
      input,
      '/ocr',
      controller.signal,
      (note) => setStatus(note),
      {
        ...DEFAULT_RECOGNITION,
        imageStrategy: 'ocr-only',
      },
    )
      .then((result) => {
        setPage(result);
        setStatus(
          result.questions[0]!.stem.includes('〔图片')
            ? '仍需原图材料'
            : '行内字母已还原为公式文字',
        );
      })
      .catch((error) => setStatus(error.message));
    return () => controller.abort();
  }, []);
  return (
    <main style={{ maxWidth: 420, margin: 'auto', padding: 16 }}>
      <h1>行内字符识别验收</h1>
      <p role="status">{status}</p>
      {page && (
        <>
          <QuestionCard
            question={page.questions[0]!}
            busy={false}
            onAction={() => {}}
            onConfirm={() => {}}
          />
          <details>
            <summary>识别数据</summary>
            <pre id="symbol-result">
              {JSON.stringify(page.questions[0]!.recognition?.images, null, 2)}
            </pre>
          </details>
        </>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<SymbolQA />);
