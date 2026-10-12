import {
  mkdir,
  cp,
  readdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createZip } from '@aklinker1/zero-zip';
import { validateManifestCsp } from './manifest-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');
const unpacked = resolve(output, 'edge-unpacked');
await mkdir(output, { recursive: true });
const staleEvidence = resolve(output, 'artifacts');
if (relative(output, staleEvidence).replaceAll('\\', '/') !== 'artifacts')
  throw new Error('Invalid generated evidence path');
await rm(staleEvidence, { recursive: true, force: true });
// This directory is exclusively a generated artifact. Check the resolved absolute target before replacing it.
if (relative(root, unpacked).replaceAll('\\', '/') !== 'dist/edge-unpacked')
  throw new Error('Invalid generated output path');
await rm(unpacked, { recursive: true, force: true });
await cp(resolve(root, '.output/edge-mv3'), unpacked, { recursive: true });
const manifest = JSON.parse(
  await readFile(resolve(unpacked, 'manifest.json'), 'utf8'),
);
validateManifestCsp(manifest);
if (
  manifest.manifest_version !== 3 ||
  !manifest.permissions.includes('offscreen') ||
  !manifest.permissions.includes('sidePanel')
)
  throw new Error('Required MV3 APIs are missing');
const entryFiles = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  'offscreen.html',
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
];
for (const name of entryFiles) {
  if (!name || relative(unpacked, resolve(unpacked, name)).startsWith('..'))
    throw new Error('Invalid manifest resource path');
  if (!(await readFile(resolve(unpacked, name))).length)
    throw new Error(`Empty extension resource: ${name}`);
}
const ocrAssets = JSON.parse(
  await readFile(resolve(unpacked, 'ocr/assets.json'), 'utf8'),
);
for (const asset of ocrAssets) {
  const digest = createHash('sha256')
    .update(await readFile(resolve(unpacked, 'ocr', asset.path)))
    .digest('hex');
  if (digest !== asset.sha256)
    throw new Error(`OCR asset checksum mismatch: ${asset.path}`);
}
const version = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8'),
).version;
if (manifest.version !== version)
  throw new Error('Manifest/package version mismatch');
const extensionZip = `chaoxing-task-assistant-${version}-edge.zip`;
const sourceName = `chaoxing-task-assistant-${version}-source.zip`;
for (const item of await readdir(output, { withFileTypes: true })) {
  if (
    item.isFile() &&
    /^chaoxing-task-assistant-.+-(?:edge|source)\.zip$/.test(item.name) &&
    item.name !== extensionZip &&
    item.name !== sourceName
  )
    await rm(resolve(output, item.name), { force: true });
}
await copyFile(
  resolve(root, '.output', extensionZip),
  resolve(output, extensionZip),
);

const sourceZip = createZip({ level: 9 });
const sourceFiles = [];
async function addTree(directory) {
  for (const item of await readdir(resolve(root, directory), {
    withFileTypes: true,
  })) {
    const name = `${directory}/${item.name}`;
    if (item.isDirectory()) await addTree(name);
    else sourceFiles.push(name);
  }
}
for (const directory of [
  'src',
  'entrypoints',
  'scripts',
  'tests',
  'preview',
  'docs',
])
  await addTree(directory);
sourceFiles.push(
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'PRIVACY.md',
  'THIRD_PARTY_NOTICES.md',
  '.github/workflows/ci.yml',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'wxt.config.ts',
  'vitest.config.ts',
  'vite.preview.config.ts',
  '.gitignore',
  '.gitattributes',
  '.prettierrc.json',
);
const requiredSourceFiles = [
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'PRIVACY.md',
  'THIRD_PARTY_NOTICES.md',
  '.github/workflows/ci.yml',
  'src/page-parser.ts',
  'tests/parser.test.ts',
];
for (const name of requiredSourceFiles)
  if (!sourceFiles.includes(name))
    throw new Error(`Required source archive file is missing: ${name}`);
if (sourceFiles.some((name) => /^(?:artifacts|\.codex|node_modules|dist|\.output)\//.test(name)))
  throw new Error('Local evidence, configuration, or generated output entered the source archive');
for (const name of sourceFiles.sort()) {
  const data = await readFile(resolve(root, name));
  if (/sk-[a-z0-9]{35,}/.test(data.toString('utf8')))
    throw new Error(`Possible API credential found in source file: ${name}`);
  sourceZip.addFile(name, data);
}
await writeFile(resolve(output, sourceName), await sourceZip.toBuffer());
await writeFile(
  resolve(output, '安装使用说明.md'),
  (await readFile(resolve(root, 'README.md'), 'utf8')).replace(
    '(docs/acceptance.md)',
    '(验收记录.md)',
  ),
);
const publishedDocs = resolve(output, 'docs');
if (relative(output, publishedDocs).replaceAll('\\', '/') !== 'docs')
  throw new Error('Invalid generated documentation path');
await rm(publishedDocs, { recursive: true, force: true });
await cp(resolve(root, 'docs'), publishedDocs, { recursive: true });
await copyFile(
  resolve(root, 'docs/platform-scheduling-0.5.2.md'),
  resolve(output, '访问调度回归.md'),
);
await writeFile(
  resolve(output, '性能对比.md'),
  (
    await readFile(resolve(root, `docs/performance-${version}.md`), 'utf8')
  ).replaceAll(/\]\((?!https?:|#|\/)([^)]+)\)/g, '](docs/$1)'),
);
await writeFile(
  resolve(output, '验收记录.md'),
  (await readFile(resolve(root, 'docs/acceptance.md'), 'utf8')).replaceAll(
    /\]\((?!https?:|#|\/)([^)]+)\)/g,
    '](docs/$1)',
  ),
);
await writeFile(
  resolve(output, '升级说明.md'),
  (await readFile(resolve(root, `docs/upgrade-${version}.md`), 'utf8'))
    .replace('(acceptance.md)', '(验收记录.md)'),
);
const sums = [];
for (const name of [extensionZip, sourceName])
  sums.push(
    `${createHash('sha256')
      .update(await readFile(resolve(output, name)))
      .digest('hex')}  ${name}`,
  );
await writeFile(resolve(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(
  `交付目录：${output}\n可加载扩展：${unpacked}\n源码文件：${sourceFiles.length} 个`,
);
