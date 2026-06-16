import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isDirectory } from './fsUtil';

const stdinExtensions = ['.in', '.input', '.stdin', '.dat'];
const stdinSubdirectories = ['input', 'inputs', 'test', 'tests', 'data'];

export async function resolveSingleStdinInput(asm: vscode.Uri): Promise<vscode.Uri | undefined> {
  const candidates = await findStdinCandidatesForAsm(asm);
  if (!candidates.length) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '无标准输入',
        description: '不使用标准输入运行',
        uri: undefined
      },
      ...candidates.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      }))
    ],
    {
      title: '为此 ASM 用例选择标准输入文件',
      matchOnDescription: true
    }
  );
  return picked?.uri;
}

export async function findStdinCandidatesForAsm(asm: vscode.Uri): Promise<vscode.Uri[]> {
  const asmDir = path.dirname(asm.fsPath);
  const asmStem = path.basename(asm.fsPath, path.extname(asm.fsPath)).toLowerCase();
  const candidates: { file: string; rank: number }[] = [];

  for (const directory of await stdinSearchDirectories(asmDir)) {
    for (const entry of await safeReadDirectory(directory.path)) {
      if (!entry.isFile()) {
        continue;
      }
      const rank = stdinNameRank(entry.name, asmStem);
      if (rank < 0) {
        continue;
      }
      candidates.push({
        file: path.join(directory.path, entry.name),
        rank: directory.rank + rank
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((left, right) => left.rank - right.rank || left.file.localeCompare(right.file))
    .filter((item) => {
      const normalized = path.normalize(item.file).toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    })
    .map((item) => vscode.Uri.file(item.file));
}

async function stdinSearchDirectories(asmDir: string): Promise<Array<{ path: string; rank: number }>> {
  const directories = [{ path: asmDir, rank: 0 }];
  for (let i = 0; i < stdinSubdirectories.length; i++) {
    const candidate = path.join(asmDir, stdinSubdirectories[i]);
    if (await isDirectory(candidate)) {
      directories.push({ path: candidate, rank: (i + 1) * 100 });
    }
  }
  return directories;
}

function stdinNameRank(fileName: string, asmStem: string): number {
  const extension = path.extname(fileName).toLowerCase();
  const extensionRank = stdinExtensions.indexOf(extension);
  if (extensionRank < 0) {
    return -1;
  }

  const stem = path.basename(fileName, path.extname(fileName)).toLowerCase();
  if (stem === asmStem) {
    return extensionRank;
  }
  if (stem.startsWith(`${asmStem}.`)) {
    return 10 + extensionRank;
  }
  if (stem.startsWith(`${asmStem}-`)) {
    return 20 + extensionRank;
  }
  if (stem.startsWith(`${asmStem}_`)) {
    return 30 + extensionRank;
  }
  return -1;
}

async function safeReadDirectory(directory: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}
