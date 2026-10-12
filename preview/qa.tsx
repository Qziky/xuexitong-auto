import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { fontSource, recognizeText, renderText } from '../src/ocr';
import { extractPage } from '../src/page-parser';
import { inertDocument } from '../src/scan-parser';
import '../src/ui/style.css';
function QA() {
  const [css, setCss] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('尚未开始');
  const [html, setHtml] = useState('');
  const [parsed, setParsed] = useState('');
  const [working, setWorking] = useState(false);
  async function ocr() {
    setWorking(true);
    setStatus('加载字体与本地 OCR…');
    try {
      const face = new FontFace(
        'qa-font',
        `url("${fontSource(css, 'https://mooc1.chaoxing.com/')}")`,
      );
      await face.load();
      document.fonts.add(face);
      document
        .getElementById('glyph-preview')
        ?.replaceChildren(renderText(text, 'qa-font', 54));
      const result = await recognizeText(
        text,
        'qa-font',
        `${location.origin}/ocr`,
        setStatus,
      );
      setStatus(JSON.stringify(result));
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <main style={{ maxWidth: 720, margin: 'auto', paddingBottom: 40 }}>
      <h1>本地识别验收</h1>
      <p>此页仅用于开发验收，不连接学习通账号或模型服务。</p>
      <section className="settings-card">
        <h2>真实混淆字体 OCR</h2>
        <label>
          页面字体 CSS
          <textarea
            aria-label="页面字体 CSS"
            rows={3}
            value={css}
            onChange={(e) => setCss(e.target.value)}
          />
        </label>
        <label>
          原始混淆文字
          <textarea
            aria-label="原始混淆文字"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={working}
          onClick={() => void ocr()}
        >
          本地还原
        </button>
        <div id="glyph-preview" style={{ overflow: 'auto', marginTop: 10 }} />
        <p id="ocr-status" role="status" style={{ overflowWrap: 'anywhere' }}>
          {status}
        </p>
      </section>
      <section className="settings-card">
        <h2>脱敏题目 DOM 解析</h2>
        <label>
          题目 HTML
          <textarea
            aria-label="题目 HTML"
            rows={5}
            value={html}
            onChange={(e) => setHtml(e.target.value)}
          />
        </label>
        <button
          className="primary"
          onClick={() =>
            setParsed(
              JSON.stringify(
                extractPage(
                  inertDocument(html),
                  'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900',
                ),
                null,
                2,
              ),
            )
          }
        >
          解析样本
        </button>
        <pre id="parse-result" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
          {parsed}
        </pre>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<QA />);
