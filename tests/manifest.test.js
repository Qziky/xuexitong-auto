import { describe, expect, it } from 'vitest';
import { validateManifestCsp } from '../scripts/manifest-policy.mjs';

const manifest = (policy) => ({
  content_security_policy: { extension_pages: policy },
});
describe('MV3 安装包 CSP', () => {
  it('允许包内 worker 和 WebAssembly', () => {
    expect(() =>
      validateManifestCsp(
        manifest(
          "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';",
        ),
      ),
    ).not.toThrow();
  });
  it('拒绝 Edge 无法加载的 blob worker 及其他外部代码来源', () => {
    for (const policy of [
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self' blob:;",
      "script-src 'self' https://cdn.example.test; object-src 'self';",
      "script-src 'self' 'unsafe-eval'; object-src 'self';",
      "script-src 'self'; script-src-elem 'unsafe-inline'; object-src 'self';",
    ])
      expect(() => validateManifestCsp(manifest(policy))).toThrow(
        /Unsupported MV3 CSP/,
      );
  });
});
