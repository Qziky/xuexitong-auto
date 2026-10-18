// DevTools opens the side panel as a tab for inspectable UI tests. Only this
// exact bundled page gains access in development; release behavior is unchanged.
export function isTrustedExtensionSender(
  sender: { id?: string; url?: string; tab?: unknown },
  runtimeId: string,
  development = false,
): boolean {
  const root = `chrome-extension://${runtimeId}/`;
  return (
    sender.id === runtimeId &&
    Boolean(sender.url?.startsWith(root)) &&
    (!sender.tab || (development && sender.url === root + 'sidepanel.html'))
  );
}

export function isChaoxingUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'chaoxing.com' || u.hostname.endsWith('.chaoxing.com')) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export function safePageUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base).href;
    return isChaoxingUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}
/** Public image CDNs are separate from authenticated course-page origins. */
export function isPublicQuestionImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      ['https://p.ananas.chaoxing.com', 'https://p.cldisk.com'].includes(
        url.origin,
      )
    );
  } catch {
    return false;
  }
}
export function safeQuestionImageUrl(
  value: string,
  base?: string,
): string | undefined {
  if (!value.trim()) return;
  try {
    const url = new URL(value, base);
    // Older assignments retain HTTP CDN addresses even when the browser
    // displays their HTTPS equivalents. Normalize only the known public CDNs.
    if (url.protocol === 'http:' && !url.port) {
      url.protocol = 'https:';
      if (!isPublicQuestionImageUrl(url.href)) return;
    }
    return isChaoxingUrl(url.href) || isPublicQuestionImageUrl(url.href)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function normalizeBaseUrl(value: string): string {
  const u = new URL(value.trim());
  if (u.username || u.password || u.search || u.hash)
    throw new Error('服务地址不能包含凭据、查询参数或片段');
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
  )
    throw new Error('服务地址须使用 HTTPS（本机服务可使用 HTTP）');
  return u.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}
export function providerPermission(baseUrl: string): string {
  return `${new URL(normalizeBaseUrl(baseUrl)).origin}/*`;
}
export function redact(value: string): string {
  return value
    .replace(/\bsk-[\w-]+/gi, '[密钥已隐藏]')
    .replace(
      /([?&](?:enc|token|ktoken|utenc|stuenc|standardEnc|s)=)[^&\s]+/gi,
      '$1[隐藏]',
    )
    .replace(/(?:Bearer|api-key[=:])\s*[^\s,;]+/gi, '[凭据已隐藏]');
}
export function diagnosticUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}
export function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
