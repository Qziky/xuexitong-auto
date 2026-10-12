import { build } from 'vite';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
await build({
  configFile: false,
  build: {
    lib: {
      entry: resolve(root, 'src/provider.ts'),
      formats: ['es'],
      fileName: 'model-check',
    },
    outDir: resolve(root, '.output/model-check'),
    target: 'es2022',
    emptyOutDir: true,
  },
});
