import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { URI } from 'vscode-uri';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

import * as vscode from 'vscode';
import {
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  recordAsmCaseOracleResult,
  updateAsmCaseArtifacts
} from '../../asmCaseStore';
import { BuiltinTsAssemblerProvider } from '../../mips/providers/builtinAssemblerProvider';
import { BuiltinTsExecutionProvider } from '../../mips/providers/builtinExecutionProvider';
import { executeWithPreflight, setProviderRegistry } from '../../mips/providers/providerResolver';
import {
  createDefaultReplayAdapterRegistry,
  exactReplayCase,
  ImmutableEngineArtifactRegistry,
  workspaceEngineRegistryRoot
} from '../../mips/replay';
import type { AppServices } from '../../types';
import { isKnownManifest } from '../../courseTesting/manifestCodec';

const temporaryRoots: string[] = [];

afterEach(() => {
  setProviderRegistry(undefined);
  vscodeState.state!.workspaceFolders.splice(0);
  vscodeState.state!.config.clear();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('builtin case capture and exact replay', () => {
  for (const withInclude of [false, true]) {
    it(`replays the archived original source graph ${withInclude ? 'with an include' : 'without includes'}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-builtin-case-replay-'));
      temporaryRoots.push(root);
      const sourceDir = path.join(root, 'source');
      fs.mkdirSync(sourceDir);
      const sourceFile = path.join(sourceDir, 'main.asm');
      const prefix = withInclude ? '.include "lib.asm"\n' : 'ori $t0, $0, 42\n';
      fs.writeFileSync(sourceFile, [
        '.text',
        prefix.trimEnd(),
        'halt:',
        '    beq $0, $0, halt',
        '    nop',
        ''
      ].join('\n'));
      if (withInclude) fs.writeFileSync(path.join(sourceDir, 'lib.asm'), 'ori $t0, $0, 42\n');

      vscodeState.state!.workspaceFolders.push({ uri: URI.file(root), name: 'fixture' });
      vscodeState.state!.config.set('co.project.profile', 'P3');
      vi.mocked(vscode.workspace.fs.createDirectory).mockImplementation(async (uri) => {
        await fs.promises.mkdir(uri.fsPath, { recursive: true });
      });
      vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(async (uri, bytes) => {
        await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fs.promises.writeFile(uri.fsPath, bytes);
      });
      vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri) =>
        await fs.promises.readFile(uri.fsPath));
      vi.mocked(vscode.workspace.fs.stat).mockImplementation(async (uri) => {
        const stat = await fs.promises.stat(uri.fsPath);
        return { mtime: stat.mtimeMs, type: stat.isDirectory() ? 2 : 1 } as never;
      });

      const assembler = new BuiltinTsAssemblerProvider();
      const executor = new BuiltinTsExecutionProvider();
      setProviderRegistry({ assemblerProviders: [assembler], executionProviders: [executor] });
      const services = {
        output: { appendLine: vi.fn() },
        statusBar: {}
      } as unknown as AppServices;

      const asmCase = await createAsmCaseFromAsm(URI.file(sourceFile), {
        resource: URI.file(sourceFile),
        source: { kind: 'selected' }
      });
      const assembled = await prepareAsmCaseMachineCode(services, asmCase, { courseTrace: true });
      expect(assembled?.ok, assembled?.status.stderr).toBe(true);
      expect(assembled?.image).toBeDefined();
      expect(assembled?.executionBinding).toBeUndefined();
      expect(assembled?.image?.inputGraph.map((unit) => unit.uri)).toEqual(
        withInclude
          ? [pathToFileURL(sourceFile).toString(), pathToFileURL(path.join(sourceDir, 'lib.asm')).toString()]
          : [pathToFileURL(sourceFile).toString()]
      );

      const oracleDir = path.join(asmCase.dir.fsPath, 'oracle');
      fs.mkdirSync(oracleDir);
      const oracleFile = URI.file(path.join(oracleDir, 'builtin.out'));
      const invocation = await executeWithPreflight(services, {
        image: assembled!.image!,
        profile: 'P3',
        memoryConfiguration: 'course-contract-v1',
        trace: { kind: 'architectural-writes', courseCorrect: true },
        maxSteps: 64,
        haltPc: assembled!.courseHaltPc,
        runOutputFile: oracleFile,
        courseTrace: true,
        requirements: {
          profile: 'P3',
          instructionLayers: ['required', 'commonExtensions', 'marsCompatibility'],
          eventSchemaRevision: 1
        }
      });
      expect(
        invocation.preflight.ok,
        invocation.preflight.diagnostics.map((item) => `[${item.code}] ${item.message}`).join('\n')
      ).toBe(true);
      const oracle = invocation.result!;
      expect(oracle.ok, oracle.status.stderr).toBe(true);
      expect(oracle.eventArtifact).toBeDefined();
      await updateAsmCaseArtifacts(asmCase, 'oracle', {
        traceOut: oracle.outputFile!.fsPath,
        events: oracle.eventArtifact!.fsPath
      });
      await recordAsmCaseOracleResult(asmCase, oracle, {
        profile: 'P3',
        memoryConfiguration: 'course-contract-v1',
        courseTrace: true,
        traceOutput: true,
        traceLevel: 1,
        maxSteps: 64,
        haltPc: assembled!.courseHaltPc
      }, { stopReason: 'halt-loop' });
      expect(
        isKnownManifest(asmCase.manifest),
        JSON.stringify(asmCase.manifest, null, 2)
      ).toBe(true);

      fs.rmSync(sourceFile);
      if (withInclude) fs.rmSync(path.join(sourceDir, 'lib.asm'));
      const freshRegistry = new ImmutableEngineArtifactRegistry(
        workspaceEngineRegistryRoot(root),
        root
      );
      const replayed = await exactReplayCase(
        asmCase.dir.fsPath,
        freshRegistry,
        createDefaultReplayAdapterRegistry('java')
      );
      expect(replayed.ok, replayed.issues.join('\n')).toBe(true);
      expect(replayed.issues).toEqual([]);
      expect(replayed.assembly?.imageFingerprint).toBe(assembled!.image!.fingerprint);
      expect(replayed.oracle).toMatchObject({
        eventDigest: oracle.eventDigest,
        finalStateDigest: oracle.finalStateDigest,
        steps: oracle.instructions,
        eventCount: oracle.eventCount
      });
    });
  }
});
