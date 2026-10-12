import { describe, it, expect } from 'vitest';
import { withoutAutomaticDebugger } from '../scripts/debug/compatibility.mjs';

describe('native UI debug environment', () => {
  it('does not automatically enable source debugger during native UI acceptance', () => {
    const input = 'DevTools.ProtocolClient.InspectorBackend.test.suppressRequestErrors = true; const options={overrideAutoStartModels: new Set([DevTools.DebuggerModel]), hostConfig:{}};';
    const changed = withoutAutomaticDebugger(input);
    expect(changed).toContain('overrideAutoStartModels: new Set([]),');
    expect(changed).toContain('hostConfig:{}');
    expect(changed).toContain("'invoke_enable'");
    expect(changed).toContain('Native UI session does not enable the Debugger domain');
    expect(withoutAutomaticDebugger(changed)).toBe(changed);
  });
  it('fails visibly if the dependency no longer has the known setting', () => {
    expect(() => withoutAutomaticDebugger('const unknown=1')).toThrow('marker changed');
  });
});
