// @index logisim-prep — 在用例内创建本次 Logisim 仿真独占的 ROM 注入电路
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { maximumReplaySnapshotBytes } from '../mips/replay/boundedFile';
import { ensureContainedDirectoryPath } from '../pathContainment';

export async function createLogisimRunCircuit(caseDirectory: string, content: string): Promise<string> {
  const size = Buffer.byteLength(content, 'utf8');
  if (size > maximumReplaySnapshotBytes) {
    throw new Error(`ASM case logisim preparedCircuit size ${size} exceeds the hard limit ${maximumReplaySnapshotBytes}`);
  }
  const directory = path.join(caseDirectory, 'logisim');
  await ensureContainedDirectoryPath(caseDirectory, directory);
  const file = path.join(directory, `cpu-${randomUUID().slice(0, 8)}.circ`);
  try {
    await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  return file;
}
