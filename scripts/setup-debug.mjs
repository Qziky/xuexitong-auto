import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, ENDPOINT, token, findEdge } from './debug/environment.mjs';

export function mergeDebugConfig(source, block) {
  const start = '# BEGIN XUEXITONG EDGE DEBUG';
  const end = '# END XUEXITONG EDGE DEBUG';
  const managed = new RegExp(start + '[\\s\\S]*?' + end + '\\r?\\n?', 'g');
  const clean = source.replace(managed, '');
  if (/^\s*\[mcp_servers\.edge_devtools\]/m.test(clean))
    throw new Error('已有同名 MCP 配置，未覆盖，请先核对 .codex/config.toml');
  return (
    clean.replace(/\s*$/, '') +
    (clean.trim() ? '\n\n' : '') +
    start +
    '\n' +
    block +
    '\n' +
    end +
    '\n'
  );
}

export async function setup() {
  findEdge();
  const directory = resolve(ROOT, '.codex');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'config.toml');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const block =
    '[mcp_servers.edge_devtools]\nurl = "' +
    ENDPOINT +
    '/mcp"\n' +
    'http_headers = { Authorization = "Bearer ' +
    (await token()) +
    '" }\n' +
    'startup_timeout_sec = 60\ntool_timeout_sec = 180\nenabled = true';
  await writeFile(path, mergeDebugConfig(current, block), { mode: 0o600 });
  console.log(
    '已配置项目级 Edge MCP；凭据只存于忽略的本机文件。重启 Codex 后生效。',
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
)
  setup().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
