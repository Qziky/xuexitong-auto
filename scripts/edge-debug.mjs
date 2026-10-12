import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ROOT,
  DATA,
  OUTPUT,
  ENDPOINT,
  authorized,
  validHost,
  control,
  token,
  findEdge,
  resultText,
  activeDedicatedBrowser,
} from './debug/environment.mjs';
import { McpClient } from './debug/mcp-client.mjs';
import { setup } from './setup-debug.mjs';

const runtimePath = resolve(DATA, 'runtime.json');
export async function connectDedicatedMcp(
  binary,
  factory = (path, url) => new McpClient(path, url),
  active = activeDedicatedBrowser,
) {
  const existingAddress = await active();
  if (existingAddress) {
    const client = factory(binary, existingAddress);
    try {
      const initialization = await client.init();
      await client.tool('list_pages');
      return { client, initialization };
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  let client = factory(binary);
  try {
    const initialization = await client.init();
    await client.tool('list_pages');
    return { client, initialization };
  } catch (error) {
    const address = await active();
    await client.close();
    if (!address) throw error;
    client = factory(binary, address);
    try {
      const initialization = await client.init();
      await client.tool('list_pages');
      return { client, initialization };
    } catch (attachedError) {
      await client.close();
      throw attachedError;
    }
  }
}
export async function openLandingPage(mcp) {
  try {
    const inventory = await mcp.tool('list_pages');
    const pages = inventory.structuredContent?.pages;
    if (
      !Array.isArray(pages) ||
      pages.some((page) => {
        try {
          return new URL(page.url).hostname.endsWith('.chaoxing.com');
        } catch {
          return false;
        }
      })
    )
      return undefined;
    await mcp.tool('new_page', {
      url: 'https://i.chaoxing.com/',
      timeout: 30_000,
    });
    return undefined;
  } catch {
    return '学习通首页未能打开；调试环境已保留，请检查网络后手动打开页面';
  }
}
function send(response, status, result) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(result));
}

export async function serve() {
  const accessToken = await token();
  const info = {
    name: 'xuexitong-edge-debug',
    pid: process.pid,
    phase: 'starting',
    startedAt: Date.now(),
  };
  let mcp, wxt, preview, initialization;
  let closing = false;
  const saveInfo = () => writeFile(runtimePath, JSON.stringify(info));
  const server = createHttpServer(async (request, response) => {
    try {
      if (
        !validHost(request.headers.host) ||
        request.headers.origin ||
        !authorized(request.headers.authorization, accessToken)
      ) {
        send(response, 403, { error: '调试接口仅允许本机授权客户端访问' });
        return;
      }
      const pathname = new URL(request.url, ENDPOINT).pathname;
      if (pathname === '/health' && request.method === 'GET') {
        send(response, 200, info);
        return;
      }
      if (request.method !== 'POST') {
        send(response, 405, { error: '只支持 JSON POST' });
        return;
      }
      if (pathname === '/stop') {
        send(response, 200, { stopped: true });
        void close();
        return;
      }
      if (info.phase !== 'ready') {
        send(response, 503, { error: '调试环境正在启动或停止' });
        return;
      }
      if (pathname === '/reload') {
        await mcp.tool('reload_extension', { id: info.extensionId });
        send(response, 200, { reloaded: true });
        return;
      }
      if (pathname !== '/mcp') {
        send(response, 404, { error: '没有此接口' });
        return;
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) {
          send(response, 413, { error: '请求过大' });
          return;
        }
        chunks.push(chunk);
      }
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        send(response, 400, { error: '无效 JSON' });
        return;
      }
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        send(response, 400, { error: '无效 MCP 消息' });
        return;
      }
      if (message.id === undefined) {
        send(response, 202, {});
        return;
      }
      try {
        let result;
        if (message.method === 'initialize') {
          result = {
            protocolVersion: initialization.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'xuexitong-edge-debug', version: '1.0.0' },
            instructions:
              '专用 Edge 调试会话。登录态和密钥不得导出；真实填写、保存及提交只在用户指定任务后执行。遇验证码或限流停止并等待人工恢复。',
          };
        } else if (message.method === 'ping') result = {};
        else if (message.method === 'tools/list')
          result = await mcp.request('tools/list', message.params);
        else if (message.method === 'tools/call') {
          const { name, arguments: args = {} } = message.params ?? {};
          if (
            name === 'install_extension' &&
            resolve(args.path ?? '') !== OUTPUT
          )
            throw new Error('仅允许加载本项目开发扩展');
          if (
            [
              'reload_extension',
              'trigger_extension_action',
              'uninstall_extension',
            ].includes(name) &&
            args.id !== info.extensionId
          )
            throw new Error('仅允许操作本项目扩展');
          if (name === 'uninstall_extension')
            throw new Error('请通过停止调试关闭环境，保留扩展配置');
          result = await mcp.request('tools/call', { name, arguments: args });
        } else throw new Error('不支持的 MCP 方法');
        send(response, 200, { jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        send(response, 200, {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: error.message },
        });
      }
    } catch (error) {
      if (!response.writableEnded)
        send(response, 500, { error: error.message });
    }
  });
  async function close() {
    if (closing) return;
    closing = true;
    info.phase = 'stopping';
    await saveInfo();
    await mcp?.close();
    await preview?.close();
    await wxt?.stop();
    info.phase = 'stopped';
    await saveInfo();
    server.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(9223, '127.0.0.1', accept);
  });
  await saveInfo();
  try {
    await import('./prepare-assets.mjs');
    const { createServer } = await import('wxt');
    wxt = await createServer({ root: ROOT, browser: 'edge' });
    await wxt.start();
    const { createServer: createPreview } = await import('vite');
    preview = await createPreview({
      configFile: resolve(ROOT, 'vite.preview.config.ts'),
      server: { host: '127.0.0.1' },
    });
    await preview.listen();
    ({ client: mcp, initialization } = await connectDedicatedMcp(findEdge()));
    const installed = await mcp.tool('install_extension', { path: OUTPUT });
    const id = resultText(installed).match(/Id:\s*([a-p]{32})/i)?.[1];
    if (!id) throw new Error('未取得开发扩展 ID');
    info.extensionId = id;
    info.startupWarning = await openLandingPage(mcp);
    info.phase = 'ready';
    info.readyAt = Date.now();
    await saveInfo();
    console.log('专用 Edge、开发重载与 MCP 已就绪');
  } catch (error) {
    info.phase = 'failed';
    info.error = error.message;
    await saveInfo();
    console.error('调试环境启动失败: ' + error.message);
    await mcp?.close();
    await preview?.close();
    await wxt?.stop();
    server.close();
    process.exitCode = 1;
  }
}

