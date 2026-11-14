// @index user-asm-inputs — 用户 ASM 文件或目录的非递归、确定性发现
import * as fs from 'fs/promises';
import * as path from 'path';

export function isUserAsmFile(filePath: string): boolean {
  return /\.(?:asm|s|mips)$/i.test(filePath);
}

/** Directory inputs contain only immediate regular files; never traverse child directories or links. */
export async function discoverUserAsmInputs(inputPath: string): Promise<string[]> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(inputPath);
  } catch (error) {
    throw new Error(`无法读取汇编输入 ${inputPath}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isFile()) {
    if (!isUserAsmFile(inputPath)) throw new Error('请选择 .asm、.s 或 .mips 汇编文件');
    return [inputPath];
  }
  if (!stat.isDirectory()) throw new Error('汇编输入必须是普通文件或目录，不能是符号链接');
  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && isUserAsmFile(entry.name))
    .map(entry => path.join(inputPath, entry.name));
  files.sort((left, right) => {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
  });
  if (!files.length) throw new Error(`目录中没有可测试的 .asm、.s 或 .mips 文件（仅查找直属文件）：${inputPath}`);
  return files;
}
