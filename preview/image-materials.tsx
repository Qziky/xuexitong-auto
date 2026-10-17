import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_PROVIDER,
  DEFAULT_RECOGNITION,
  type PageSnapshot,
  type AnswerProposal,
} from '../src/domain';
import { restoreSnapshot } from '../src/ocr';
import { solveBatch } from '../src/provider';
import { QuestionCard } from '../src/ui/QuestionDetails';
import '../src/ui/style.css';

function picture(index: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = 260;
  canvas.height = 140;
  const context = canvas.getContext('2d')!;
  context.fillStyle = 'white';
  context.fillRect(0, 0, 260, 140);
  context.strokeStyle = '#8190a8';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(20, 15);
  context.lineTo(20, 120);
  context.lineTo(245, 120);
  context.stroke();
  context.strokeStyle = ['#4467d1', '#d58244', '#44a18c'][index]!;
  context.lineWidth = 3;
  context.beginPath();
  for (let x = 20; x < 245; x++) {
    const y = index === 1 ? 22 + (x - 20) / 2.4 : 118 - (x - 20) / 2.4;
    if (x === 20) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
  const result = canvas.toDataURL('image/png');
  canvas.width = canvas.height = 0;
  return result;
}
async function prepare(): Promise<PageSnapshot> {
  const page: PageSnapshot = {
    accountId: 'synthetic-account',
    taskKey: 'synthetic-task',
    fingerprint: 'image-qa-v1',
    adapter: 'modern',
    title: '原图材料验收',
    status: 'pending',
    url: 'https://mooc1.chaoxing.com/work/dowork',
    questions: [
      {
        id: '1',
        number: 1,
        type: 'single',
        required: true,
        issues: ['题目文字识别需检查（图片待识别）'],
        existing: [],
        blanks: [],
        stem: '对照〔图片1〕与〔图片2〕，选择与递增趋势一致的图像。',
        options: [
          { id: 'q1:o1', key: 'D', label: 'A', text: '〔图片3〕' },
          { id: 'q1:o2', key: 'A', label: 'B', text: '其他图像' },
        ],
        images: [0, 1, 2].map((index) => ({
          id: 'q1:image' + (index + 1),
          placeholder: '〔图片' + (index + 1) + '〕',
          part: index < 2 ? 'stem' : 'option',
          ...(index === 2 ? { optionId: 'q1:o1' } : {}),
          resourceKey: 'synthetic-' + index,
          src: picture(index),
        })),
      },
    ],
  };
  return restoreSnapshot(page, '/ocr', undefined, undefined, {
    ...DEFAULT_RECOGNITION,
    imageStrategy: 'vision-only',
  });
}
function ImageQA() {
  const [page, setPage] = useState<PageSnapshot>();
  const [reference, setReference] = useState<AnswerProposal>();
  const [status, setStatus] = useState('正在准备合成图像');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void prepare()
      .then((result) => {
        setPage(result);
        setStatus('3 张原图已保存，等待验证作答');
      })
      .catch((error) => setStatus(error.message));
  }, []);
  async function solve() {
    setBusy(true);
    try {
      const service = new URL(
        new URLSearchParams(location.search).get('service') ??
          'http://127.0.0.1:1',
      );
      if (service.protocol !== 'http:' || service.hostname !== '127.0.0.1')
        throw new Error('此验收页仅连接本机测试服务');
      const result = await solveBatch(
        {
          ...DEFAULT_PROVIDER,
          baseUrl: service.origin,
          model: 'local-fixture',
          apiKey: 'local-fixture',
        },
        page!.questions,
        'overwrite',
      );
      setReference(result[0]);
      setStatus(result[0]!.explanation);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '测试失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main style={{ maxWidth: 380, margin: 'auto', padding: 16 }}>
      <h1>原图材料作答验收</h1>
      <p>使用合成图像与本机模型测试服务。</p>
      <p id="image-qa-status" role="status">
        {status}
      </p>
      {page && (
        <QuestionCard
          question={page.questions[0]!}
          reference={reference}
          busy={busy}
          onAction={(action) => {
            if (action === 'solve-question') void solve();
          }}
          onConfirm={() => {}}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<ImageQA />);
