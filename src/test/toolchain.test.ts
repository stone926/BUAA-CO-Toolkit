import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {},
  window: {}
}));

import { buildIseEnvironment } from '../toolchain';

describe('toolchain helpers', () => {
  it('builds an ISE environment that exposes simulator GUI helpers on PATH', () => {
    const root = path.resolve('fake-ise-root');
    const inheritedPath = path.resolve('existing-path-entry');
    const env = buildIseEnvironment(root, { Path: inheritedPath });
    const pathValue = env.Path ?? env.PATH ?? '';
    const entries = pathValue.split(path.delimiter);

    expect(env.XILINX).toBe(root);
    expect(entries.slice(0, 3)).toEqual([
      path.join(root, 'bin', 'nt64'),
      path.join(root, 'bin', 'nt64', 'unwrapped'),
      path.join(root, 'lib', 'nt64')
    ]);
    expect(entries).toContain(inheritedPath);
  });
});
