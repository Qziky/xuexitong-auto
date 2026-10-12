import { defineConfig } from 'vite';
export default defineConfig({
  root: 'preview',
  publicDir: '../public',
  server: { port: 5217, strictPort: true },
  resolve: { dedupe: ['react', 'react-dom'] },
});
