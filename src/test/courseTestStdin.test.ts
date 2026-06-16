import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { URI } = await import('vscode-uri');
  return {
    Uri: {
      file: (file: string) => URI.file(file)
    },
    workspace: {
      asRelativePath: (uri: { fsPath: string }) => uri.fsPath
    },
    window: {
      showQuickPick: vi.fn()
    }
  };
});

import * as vscode from 'vscode';
import { findStdinCandidatesForAsm, resolveSingleStdinInput } from '../courseTestStdin';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe('course test stdin helpers', () => {
  it('orders stdin candidates by directory, naming pattern, and extension', async () => {
    const root = makeTempRoot();
    const asm = writeFile(root, 'Case.asm', 'nop\n');
    writeFile(root, 'CASE.input', '2\n');
    writeFile(root, 'case.in', '1\n');
    writeFile(root, 'case-extra.in', '3\n');
    writeFile(root, 'case_extra.dat', '4\n');
    writeFile(root, 'case.txt', 'ignored\n');
    writeFile(root, 'other.in', 'ignored\n');
    writeFile(root, 'input/case.in', '5\n');

    const candidates = await findStdinCandidatesForAsm(vscode.Uri.file(asm));

    expect(candidates.map((uri) => relative(root, uri.fsPath))).toEqual([
      'case.in',
      'CASE.input',
      'case-extra.in',
      'case_extra.dat',
      'input/case.in'
    ]);
  });

  it('returns the only stdin candidate without showing a picker', async () => {
    const root = makeTempRoot();
    const asm = writeFile(root, 'test.asm', 'nop\n');
    const stdin = writeFile(root, 'test.in', '1\n');

    const resolved = await resolveSingleStdinInput(vscode.Uri.file(asm));

    expect(normalizedPath(resolved?.fsPath)).toBe(normalizedPath(stdin));
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-stdin-test-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): string {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function relative(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, '/');
}

function normalizedPath(file: string | undefined): string | undefined {
  return file === undefined ? undefined : path.normalize(file).toLowerCase();
}
