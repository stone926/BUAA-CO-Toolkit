import * as fs from 'fs/promises';
import { promises as nativeFs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsmCaseFromAsm, asmCaseSourceSnapshotIssue, type AsmCase } from '../../asmCaseStore';
import { getProfile } from '../../config';
import { rerunCourseTestCase } from '../../courseTesting/caseRerun';
import { defaultCourseTracePipeline, runCourseTraceCase } from '../../courseTesting/traceRunner';
import { resolveP3LogisimTraceSetup } from '../../courseTestLogisim';
import { captureSourceGraph, loadVerifiedSourceGraphInput } from '../../mips/replay/sourceBundle';
import { sha256Bytes } from '../../asmCaseStoreCore';
import { resolveCourseEnginePlan } from '../../mips/providers/courseEnginePolicy';
import { createTestServices } from '../helpers/appServices';
import { runVerilogSimulation } from '../../verilog/simulationRunner';
import { createTestRunResult } from '../helpers/appServices';

const mock = vi.hoisted(() => ({ state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined }));
vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  mock.state = createVscodeMockState();
  return createVscodeModuleMock(mock.state, vi.fn);
});
vi.mock('../../config', async (original) => ({
  ...await original<typeof import('../../config')>(),
  getProfile: vi.fn(() => 'P7'),
  getMemoryConfiguration: vi.fn(() => 'CompactLargeText')
}));
vi.mock('../../courseTesting/traceRunner', () => ({
  runCourseTraceCase: vi.fn(), defaultCourseTracePipeline: vi.fn()
}));
vi.mock('../../courseTestLogisim', () => ({ resolveP3LogisimTraceSetup: vi.fn() }));
vi.mock('../../verilog/simulationRunner', () => ({ runVerilogSimulation: vi.fn() }));

