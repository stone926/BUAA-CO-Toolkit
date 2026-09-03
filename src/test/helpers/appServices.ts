import { vi } from 'vitest';
import type { ViewColumn } from 'vscode';
import type { AppServices, RunResult } from '../../types';

/** Complete host fixtures that retain their mock call signatures for assertions. */
export function createTestServices() {
  return {
    output: {
      name: 'test',
      append: vi.fn<(value: string) => void>(),
      appendLine: vi.fn<(value: string) => void>(),
      replace: vi.fn<(value: string) => void>(),
      clear: vi.fn<() => void>(),
      show: vi.fn<(columnOrFocus?: ViewColumn | boolean, preserveFocus?: boolean) => void>(),
      hide: vi.fn<() => void>(),
      dispose: vi.fn<() => void>()
    },
    statusBar: {
      id: 'test',
      alignment: 1,
      priority: undefined,
      name: 'test',
      text: '',
      tooltip: undefined,
      color: undefined,
      backgroundColor: undefined,
      command: undefined,
      accessibilityInformation: undefined,
      show: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      dispose: vi.fn<() => void>()
    }
  } satisfies AppServices;
}

export function createTestRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    ok: true,
    exitCode: 0,
    commandLine: 'test-tool',
    cwd: 'E:/work',
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  };
}
