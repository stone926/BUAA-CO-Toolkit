import { defineConfig } from 'vitest/config';
import { testCaseTimeoutMs, testHookTimeoutMs } from './src/test/helpers/testTimeouts';

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    globals: false,
    // Parallel compiler/filesystem tests can contend on busy Windows hosts.
    // Performance regressions retain their own explicit elapsed-time budgets.
    testTimeout: testCaseTimeoutMs,
    hookTimeout: testHookTimeoutMs,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/test/**',
        // Browser-only DOM/canvas glue; its pure view logic lives in src/waveform/view and is tested.
        'src/waveform/webview/**',
        'src/mips/debug/webview/**',
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
