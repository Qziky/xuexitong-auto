import {
  readdir,
  mkdir,
  copyFile,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const ocr = resolve(root, 'public/ocr');
await mkdir(resolve(root, 'public/licenses'), { recursive: true });
await copyFile(
  resolve(root, 'node_modules/katex/LICENSE'),
  resolve(root, 'public/licenses/KaTeX.txt'),
);
await copyFile(
  resolve(root, 'LICENSE'),
  resolve(root, 'public/licenses/GPL-3.0.txt'),
);
await copyFile(
  resolve(root, 'THIRD_PARTY_NOTICES.md'),
  resolve(root, 'public/licenses/THIRD_PARTY_NOTICES.md'),
);
await mkdir(resolve(ocr, 'core'), { recursive: true });
await mkdir(resolve(ocr, 'lang'), { recursive: true });
const copied = [];
async function copy(from, to) {
  await copyFile(resolve(root, from), resolve(ocr, to));
  copied.push(to);
}
await copy('node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js');
for (const name of await readdir(
  resolve(root, 'node_modules/tesseract.js-core'),
)) {
  if (/^tesseract-core.*\.(?:wasm|js)$/.test(name))
    await copy(`node_modules/tesseract.js-core/${name}`, `core/${name}`);
}
for (const lang of ['chi_sim', 'eng'])
  await copy(
    `node_modules/@tesseract.js-data/${lang}/${lang === 'chi_sim' ? '4.0.0' : '4.0.0_best_int'}/${lang}.traineddata.gz`,
    `lang/${lang}.traineddata.gz`,
  );
await copy('node_modules/tesseract.js/LICENSE.md', 'LICENSE-tesseract.md');
await copy('node_modules/tesseract.js-core/LICENSE', 'LICENSE-core.txt');
const manifest = await Promise.all(
  copied.map(async (path) => ({
    path,
    sha256: createHash('sha256')
      .update(await readFile(resolve(ocr, path)))
      .digest('hex'),
  })),
);
await writeFile(
  resolve(ocr, 'assets.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);

function crc32(b) {
  let c = 0xffffffff;
  for (const v of b) {
    c ^= v;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, crc]);
}
await mkdir(resolve(root, 'public/icon'), { recursive: true });
for (const size of [16, 48, 128]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + x * 4 + 1;
      const book =
        x > size * 0.22 &&
        x < size * 0.77 &&
        y > size * 0.23 &&
        y < size * 0.73;
      const spine = Math.abs(x - size * 0.5) < size * 0.025;
      const color = book && !spine ? [245, 247, 252] : [38, 91, 220];
      raw.set([...color, 255], i);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(
    resolve(root, `public/icon/${size}.png`),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
console.log(`已准备 ${copied.length} 个本地 OCR 资源和扩展图标`);
