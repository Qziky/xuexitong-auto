import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        settings: {
          disableCSSFileLoading: true,
          disableJavaScriptEvaluation: true,
          disableJavaScriptFileLoading: true,
        },
      },
    },
    include: ['tests/**/*.test.{ts,js}'],
  },
});
