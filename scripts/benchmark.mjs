import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';
import { Window } from 'happy-dom';

const root = resolve(import.meta.dirname, '..');
const privateDir = resolve(root, 'artifacts/private/benchmark-open-source');
if (
  relative(root, privateDir).replaceAll('\\', '/') !==
  'artifacts/private/benchmark-open-source'
)
  throw new Error('Invalid generated benchmark directory');
await mkdir(privateDir, { recursive: true });

const window = new Window();
for (const key of [
  'document',
  'navigator',
  'HTMLCanvasElement',
  'HTMLElement',
  'DOMParser',
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: window[key],
  });
Object.defineProperty(window.navigator, 'hardwareConcurrency', {
  configurable: true,
  value: 8,
});
Object.defineProperty(window.document, 'fonts', {
  value: { add() {}, delete() {}, check: () => true, ready: Promise.resolve() },
});
globalThis.FontFace = class {
  async load() {
    return this;
  }
};
const contexts = new WeakMap();
window.HTMLCanvasElement.prototype.getContext = function () {
  if (!contexts.has(this))
    contexts.set(this, {
      font: '',
      lines: [],
      measureText: (text) => ({ width: text.length * 20 }),
      fillRect() {
        this.lines = [];
      },
      fillText(text) {
        this.lines.push(text);
      },
      drawImage() {},
      getImageData() {
        return {
          data: new Uint8ClampedArray([
            this.font.includes('"Arial"') ? 0 : 20,
            0,
            0,
            255,
          ]),
        };
      },
    });
  return contexts.get(this);
};
window.HTMLCanvasElement.prototype.toDataURL = function () {
  return (
    'data:image/png;base64,' +
    Buffer.from(this.getContext('2d').lines.join('')).toString('base64')
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function metrics() {
  return {
    started: performance.now(),
    firstMs: undefined,
    totalMs: 0,
    workersCreated: 0,
    peakOcr: 0,
    peakVision: 0,
    ocrCalls: 0,
    visionCalls: 0,
    activeOcr: 0,
    activeVision: 0,
    overlap: false,
    confirmed: 0,
    review: 0,
  };
}
let measure = metrics();
let visionWaiters = [],
  visionRunning = 0;
globalThis.benchmarkHarness = {
  async worker() {
    measure.workersCreated++;
    await sleep(50);
    return {
      async setParameters() {},
      async recognize(canvas) {
        const text = canvas.getContext('2d').lines.join('');
        measure.ocrCalls++;
        measure.activeOcr++;
        measure.peakOcr = Math.max(measure.peakOcr, measure.activeOcr);
        if (measure.activeVision) measure.overlap = true;
        await sleep(12);
        measure.activeOcr--;
        const sum = [...text].reduce((n, c) => n + c.codePointAt(0), 0);
        return { data: { text, confidence: sum % 4 === 0 ? 79 : 99 } };
      },
      async terminate() {},
    };
  },
  async vision(segments) {
    const results = new Map();
    await Promise.all(
      segments.map(async (segment) => {
        if (visionRunning >= 5) await new Promise((r) => visionWaiters.push(r));
        visionRunning++;
        measure.visionCalls++;
        measure.activeVision++;
        measure.peakVision = Math.max(measure.peakVision, measure.activeVision);
        if (measure.activeOcr) measure.overlap = true;
        const image = segment.render ? await segment.render() : segment.image;
        const text = Buffer.from(image.split(',')[1], 'base64').toString(
          'utf8',
        );
        await sleep(50);
        measure.activeVision--;
        visionRunning--;
        visionWaiters.shift()?.();
        results.set(segment.id, { engine: 'vision', success: true, text });
      }),
    );
    return results;
  },
};
function benchmarkPlugin() {
  return {
    name: 'controlled-recognition-engines',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'tesseract.js') return '\0benchmark-ocr';
      if (/[/]vision(?:\.ts)?$/.test(id)) return '\0benchmark-vision';
    },
    load(id) {
      if (id === '\0benchmark-ocr')
        return "export const createWorker=(...args)=>globalThis.benchmarkHarness.worker(...args);export const PSM={SINGLE_LINE:'7',SINGLE_BLOCK:'6'};";
      if (id === '\0benchmark-vision')
        return 'export const transcribeSegments=(_config,segments)=>globalThis.benchmarkHarness.vision(segments);export const resetVisionCapability=()=>{};';
    },
  };
}
async function server() {
  return createServer({
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [benchmarkPlugin()],
    server: { middlewareMode: true },
    ssr: { noExternal: ['tesseract.js'] },
  });
}
function syntheticQuestion(index, kind, optionCount) {
  const id = String(900100 + index);
  const labels = Array.from({ length: optionCount }, (_, n) =>
    String.fromCharCode(65 + n),
  );
  const type = { single: '单选', blank: '填空', boolean: '判断' }[kind];
  const code = { single: '0', blank: '2', boolean: '3' }[kind];
  const options = labels
    .map(
      (label) => `<li class="font-cxsecret before-after" onclick="addChoice(this)" qid="${id}" qtype="${code}" role="radio"><span class="num_option" data="${label}">${label}</span><a class="after"><p>合成选项 ${label}</p></a></li>`,
    )
    .join('');
  const blanks =
    kind === 'blank'
      ? Array.from(
          { length: 2 },
          (_, n) => `<input type="text" id="answer${id}_${n}" value="合成值-${index}-${n + 1}">`,
        ).join('')
      : '';
  return `<div class="TiMu newTiMu" id="question${id}" data="${code}"><div class="Zy_TItle"><div class="fontLabel"><span class="newZy_TItle">【${type}题】</span><p>合成示例题干 ${index + 1}：${kind === 'blank' ? '____、____。': '选择一个示例选项。'}</p></div></div><ul class="Zy_ulTop">${options}</ul>${blanks}</div>`;
}
const html = [
  ...Array.from({ length: 10 }, (_, index) =>
    syntheticQuestion(index, 'single', 4),
  ),
  ...Array.from({ length: 12 }, (_, index) =>
    syntheticQuestion(index + 10, 'blank', 0),
  ),
  ...Array.from({ length: 8 }, (_, index) =>
    syntheticQuestion(index + 22, 'boolean', 2),
  ),
].join('');
const parserServer = await server();
const { extractPage } = await parserServer.ssrLoadModule('/src/page-parser.ts');
const { inertDocument } = await parserServer.ssrLoadModule(
  '/src/scan-parser.ts',
);
const parseTimes = [];
let page;
for (let n = 0; n < 10; n++) {
  const start = performance.now();
  page = extractPage(
    inertDocument(html),
    'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900',
  );
  parseTimes.push(performance.now() - start);
}
await parserServer.close();
page.fontCss =
  "@font-face{font-family:font-cxsecret;src:url('data:application/font-ttf;base64,AAAA')}";
