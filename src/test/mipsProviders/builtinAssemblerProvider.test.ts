import { describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';

vi.mock('vscode', () => ({
  Uri: URI,
  workspace: {
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      inspect: () => ({ workspaceValue: undefined }),
      update: vi.fn()
    })
  }
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BUILTIN_TS_ASSEMBLER_DESCRIPTOR,
  BuiltinTsAssemblerProvider
} from '../../mips/providers/builtinAssemblerProvider';
import { wordsToHexText } from '../../mips/core/assembler/artifacts';
import {
  assembleProgramForService,
  courseAssemblerSemanticsRevision
} from '../../mips/core/assembler/assemblyService';
import { builtinAssemblerEngineDocument } from '../../mips/replay/builtinAssemblerEngineArtifact';
import type { AssembleRequest } from '../../mips/providers/contracts';

describe('BuiltinTsAssemblerProvider', () => {
  it('uses one assembler semantics revision across service, descriptor, and artifact identity', () => {
    const service = assembleProgramForService({
      profile: 'P3',
      sources: [{ id: 'root', text: '.text\n    nop\n' }]
    });
    const artifact = builtinAssemblerEngineDocument();

    expect(courseAssemblerSemanticsRevision).toBe(2);
    expect(service.semanticsRevision).toBe(courseAssemblerSemanticsRevision);
    expect(BUILTIN_TS_ASSEMBLER_DESCRIPTOR.semanticsRevision).toBe(courseAssemblerSemanticsRevision);
    expect(artifact.engine.semanticsRevision).toBe(courseAssemblerSemanticsRevision);
    expect(artifact.assemblerSemanticsRevision).toBe(courseAssemblerSemanticsRevision);
  });

  it('assembles a course source into user-text and a full ProgramImage', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-builtin-assembler-test-'));
    try {
      const sourceUri = URI.file(path.join(directory, 'main.asm'));
      await fs.promises.writeFile(sourceUri.fsPath, [
        '.text',
        'main:',
        '    ori $t0, $0, 0x2a',
        '_halt:',
        '    beq $0, $0, _halt',
        '    nop'
      ].join('\n'), 'utf8');
      const outputUri = URI.file(path.join(directory, 'code.txt'));
      const request: AssembleRequest = {
        sourceUri,
        target: { kind: 'userText', outputFile: outputUri },
        courseTrace: true,
        requirements: { profile: 'P3', pseudoInstructions: true }
      };
      const provider = new BuiltinTsAssemblerProvider();
      const preflight = await provider.preflight(request);
      expect(preflight.ok).toBe(true);
      const result = await provider.assemble(request);
      if (!result.ok) console.error(result.status.stderr);
      expect(result.ok).toBe(true);
      expect(result.outputFile?.fsPath).toBe(outputUri.fsPath);
      expect(result.courseHaltPc).toBe(0x3004);
      const dumped = (await fs.promises.readFile(outputUri.fsPath, 'utf8')).trim().split(/\s+/);
      const textWords = result.image!.segments.find((segment) => segment.name === 'text')!.words;
      expect(wordsToHexText(textWords).trim().split(/\s+/)).toEqual(dumped);
      expect(result.image!.sourceMap).toHaveLength(textWords.length);
      expect(result.image!.inputGraph).toHaveLength(1);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('captures includes under a Chinese/space path with CRLF and BOM', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-builtin-assembler-test-'));
    const projectDir = path.join(directory, '中文 路径');
    await fs.promises.mkdir(projectDir);
    try {
      const sourceUri = URI.file(path.join(projectDir, 'main.asm'));
      const includeUri = path.join(projectDir, 'lib 文件.asm');
      await fs.promises.writeFile(sourceUri.fsPath, '\ufeff.include "lib 文件.asm"\r\n.text\r\nmain:\r\n    nop\r\n', 'utf8');
      await fs.promises.writeFile(includeUri, '    ori $t1, $0, 7\r\n', 'utf8');
      const outputUri = URI.file(path.join(projectDir, 'code.txt'));
      const request: AssembleRequest = {
        sourceUri,
        target: { kind: 'userText', outputFile: outputUri },
        requirements: { profile: 'P3', pseudoInstructions: true }
      };
      const provider = new BuiltinTsAssemblerProvider();
      expect((await provider.preflight(request)).ok).toBe(true);
      const result = await provider.assemble(request);
      if (!result.ok) console.error(result.status.stderr);
      expect(result.ok).toBe(true);
      expect(result.image!.inputGraph).toHaveLength(2);
      const words = result.image!.segments.find((segment) => segment.name === 'text')!.words;
      expect(words.map((word) => word.toString(16).padStart(8, '0'))).toEqual(['34090007', '00000000']);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed without an image for an unknown instruction', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-builtin-assembler-test-'));
    try {
      const sourceUri = URI.file(path.join(directory, 'bad.asm'));
      await fs.promises.writeFile(sourceUri.fsPath, '.text\n    nope $t0\n', 'utf8');
      const request: AssembleRequest = {
        sourceUri,
        target: { kind: 'userText' },
        requirements: { profile: 'P3' }
      };
      const provider = new BuiltinTsAssemblerProvider();
      expect((await provider.preflight(request)).ok).toBe(true);
      const result = await provider.assemble(request);
      expect(result.ok).toBe(false);
      expect(result.image).toBeUndefined();
      expect(result.status.stderr).toMatch(/\[asm\./);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