describe('saved automatic case rerun', () => {
  let root: string;
  const services = createTestServices();
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'co 重跑 case-'));
    mock.state!.workspaceFolders.push({ uri: vscode.Uri.file(root) });
    vi.mocked(getProfile).mockReturnValue('P7');
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(async (uri, bytes) => { await fs.writeFile(uri.fsPath, bytes); });
    vi.mocked(vscode.workspace.fs.createDirectory).mockImplementation(async (uri) => { await fs.mkdir(uri.fsPath, { recursive: true }); });
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri) => await fs.readFile(uri.fsPath));
    vi.mocked(runCourseTraceCase).mockImplementation(async (_services, item) => ({
      asm: item.asm.fsPath, caseId: item.asmCase!.id, caseManifest: item.asmCase!.manifestUri.fsPath,
      status: 'failed', stage: 'compare', message: 'CPU difference'
    }));
  });
  afterEach(async () => {
    mock.state!.workspaceFolders.splice(0);
    await fs.rm(root, { recursive: true, force: true });
  });

  async function savedCase(stdin = false): Promise<AsmCase> {
    const file = path.join(root, 'original.asm');
    await fs.writeFile(file, '.text\n.include "payload.asm"\n_co_test_end:\nbeq $0,$0,_co_test_end\nnop\n');
    await fs.writeFile(path.join(root, 'payload.asm'), 'ori $t0,$0,1\n');
    const input = stdin ? path.join(root, 'input.txt') : undefined;
    if (input) await fs.writeFile(input, '7\n');
    return await createAsmCaseFromAsm(vscode.Uri.file(file), {
      source: { kind: 'builtin', generator: 'builtin:random-asm' },
      enginePlan: resolveCourseEnginePlan('auto', getProfile(vscode.Uri.file(file)), { deterministicConsole: stdin }),
      stdin: input ? vscode.Uri.file(input) : undefined,
      p7: { interruptSchedule: [0x3004] },
      metadata: { 'source.seed': '123', 'source.instructionCount': '1118', 'source.sessionId': 'old-session', 'test.status': 'failed' }
    });
  }

  it('copies the verified include/stdin closure after original inputs are deleted and preserves old evidence', async () => {
    const original = await savedCase(true);
    const manifestBytes = await fs.readFile(original.manifestUri.fsPath);
    await fs.unlink(path.join(root, 'original.asm'));
    await fs.unlink(path.join(root, 'payload.asm'));
    await fs.unlink(path.join(root, 'input.txt'));
    const output = await rerunCourseTestCase(services, original);
    expect(output.result.status, output.result.message).toBe('failed');
    expect(output.result.caseId).not.toBe(original.id);
    const [, item, options] = vi.mocked(runCourseTraceCase).mock.calls[0];
    expect(options).toMatchObject({ source: { kind: 'generator' }, artifactOutputMode: 'case' });
    const copied = item.asmCase!;
    expect(await asmCaseSourceSnapshotIssue(copied)).toBeUndefined();
    const manifest = copied.manifest;
    if (manifest.version !== 2) throw new Error('Expected v2');
    const graph = await loadVerifiedSourceGraphInput(copied.dir.fsPath, manifest.program.sourceGraph!.path);
    expect(original.manifest.version).toBe(2);
    if (original.manifest.version !== 2) throw new Error('Expected v2');
    const archived = await loadVerifiedSourceGraphInput(original.dir.fsPath, original.manifest.program.sourceGraph!.path);
    expect(graph.sourceGraphInput).toEqual(archived.sourceGraphInput);
    expect(graph.graph.graphFingerprint).toBe(archived.graph.graphFingerprint);
    expect(await fs.readFile(copied.stdin!.fsPath, 'utf8')).toBe('7\n');
    expect(item.stdin?.fsPath).toBe(original.stdin!.fsPath);
    expect(manifest.stdin).toEqual({ ...original.manifest.stdin, originalPath: original.stdin!.fsPath });
    expect(manifest.metadata).toMatchObject({ 'source.seed': '123', 'source.instructionCount': '1118', 'rerun.originalCaseId': original.id });
    expect(manifest.metadata?.['source.sessionId']).toBeUndefined();
    expect(manifest.metadata?.['test.status']).toBeUndefined();
    expect(manifest.p7?.interruptSchedule).toEqual([0x3004]);
    expect(manifest.oracle.engine.id).toContain('builtin');
    expect(await fs.readFile(original.manifestUri.fsPath)).toEqual(manifestBytes);
    expect(defaultCourseTracePipeline).not.toHaveBeenCalled();
  });

  it('reruns an old three-file single-source case with one independent ASM snapshot', async () => {
    const file = path.join(root, 'old.asm');
    const text = '.text\n_co_test_end:\nbeq $0,$0,_co_test_end\nnop\n';
    await fs.writeFile(file, text);
    const original = await createAsmCaseFromAsm(vscode.Uri.file(file));
    if (original.manifest.version !== 2) throw new Error('Expected v2');
    const graphFile = path.join(original.dir.fsPath, 'source', 'graph.json');
    await fs.chmod(graphFile, 0o644);
    await fs.unlink(graphFile);
    const legacy = await captureSourceGraph(file, original.dir.fsPath);
    const graphBytes = await fs.readFile(legacy.graphPath);
    const snapshot = { path: 'source/graph.json', bytes: graphBytes.byteLength, sha256: sha256Bytes(graphBytes) };
    const unit = legacy.graph.units[0];
    original.manifest.program.sourceGraph = snapshot;
    original.manifest.artifacts!.source = {
      graph: snapshot,
      [`blob/${unit.contentHash}`]: { ...original.manifest.asmSnapshot, path: unit.blobPath },
      [`materialized/${unit.id}`]: { ...original.manifest.asmSnapshot, path: unit.materializedPath }
    };
    original.sourceAsm = vscode.Uri.file(legacy.rootMaterializedPath);
    await fs.writeFile(original.manifestUri.fsPath, JSON.stringify(original.manifest));
    expect(original.sourceAsm.fsPath).not.toBe(original.asm.fsPath);
    await fs.unlink(file);

    const { result } = await rerunCourseTestCase(services, original);
    expect(result.stage, result.message).toBe('compare');
    const rerun = vi.mocked(runCourseTraceCase).mock.calls[0][1].asmCase!;
    expect(rerun.sourceAsm.fsPath).toBe(rerun.asm.fsPath);
    expect(rerun.asm.fsPath).not.toBe(original.asm.fsPath);
    expect(await fs.readFile(rerun.asm.fsPath, 'utf8')).toBe(text);
    expect(await fs.readdir(path.join(rerun.dir.fsPath, 'source'))).toEqual(['graph.json']);
    expect(await asmCaseSourceSnapshotIssue(rerun)).toBeUndefined();
  });

  it('refuses a changed course profile without creating a result bound to the original case', async () => {
    const original = await savedCase();
    vi.mocked(getProfile).mockReturnValue('P5');
    const { result } = await rerunCourseTestCase(services, original);
    expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('与原用例') });
    expect(result.caseId).toBeUndefined();
    expect(runCourseTraceCase).not.toHaveBeenCalled();
  });

  it.each(['source', 'stdin'] as const)('refuses altered saved %s bytes before executing or replacing the old case', async (kind) => {
    const original = await savedCase(true);
    const tampered = kind === 'source' ? original.sourceAsm.fsPath : original.stdin!.fsPath;
    await fs.chmod(tampered, 0o644);
    await fs.writeFile(tampered, 'tampered');
    const { result } = await rerunCourseTestCase(services, original);
    expect(result.status).toBe('error');
    expect(result.caseId).toBeUndefined();
    expect(runCourseTraceCase).not.toHaveBeenCalled();
    expect(await fs.readdir(path.dirname(original.dir.fsPath))).toHaveLength(1);
  });

  it('rejects stdin altered only during the archive copy and leaves no new case', async () => {
    const original = await savedCase(true);
    const archive = original.stdin!.fsPath;
    const graph = path.join(original.dir.fsPath, 'source', 'graph.json');
    const open = nativeFs.open.bind(nativeFs);
    let copyStarted = false;
    const fileOpen = vi.spyOn(nativeFs, 'open').mockImplementation(async (file, ...options) => {
      if (typeof file === 'string' && path.relative(graph, file) === '') {
        copyStarted = true;
        await fs.writeFile(archive, '9\n');
      }
      const handle = await open(file, ...options);
      if (copyStarted && typeof file === 'string' && path.relative(archive, file) === '') {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          await fs.writeFile(archive, '7\n');
        });
      }
      return handle;
    });
    try {
      const { result } = await rerunCourseTestCase(services, original);
      expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('stdin snapshot 已偏离 case manifest') });
      expect(runCourseTraceCase).not.toHaveBeenCalled();
      expect(await fs.readdir(path.dirname(original.dir.fsPath))).toEqual([original.id]);
    } finally { fileOpen.mockRestore(); }
    expect(await fs.readFile(archive, 'utf8')).toBe('7\n');
  });

  it('routes P3 through the existing Logisim setup and refuses VCD capture', async () => {
    vi.mocked(getProfile).mockReturnValue('P3');
    const original = await savedCase();
    const setup = { circuit: vscode.Uri.file(path.join(root, 'cpu.circ')) } as never;
    vi.mocked(resolveP3LogisimTraceSetup).mockResolvedValue(setup);
    await rerunCourseTestCase(services, original);
    expect(resolveP3LogisimTraceSetup).toHaveBeenCalledWith(services, expect.anything(), { nonInteractive: true });
    expect(vi.mocked(runCourseTraceCase).mock.calls[0][2]?.logisim).toBe(setup);
    vi.mocked(runCourseTraceCase).mockClear();
    const { result } = await rerunCourseTestCase(services, original, { waveform: true });
    expect(result.message).toContain('仅适用于 P4–P7');
    expect(runCourseTraceCase).not.toHaveBeenCalled();
  });

  it('cancels before capture without recording an error on the archived case', async () => {
    const original = await savedCase();
    const controller = new AbortController();
    controller.abort();
    const { result } = await rerunCourseTestCase(services, original, { signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.caseId).toBeUndefined();
    expect(runCourseTraceCase).not.toHaveBeenCalled();
  });

  it('preserves the CPU failure verdict when waveform capture fails', async () => {
    const original = await savedCase();
    vi.mocked(defaultCourseTracePipeline).mockImplementation((overrides) => overrides as never);
    vi.mocked(runVerilogSimulation).mockImplementation(async (_services, options) => {
      const output = {
        generated: { outDir: vscode.Uri.file(root) }, compileResult: createTestRunResult(),
        simResult: createTestRunResult({ stdout: 'CPU output without a dump declaration' })
      } as never;
      await options?.onSimulationComplete?.(output);
      return output;
    });
    vi.mocked(runCourseTraceCase).mockImplementation(async (_services, item, options) => {
      await options!.pipeline!.runDut(services, { nonInteractive: true });
      return { asm: item.asm.fsPath, caseId: item.asmCase!.id, status: 'failed', stage: 'compare', message: 'CPU difference' };
    });
    const output = await rerunCourseTestCase(services, original, { waveform: true });
    expect(output.result).toMatchObject({ status: 'failed', stage: 'compare', message: 'CPU difference' });
    expect(output.waveform).toBeUndefined();
    expect(output.waveformIssue).toContain('没有声明打开');
  });

  it('marks a new cancelled case without modifying old evidence or claiming a CPU error', async () => {
    const original = await savedCase();
    const originalBytes = await fs.readFile(original.manifestUri.fsPath);
    vi.mocked(runCourseTraceCase).mockImplementation(async (_services, item) => ({
      asm: item.asm.fsPath, caseId: item.asmCase!.id, status: 'error', cancelled: true,
      stage: 'dut', message: '测试已取消'
    }));
    const { result } = await rerunCourseTestCase(services, original);
    expect(result.cancelled).toBe(true);
    const copied = vi.mocked(runCourseTraceCase).mock.calls[0][1].asmCase!;
    if (copied.manifest.version !== 2) throw new Error('Expected v2');
    expect(copied.manifest.metadata?.['rerun.state']).toBe('cancelled');
    expect(copied.manifest.metadata?.['test.status']).toBeUndefined();
    expect(await fs.readFile(original.manifestUri.fsPath)).toEqual(originalBytes);
  });

  it('refuses early manifests with no saved include graph', async () => {
    const original = await savedCase();
    if (original.manifest.version !== 2) throw new Error('Expected v2');
    delete original.manifest.program.sourceGraph;
    const { result } = await rerunCourseTestCase(services, original);
    expect(result.message).toContain('没有保存完整的 ASM/include 闭包');
    expect(result.caseId).toBeUndefined();
    expect(runCourseTraceCase).not.toHaveBeenCalled();
  });

  it('binds the otherwise valid graph to its original manifest fingerprint', async () => {
    const original = await savedCase();
    if (original.manifest.version !== 2) throw new Error('Expected v2');
    original.manifest.program.sourceGraph!.sha256 = 'f'.repeat(64);
    expect(await asmCaseSourceSnapshotIssue(original)).toContain('已偏离 manifest 指纹');
    const { result } = await rerunCourseTestCase(services, original);
    expect(result.message).toContain('已偏离 manifest 指纹');
    expect(runCourseTraceCase).not.toHaveBeenCalled();
  });
});
