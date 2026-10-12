// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  authorized,
  validHost,
  mcpArgs,
  PROFILE,
  activeDedicatedBrowser,
} from '../scripts/debug/environment.mjs';
import { mergeDebugConfig } from '../scripts/setup-debug.mjs';
import {
  openLandingPage,
  connectDedicatedMcp,
} from '../scripts/edge-debug.mjs';

describe('project-local Edge debug configuration', () => {
  it('attaches only the dedicated active browser with a matching socket identity', async () => {
    const read = async () => '9333\n/devtools/browser/abcd-1234\n';
    const response = (socket) => async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: socket }),
    });
    expect(
      await activeDedicatedBrowser(
        read,
        response('ws://127.0.0.1:9333/devtools/browser/abcd-1234'),
      ),
    ).toBe('http://127.0.0.1:9333');
    expect(
      await activeDedicatedBrowser(
        read,
        response('ws://127.0.0.1:9333/devtools/browser/different'),
      ),
    ).toBeUndefined();
    expect(
      await activeDedicatedBrowser(
        read,
        response('ws://remote.example:9333/devtools/browser/abcd-1234'),
      ),
    ).toBeUndefined();
    expect(
      await activeDedicatedBrowser(
        async () => '9333\n/not-a-browser',
        response('ws://127.0.0.1:9333/not-a-browser'),
      ),
    ).toBeUndefined();
  });
  it('reconnects once after the Edge bootstrap exits while the browser remains alive', async () => {
    const urls = [],
      closed = [];
    let activeChecks = 0;
    const factory = (binary, url) => {
      urls.push(url);
      return {
        init: async () => ({ protocolVersion: 'test' }),
        tool: async () => {
          if (!url) throw new Error('bootstrap exited');
        },
        close: async () => closed.push(url),
      };
    };
    const connected = await connectDedicatedMcp(
      'edge.exe',
      factory,
      async () =>
        ++activeChecks === 1 ? undefined : 'http://127.0.0.1:9333',
    );
    expect(urls).toEqual([undefined, 'http://127.0.0.1:9333']);
    expect(closed).toEqual([undefined]);
    expect(connected.initialization.protocolVersion).toBe('test');
  });
  it('attaches to an existing dedicated browser without launching another Edge', async () => {
    const urls = [];
    const connected = await connectDedicatedMcp(
      'edge.exe',
      (binary, url) => {
        urls.push(url);
        return {
          init: async () => ({ protocolVersion: 'test' }),
          tool: async () => ({}),
          close: async () => {},
        };
      },
      async () => 'http://127.0.0.1:9333',
    );
    expect(urls).toEqual(['http://127.0.0.1:9333']);
    expect(connected.initialization.protocolVersion).toBe('test');
  });
  it('does not launch another Edge if attaching to the active browser fails', async () => {
    const urls = [],
      closed = [];
    await expect(
      connectDedicatedMcp(
        'edge.exe',
        (binary, url) => {
          urls.push(url);
          return {
            init: async () => {
              throw new Error('attach failed');
            },
            close: async () => closed.push(url),
          };
        },
        async () => 'http://127.0.0.1:9333',
      ),
    ).rejects.toThrow('attach failed');
    expect(urls).toEqual(['http://127.0.0.1:9333']);
    expect(closed).toEqual(['http://127.0.0.1:9333']);
  });
  it('does not reconnect a failed launch without verified dedicated browser evidence', async () => {
    let started = 0,
      closed = 0;
    await expect(
      connectDedicatedMcp(
        'edge.exe',
        () => {
          started++;
          return {
            init: async () => {
              throw new Error('launch failed');
            },
            close: async () => closed++,
          };
        },
        async () => undefined,
      ),
    ).rejects.toThrow('launch failed');
    expect(started).toBe(1);
    expect(closed).toBe(1);
  });
  it('allows an explicitly configured local dedicated browser when pipe launch is unavailable', () => {
    expect(mcpArgs('edge.exe', 'http://127.0.0.1:9333')).toContain(
      '--browserUrl=http://127.0.0.1:9333',
    );
    expect(
      mcpArgs('edge.exe', 'http://127.0.0.1:9333').join(' '),
    ).not.toContain('--userDataDir');
    expect(() => mcpArgs('edge.exe', 'http://remote.example:9333')).toThrow(
      '本机',
    );
  });
  it('retains the environment when the external landing page fails without retrying', async () => {
    let requests = 0;
    const warning = await openLandingPage({
      tool: async () => {
        requests++;
        throw new Error('net::ERR_CONNECTION_CLOSED');
      },
    });
    expect(requests).toBe(1);
    expect(warning).toContain('调试环境已保留');
    expect(warning).not.toContain('ERR_CONNECTION_CLOSED');
    expect(await openLandingPage({ tool: async () => ({}) })).toBeUndefined();
  });
  it('does not open an extra platform page when Chaoxing tabs already exist', async () => {
    const calls = [];
    await openLandingPage({
      tool: async (name) => {
        calls.push(name);
        if (name === 'list_pages')
          return {
            structuredContent: {
              pages: [{ url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' }],
            },
          };
        return {};
      },
    });
    expect(calls).toEqual(['list_pages']);
  });
  it('requires the exact bearer credential', () => {
    expect(authorized(undefined, 'local-test')).toBe(false);
    expect(authorized('Bearer short', 'local-test')).toBe(false);
    expect(authorized('Bearer wrong-test', 'local-test')).toBe(false);
    expect(authorized('Bearer local-test', 'local-test')).toBe(true);
  });
  it('rejects foreign hosts and missing host headers', () => {
    expect(validHost('127.0.0.1:9223')).toBe(true);
    expect(validHost('localhost:9223')).toBe(true);
    expect(validHost('other.example:9223')).toBe(false);
    expect(validHost(undefined)).toBe(false);
  });
  it('preserves unrelated configuration and replaces only its own block', () => {
    const existing =
      'model = "custom"\n[mcp_servers.other]\nurl = "http://localhost:8000"\n';
    const first = mergeDebugConfig(
      existing,
      '[mcp_servers.edge_devtools]\nurl = "first"',
    );
    const second = mergeDebugConfig(
      first,
      '[mcp_servers.edge_devtools]\nurl = "second"',
    );
    expect(second).toContain(existing.trim());
    expect(second).not.toContain('url = "first"');
    expect(second.match(/\[mcp_servers.edge_devtools\]/g)).toHaveLength(1);
  });
  it('does not overwrite an unmanaged server with the same name', () => {
    expect(() =>
      mergeDebugConfig('[mcp_servers.edge_devtools]\nurl = "manual"', 'new'),
    ).toThrow('未覆盖');
  });
  it('launches a separate profile with extension debugging and normal browser protections', () => {
    const args = mcpArgs('edge.exe');
    expect(args).toContain('--userDataDir=' + PROFILE);
    expect(args).toContain('--categoryExtensions');
    expect(args).toContain('--chromeArg=--restore-last-session');
    expect(args).toContain('--chromeArg=--remote-debugging-port=0');
    expect(args).toContain('--no-usage-statistics');
    expect(args).toContain('--no-performance-crux');
    expect(args.join(' ')).not.toMatch(
      /browserUrl|no-sandbox|disable-web-security|ignore-certificate-errors/,
    );
  });
});
