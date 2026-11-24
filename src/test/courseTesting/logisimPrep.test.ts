import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { expect, it } from 'vitest';
import { createLogisimRunCircuit } from '../../courseTesting/logisimPrep';

it('writes each runnable circuit once under its case with an independent short name', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co-logisim-测试 '));
  try {
    const first = await createLogisimRunCircuit(dir, 'first');
    const second = await createLogisimRunCircuit(dir, 'second');
    expect(path.dirname(first)).toBe(path.join(dir, 'logisim'));
    expect(path.basename(first)).toMatch(/^cpu-[0-9a-f]{8}\.circ$/);
    expect(first).not.toBe(second);
    expect(await fs.readFile(first, 'utf8')).toBe('first');
    expect(await fs.readFile(second, 'utf8')).toBe('second');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
