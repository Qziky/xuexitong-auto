// MV3 packaged pages can execute only extension-local code and WASM.
// https://developer.chrome.com/docs/extensions/develop/migrate/improve-security#remove-unsupported-content-security-policies
export function validateManifestCsp(manifest) {
  const policy = manifest.content_security_policy?.extension_pages;
  if (typeof policy !== 'string')
    throw new Error('Missing extension pages CSP');
  const allowed = new Set(["'self'", "'none'", "'wasm-unsafe-eval'"]);
  for (const directive of policy.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (!/^(?:script-src(?:-elem|-attr)?|object-src|worker-src)$/.test(name))
      continue;
    for (const source of sources) {
      if (!allowed.has(source)) {
        throw new Error(`Unsupported MV3 CSP source ${source} in ${name}`);
      }
    }
  }
}
