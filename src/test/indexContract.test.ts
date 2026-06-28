import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

describe('multi-level source index contract', () => {
  it('reports no index errors from the Vitest contract suite', () => {
    const result = spawnSync(process.execPath, ['scripts/check-index.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status === 0 || result.status === 1).toBe(true);
    expect(output).toMatch(/错误:\s*0/);
    expect(output).not.toContain('ERROR:');
  });
});
