import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    globals: false,
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/test/**',
        'out/**',
        'src/extension.ts',
        'src/languageClient.ts',
        'src/server.ts'
      ],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        statements: 71,
        branches: 65,
        functions: 76,
        lines: 71
      }
    }
  },
});
