// Native UI acceptance does not need source-level breakpoints. Enabling the
// Debugger domain records every dynamically-created script on some course pages
// and can stall their renderer. Keep Runtime/DOM/network tools available.
export function withoutAutomaticDebugger(source) {
  const marker = 'overrideAutoStartModels: new Set([DevTools.DebuggerModel]),';
  const replacement = 'overrideAutoStartModels: new Set([]),';
  const globals = 'DevTools.ProtocolClient.InspectorBackend.test.suppressRequestErrors = true;';
  const patchTag = '/* Native UI: Debugger domain disabled */';
  if (source.includes(patchTag) && source.includes(replacement)) return source;
  if ((!source.includes(marker) && !source.includes(replacement)) || !source.includes(globals))
    throw new Error('DevTools compatibility marker changed; check the locked dependency');
  return source.replace(marker, replacement).replace(globals, `${globals}
    ${patchTag}
    const nativeUiDebugger = DevTools.ProtocolClient.InspectorBackend.inspectorBackend.agentPrototypes.get('Debugger');
    if (nativeUiDebugger) Object.defineProperty(nativeUiDebugger, 'invoke_enable', {
        value: () => Promise.resolve({getError: () => 'Native UI session does not enable the Debugger domain'}),
        writable: true, configurable: true, enumerable: true,
    });`);
}
