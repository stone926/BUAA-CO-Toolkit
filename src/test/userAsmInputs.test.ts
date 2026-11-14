import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverUserAsmInputs } from '../courseTesting/userAsmInputs';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'co-user-asm-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('user ASM inputs', () => {
  it('discovers only direct regular assembly files in stable case-independent order', async () => {
    await Promise.all(['z.asm', 'B.S', 'a.mips', 'code.txt'].map(name => fs.writeFile(path.join(directory, name), 'nop')));
    await fs.mkdir(path.join(directory, 'nested.asm'));
    await fs.writeFile(path.join(directory, 'nested.asm', 'hidden.asm'), 'nop');
    expect((await discoverUserAsmInputs(directory)).map(file => path.basename(file))).toEqual(['a.mips', 'B.S', 'z.asm']);
  });

  it('accepts a single file including spaces and non-ASCII names', async () => {
    const file = path.join(directory, '用户 测试.ASM');
    await fs.writeFile(file, 'nop');
    expect(await discoverUserAsmInputs(file)).toEqual([file]);
  });

  it('reports an empty directory without traversing nested files', async () => {
    await fs.mkdir(path.join(directory, 'nested'));
    await fs.writeFile(path.join(directory, 'nested', 'hidden.asm'), 'nop');
    await expect(discoverUserAsmInputs(directory)).rejects.toThrow('仅查找直属文件');
  });

  it('reports missing and unsupported inputs', async () => {
    await expect(discoverUserAsmInputs(path.join(directory, 'missing.asm'))).rejects.toThrow('无法读取汇编输入');
    const file = path.join(directory, 'code.txt');
    await fs.writeFile(file, 'nop');
    await expect(discoverUserAsmInputs(file)).rejects.toThrow('.asm、.s 或 .mips');
  });
});