page.questions.forEach((q) => {
  q.obfuscated = true;
  q.options.forEach((o) => {
    o.obfuscated = true;
  });
});
const fragments = page.questions.reduce((n, q) => n + 1 + q.options.length, 0);
const settings = {
  strategy: 'ocr-first',
  validateOcr: true,
  imageStrategy: 'vision-first',
  visionService: 'shared',
  visionConcurrency: 5,
};
const provider = {
  baseUrl: 'https://benchmark.invalid/v1',
  model: 'controlled',
  apiKey: 'benchmark-placeholder',
  auth: 'bearer',
  extraBody: {},
  timeoutSec: 180,
};
const results = [];
const version = 'current';
for (let iteration = 0; iteration < 3; iteration++) {
  const runtime = await server();
  const engine = await runtime.ssrLoadModule('/src/ocr.ts');
  const input = structuredClone(page);
  input.accountId = 'synthetic:' + iteration;
  async function run(kind) {
      measure = metrics();
      visionRunning = 0;
      visionWaiters = [];
      const output = await engine.restoreSnapshot(
        input,
        '/ocr',
        undefined,
        (_text, d) => {
          if (
            ['segment-confirmed', 'recognition-cache'].includes(d?.code) &&
            measure.firstMs === undefined
          )
            measure.firstMs = performance.now() - measure.started;
        },
        settings,
        provider,
      );
      measure.totalMs = performance.now() - measure.started;
      measure.confirmed = output.questions
        .flatMap((q) => [
          q.recognition?.stem,
          ...Object.values(q.recognition?.options ?? {}),
        ])
        .filter((t) => t?.source).length;
      measure.review = output.questions.filter((q) => q.issues.length).length;
      delete measure.started;
      delete measure.activeOcr;
      delete measure.activeVision;
      return { version, iteration: iteration + 1, kind, ...measure };
  }
  results.push(await run('cold'));
  results.push(await run('hot-cache'));
  await runtime.close();
  }
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = results.reduce((acc, result) => {
  const key = result.version + ':' + result.kind;
  const values = results.filter((r) => r.version + ':' + r.kind === key);
  acc[key] = {
    firstConfirmedMs: values.some((v) => v.firstMs !== undefined)
      ? Math.round(median(values.map((v) => v.firstMs ?? v.totalMs)))
      : null,
    totalMs: Math.round(median(values.map((v) => v.totalMs))),
    peakOcr: Math.max(...values.map((v) => v.peakOcr)),
    peakVision: Math.max(...values.map((v) => v.peakVision)),
    ocrCalls: median(values.map((v) => v.ocrCalls)),
    visionCalls: median(values.map((v) => v.visionCalls)),
    confirmed: median(values.map((v) => v.confirmed)),
    reviewQuestions: median(values.map((v) => v.review)),
    overlap: values.some((v) => v.overlap),
  };
  return acc;
}, {});
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  method:
    'Current source with a generated synthetic page and controlled OCR/vision delays. No real platform page, Tesseract WASM, network, or model calls. Memory of native OCR workers is not measured.',
  controls: {
    initializationMs: 50,
    perOcrPassMs: 12,
    visionMs: 50,
    visionConcurrency: 5,
    failureRule: 'text codepoint sum modulo 4 equals 0 => OCR confidence 79',
  },
  questions: page.questions.length,
  fragments,
  parseMedianMs: +median(parseTimes).toFixed(2),
  summary,
  results,
};
await writeFile(
  resolve(privateDir, 'performance-controlled.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      questions: report.questions,
      fragments,
      parseMedianMs: report.parseMedianMs,
      summary,
    },
    null,
    2,
  ),
);
