import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ROOT, mcpArgs } from './environment.mjs';

// Standard MCP JSON-RPC over stdio. One child owns one persistent Edge profile.
export class McpClient {
  pending = new Map();
  serial = 0;
  closed = false;
  constructor(binary, browserUrl) {
    this.child = spawn(
      process.execPath,
      [
        '--import',
        new URL('./native-ui-loader.mjs', import.meta.url).href,
        ...mcpArgs(binary, browserUrl),
      ],
      {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1',
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
        },
      },
    );
    this.child.stderr.on('data', () => {}); // Raw server/browser output may contain page data.
    this.child.stdin.on('error', (error) => this.rejectAll(error));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error
        ? pending.reject(new Error(message.error.message))
        : pending.resolve(message.result);
    });
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('exit', () => {
      this.closed = true;
      this.rejectAll(new Error('DevTools 进程已结束'));
    });
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  request(method, params = {}, timeout = 180_000) {
    if (this.closed) return Promise.reject(new Error('DevTools 已关闭'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify('notifications/cancelled', {
          requestId: id,
          reason: 'timeout',
        });
        reject(new Error('DevTools 请求超时: ' + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        },
      );
    });
  }
  notify(method, params = {}) {
    if (!this.closed && !this.child.stdin.destroyed)
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n',
      );
  }
  async init() {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'xuexitong-debug', version: '1.0.0' },
      },
      30_000,
    );
    this.notify('notifications/initialized');
    return result;
  }
  async tool(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (result.isError)
      throw new Error(
        result.content
          ?.filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n') || 'DevTools 操作失败',
      );
    return result;
  }
  async close() {
    this.closed = true;
    this.rejectAll(new Error('调试连接已关闭'));
    this.child.stdin.end();
    await Promise.race([
      new Promise((resolve) => this.child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 6000)),
    ]);
    if (this.child.exitCode === null) this.child.kill();
    this.lines.close();
  }
}
