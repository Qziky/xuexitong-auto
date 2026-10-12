import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DATA = resolve(ROOT, '.wxt/edge-debug');
export const PROFILE = resolve(DATA, 'profile');
export const OUTPUT = resolve(ROOT, '.output/edge-mv3-dev');
export const ENDPOINT = 'http://127.0.0.1:9223';
export const FIXTURE = 'http://127.0.0.1:5217/learning-fixture.html';
export const SERVER = resolve(
  ROOT,
  'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
);

export function findEdge() {
  const candidates = [
    process.env.EDGE_DEBUG_BINARY,
    join(
      process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)',
      'Microsoft/Edge/Application/msedge.exe',
    ),
    join(
      process.env.PROGRAMFILES || 'C:/Program Files',
      'Microsoft/Edge/Application/msedge.exe',
    ),
    join(
      process.env.LOCALAPPDATA || '',
      'Microsoft/Edge/Application/msedge.exe',
    ),
  ];
  const binary = candidates.find((path) => path && existsSync(path));
  if (!binary)
    throw new Error('未找到 Edge，可用 EDGE_DEBUG_BINARY 指定安装路径');
  return binary;
}

export async function token() {
  await mkdir(DATA, { recursive: true });
  const path = resolve(DATA, 'access-token');
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = randomBytes(32).toString('hex');
    try {
      await writeFile(path, value, { flag: 'wx', mode: 0o600 });
    } catch (race) {
      if (race.code !== 'EEXIST') throw race;
      return (await readFile(path, 'utf8')).trim();
    }
    return value;
  }
}

export function authorized(header, value) {
  if (typeof header !== 'string') return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from('Bearer ' + value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validHost(host) {
  return ['127.0.0.1:9223', 'localhost:9223'].includes(host);
}

export async function control(path, body) {
  const response = await fetch(ENDPOINT + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + (await token()),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path === '/health' ? 2500 : 180_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '调试服务不可用');
  return result;
}

export function mcpArgs(
  binary,
  browserUrl = process.env.EDGE_DEBUG_BROWSER_URL,
) {
  if (browserUrl && !/^http:\/\/127\.0\.0\.1:\d+$/.test(browserUrl))
    throw new Error('Edge 调试地址必须是本机专用调试端口');
  return [
    SERVER,
    ...(browserUrl
      ? ['--browserUrl=' + browserUrl]
      : ['--executablePath=' + binary, '--userDataDir=' + PROFILE]),
    '--categoryExtensions',
    '--chromeArg=--restore-last-session',
    '--chromeArg=--remote-debugging-port=0',
    '--no-usage-statistics',
    '--no-performance-crux',
    '--redact-network-headers',
    '--experimentalStructuredContent',
    '--filesystemRoot=' + ROOT,
  ];
}

// Edge may finish its bootstrap process while its dedicated browser is already running.
// Match both port and browser identity so a stale file never attaches another profile.
export async function activeDedicatedBrowser(read = readFile, request = fetch) {
  try {
    const lines = (await read(resolve(PROFILE, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split(/\r?\n/);
    const port = Number(lines[0]);
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^\/devtools\/browser\/[a-f0-9-]+$/i.test(lines[1] ?? '')
    )
      return undefined;
    const address = `http://127.0.0.1:${port}`;
    const response = await request(address + '/json/version', {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return undefined;
    const socket = new URL((await response.json()).webSocketDebuggerUrl);
    if (
      !['127.0.0.1', 'localhost'].includes(socket.hostname) ||
      Number(socket.port) !== port ||
      socket.pathname !== lines[1]
    )
      return undefined;
    return address;
  } catch {
    return undefined;
  }
}

export async function tool(name, args = {}) {
  const response = await control('/mcp', {
    jsonrpc: '2.0',
    id: randomBytes(8).toString('hex'),
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (response.error) throw new Error(response.error.message);
  if (response.result?.isError) {
    throw new Error(
      response.result.content
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n') || '调试操作失败',
    );
  }
  return response.result;
}

export function resultText(result) {
  return (
    result.content
      ?.filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n') || ''
  );
}

export function evaluation(result) {
  const text = resultText(result);
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!match) throw new Error('没有收到可解析的脚本结果');
  return JSON.parse(match[1]);
}
