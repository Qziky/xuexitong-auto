import { registerHooks } from 'node:module';
import { withoutAutomaticDebugger } from './compatibility.mjs';

// A project-only in-memory adjustment: no dependency or platform file is edited.
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith('/chrome-devtools-mcp/build/src/devtools/DevtoolsUtils.js'))
      return { ...result, source: withoutAutomaticDebugger(String(result.source)) };
    return result;
  },
});
