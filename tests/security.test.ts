import { describe, expect, it } from 'vitest';
import {
  isChaoxingUrl,
  normalizeBaseUrl,
  providerPermission,
  redact,
  isTrustedExtensionSender,
  safeQuestionImageUrl,
  isPublicQuestionImageUrl,
  safePageUrl,
} from '../src/security';
import { fontSource } from '../src/ocr';
describe('来源、凭据与本地资源', () => {
  it.each(['p.ananas.chaoxing.com', 'p.cldisk.com'])(
    '%s 的旧 HTTP 题图只规范为 HTTPS，不开放 HTTP 读取或课程页面访问',
    (host) => {
      const path = '/star3/origin/formula.png?size=large';
      const image = `http://${host}${path}`;
      expect(safeQuestionImageUrl(image)).toBe(`https://${host}${path}`);
      expect(safeQuestionImageUrl(`http://${host}:80${path}`)).toBe(
        `https://${host}${path}`,
      );
      expect(isPublicQuestionImageUrl(image)).toBe(false);
      expect(isChaoxingUrl(image)).toBe(false);
      expect(safePageUrl(image)).toBeUndefined();
    },
  );
  it('cldisk 仅作为公共题目图片来源，不能用作课程页面或携带账号凭据', () => {
    const image = 'https://p.cldisk.com/star3/origin/formula.png';
    expect(safeQuestionImageUrl(image)).toBe(image);
    expect(isPublicQuestionImageUrl(image)).toBe(true);
    expect(isChaoxingUrl(image)).toBe(false);
    expect(safePageUrl(image)).toBeUndefined();
    expect(
      isPublicQuestionImageUrl('https://mooc1.chaoxing.com/image.png'),
    ).toBe(false);
  });
  it.each([
    'http://mooc1.chaoxing.com/image.png',
    'http://p.ananas.chaoxing.com.attacker.test/image.png',
    'http://attacker.cldisk.com/image.png',
    'http://p.cldisk.com:8080/image.png',
    'http://p.ananas.chaoxing.com:443/image.png',
    'http://user:password@p.ananas.chaoxing.com/image.png',
    'http://user:password@p.cldisk.com/image.png',
    'https://p.cldisk.com.attacker.test/image.png',
    'https://attacker.cldisk.com/image.png',
    'https://cldisk.com/image.png',
    'https://p.cldisk.com:8443/image.png',
    'https://user:password@p.cldisk.com/image.png',
    'https://example.com/image.png',
  ])('公共题目图片拒绝非精确来源或含凭据的地址：%s', (url) => {
    expect(safeQuestionImageUrl(url)).toBeUndefined();
    expect(isPublicQuestionImageUrl(url)).toBe(false);
  });
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
