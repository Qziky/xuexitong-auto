import { describe, expect, it } from 'vitest';
import {
  isChaoxingUrl,
  normalizeBaseUrl,
  providerPermission,
  redact,
  isTrustedExtensionSender,
} from '../src/security';
import { fontSource } from '../src/ocr';
describe('来源、凭据与本地资源', () => {
  it('仅开发版允许本扩展侧栏标签页，正式版及网页消息仍受限制', () => {
    const sender = {
      id: 'own-id',
      url: 'chrome-extension://own-id/sidepanel.html',
      tab: { id: 1 },
    };
    expect(isTrustedExtensionSender(sender, 'own-id')).toBe(false);
    expect(isTrustedExtensionSender(sender, 'own-id', true)).toBe(true);
    expect(
      isTrustedExtensionSender({ ...sender, id: 'foreign-id' }, 'own-id', true),
    ).toBe(false);
    expect(
      isTrustedExtensionSender(
        { ...sender, url: 'https://mooc1.chaoxing.com/' },
        'own-id',
        true,
      ),
    ).toBe(false);
    expect(
      isTrustedExtensionSender(
        { ...sender, url: sender.url + '?spoof=1' },
        'own-id',
        true,
      ),
    ).toBe(false);
    expect(
      isTrustedExtensionSender(
        { ...sender, url: 'chrome-extension://own-id/offscreen.html' },
        'own-id',
        true,
      ),
    ).toBe(false);
    expect(
      isTrustedExtensionSender({ ...sender, tab: undefined }, 'own-id'),
    ).toBe(true);
  });
  it('拒绝相似域名、含凭据 URL 和不安全远程 HTTP', () => {
    expect(isChaoxingUrl('https://chaoxing.com.attacker.test/')).toBe(false);
    expect(isChaoxingUrl('https://mooc1.chaoxing.com/')).toBe(true);
    expect(() =>
      normalizeBaseUrl('https://secret@api.example.test/v1'),
    ).toThrow();
    expect(() => normalizeBaseUrl('http://api.example.test/v1')).toThrow();
  });
  it('支持本机接口以及精确域名权限', () => {
    expect(providerPermission('https://example.test/v1/chat/completions')).toBe(
      'https://example.test/*',
    );
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1/')).toBe(
      'http://127.0.0.1:1234/v1',
    );
  });
  it('日志删除密钥和页面令牌', () => {
    const result = redact(
      'key sk-testfake123 https://mooc1.chaoxing.com/?enc=testtoken&courseid=1',
    );
    expect(result).not.toContain('testfake');
    expect(result).not.toContain('testtoken');
  });
  it('只接收页面已提供的混淆字体，不从任意站点下载', () => {
    expect(
      fontSource(
        "@font-face{font-family:'font-cxsecret';src:url('data:application/font-ttf;base64,AAAA')}",
        'https://mooc1.chaoxing.com/',
      ),
    ).toContain('data:');
    expect(() =>
      fontSource(
        "@font-face{font-family:font-cxsecret;src:url('https://attacker.test/font.ttf')}",
        'https://mooc1.chaoxing.com/',
      ),
    ).toThrow();
  });
});