async function start() {
  await setup();
  let existing;
  try {
    existing = await control('/health');
  } catch {
    /* No running daemon. */
  }
  if (existing?.phase === 'ready') {
    console.log('调试环境已运行，无需重复启动');
    return;
  }
  if (existing && existing.phase !== 'starting')
    throw new Error('旧调试环境尚未关闭，请先运行 npm run debug:stop');
  const launchedAt = Date.now();
  if (!existing) {
    await mkdir(DATA, { recursive: true });
    const log = await open(resolve(DATA, 'service.log'), 'a');
    try {
      const child = spawn(process.execPath, [import.meta.filename, 'serve'], {
        cwd: ROOT,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      child.unref();
    } finally {
      await log.close();
    }
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    let health;
    try {
      health = await control('/health');
    } catch {
      /* Startup may not yet listen. */
    }
    if (health?.phase === 'ready') {
      console.log(
        '已启动专用 Edge。首次使用请在此窗口登录；重启 Codex 后连接项目 MCP。',
      );
      return;
    }
    if (health?.phase === 'failed')
      throw new Error(health.error || '调试环境启动失败');
    try {
      const saved = JSON.parse(await readFile(runtimePath, 'utf8'));
      if (saved.phase === 'failed' && saved.startedAt >= launchedAt)
        throw new Error(saved.error || '调试环境启动失败');
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError))
        throw error;
    }
    await delay(350);
  }
  throw new Error('启动超时，请查看 .wxt/edge-debug/service.log');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const mode = process.argv[2] || 'start';
  const main = async () => {
    if (mode === 'serve') await serve();
    else if (mode === 'start') await start();
    else if (mode === 'status')
      console.log(JSON.stringify(await control('/health'), null, 2));
    else if (mode === 'reload')
      console.log(JSON.stringify(await control('/reload', {})));
    else if (mode === 'stop')
      console.log(JSON.stringify(await control('/stop', {})));
    else throw new Error('支持 start / status / reload / stop');
  };
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
