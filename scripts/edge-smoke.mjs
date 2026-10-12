import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ROOT,
  DATA,
  FIXTURE,
  control,
  tool,
  evaluation,
  resultText,
  ENDPOINT,
  token,
} from './debug/environment.mjs';

const created = new Set();
async function page(url) {
  const before = await tool('list_pages');
  const existing = new Set(
    [
      ...(before.structuredContent?.pages ?? []),
      ...(before.structuredContent?.extensionPages ?? []),
    ].map((p) => p.id),
  );
  const result = await tool('new_page', {
    url,
    background: true,
    timeout: 30_000,
  });
  const opened = [
    ...(result.structuredContent?.pages ?? []),
    ...(result.structuredContent?.extensionPages ?? []),
  ].find((p) => p.url === url && !existing.has(p.id));
  if (!opened) throw new Error('无法确认调试页面');
  created.add(opened.id);
  return opened.id;
}
async function evaluate(pageId, fn) {
  return evaluation(
    await tool('evaluate_script', {
      pageId,
      function: fn,
      waitForStableDom: false,
    }),
  );
}
const stateCheck = `async () => {
  const reply = await Promise.race([
    chrome.runtime.sendMessage({ target: 'background', kind: 'state' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('扩展状态读取超过 5 秒没有响应')), 5000))
  ]);
  if (!reply.ok) throw new Error(reply.error);
  const s = reply.value;
  return { version: chrome.runtime.getManifest().version, backgroundConnected: true, schema: s.schema,
    queue: s.queue.phase, learning: s.learning.phase, scan: s.scan.phase, providerConfigured: !!s.provider.hasKey,
    workflowsActive: Object.values(s.operations || {}).some(o => o.phase === 'running') };
}`;

try {
  const startedAt = Date.now();
  const health = await control('/health');
  if (health.phase !== 'ready') throw new Error('请先运行 npm run debug:edge');
  const initialize = await control('/mcp', {
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'edge-smoke', version: '1.0.0' },
    },
  });
  if (initialize.error || !initialize.result?.capabilities?.tools)
    throw new Error('MCP 初始化失败');
  await control('/mcp', {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  const catalog = await control('/mcp', {
    jsonrpc: '2.0',
    id: 'catalog',
    method: 'tools/list',
  });
  for (const name of [
    'evaluate_script',
    'reload_extension',
    'take_snapshot',
    'list_console_messages',
  ])
    if (!catalog.result?.tools?.some((t) => t.name === name))
      throw new Error('缺少调试工具: ' + name);
  const anonymous = await fetch(ENDPOINT + '/health', {
    signal: AbortSignal.timeout(2500),
  });
  const fromWeb = await fetch(ENDPOINT + '/health', {
    headers: {
      Authorization: 'Bearer ' + (await token()),
      Origin: 'http://127.0.0.1:5217',
    },
    signal: AbortSignal.timeout(2500),
  });
  if (anonymous.status !== 403 || fromWeb.status !== 403)
    throw new Error('本机调试接口访问保护未通过');
  const panelUrl =
    'chrome-extension://' + health.extensionId + '/sidepanel.html';
  const panel = await page(panelUrl);
  console.log('调试检查：扩展连接');
  const state = await evaluate(panel, stateCheck);
  if (process.argv.includes('--logs')) {
    const logs = await evaluate(
      panel,
      `async () => {
      const reply = await chrome.runtime.sendMessage({ target: 'background', kind: 'log-export', query: {} });
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    }`,
    );
    const path = resolve(DATA, 'extension-journal.json');
    await writeFile(path, JSON.stringify(logs, null, 2));
    console.log(
      JSON.stringify({
        path,
        runs: logs.runs.length,
        events: logs.events.length,
      }),
    );
  } else {
    if (
      [state.queue, state.learning, state.scan].includes('running') ||
      state.workflowsActive
    )
      throw new Error('扩展当前有活动任务，请先暂停后测试重载');
    const fixturePage = await page(FIXTURE);
    console.log('调试检查：浏览器夹具');
    const snapshot = await tool('take_snapshot', { pageId: fixturePage });
    const runUid = resultText(snapshot).match(
      /uid=([^\s]+).*button "运行全部夹具"/,
    )?.[1];
    if (!runUid) throw new Error('未找到本地夹具运行按钮');
    await tool('click', { pageId: fixturePage, uid: runUid });
    let fixture;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const text = await evaluate(
        fixturePage,
        `() => document.querySelector('#result').textContent`,
      );
      try {
        fixture = JSON.parse(text);
      } catch {
        /* Fixture still running. */
      }
      if (['PASS', 'FAIL'].includes(fixture?.status)) break;
      await delay(250);
    }
    if (fixture?.status !== 'PASS')
      throw new Error('浏览器夹具未通过: ' + JSON.stringify(fixture));
    const directory = resolve(ROOT, 'artifacts/private');
    await mkdir(directory, { recursive: true });
    const network = await tool('list_network_requests', {
      pageId: fixturePage,
      pageSize: 20,
    });
    const networkCount =
      network.structuredContent?.networkRequests?.length ?? 0;
    if (!networkCount) throw new Error('无法读取本地夹具的网络记录');
    if (process.argv.includes('--screenshot'))
      await tool('take_screenshot', {
        pageId: fixturePage,
        format: 'jpeg',
        quality: 75,
        filePath: resolve(directory, 'edge-debug-fixture.jpeg'),
      });
    const messages = await tool('list_console_messages', {
      pageId: fixturePage,
      types: ['error'],
      pageSize: 20,
    });
    const errors = messages.structuredContent?.consoleMessages?.length ?? 0;
    if (errors)
      throw new Error(
        '本地夹具浏览器错误: ' +
          JSON.stringify(messages.structuredContent.consoleMessages),
      );
    await control('/reload', {});
    console.log('调试检查：重载恢复');
    await delay(1200);
    const reloadedPanel = await page(panelUrl);
    const after = await evaluate(reloadedPanel, stateCheck);
    if (!after.backgroundConnected || after.version !== state.version)
      throw new Error('扩展重载后未恢复连接');
    const report = {
      status: 'PASS',
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      extension: state,
      reload: after.backgroundConnected,
      fixture,
      consoleErrors: errors,
      networkRequestsObserved: networkCount,
      bridge: {
        initialized: true,
        toolCount: catalog.result.tools.length,
        anonymousDenied: true,
        webOriginDenied: true,
      },
      note: '验证独立调试扩展与本地浏览器夹具；未填写、保存或提交真实平台任务。',
    };
    await writeFile(
      resolve(directory, 'edge-debug-smoke.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const pageId of created)
    await tool('close_page', { pageId }).catch(() => {});
}
