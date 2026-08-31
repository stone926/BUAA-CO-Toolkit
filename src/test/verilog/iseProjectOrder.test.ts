import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import {
  orderIseProjectFiles,
  parseXiseVerilogFileOrder
} from '../../verilog/iseProjectOrder';
import {
  clearIseProjectDiscoveryCache,
  invalidateIseProjectDiscoveryCachesForUri,
  isIseProjectDiscoveryCandidate,
  maximumIseProjectDiscoveryCacheWorkspaces,
  resolveIseProjectFiles,
  verilogProjectSignature
} from '../../verilog/iseProject';
import { verilogProjectExcludeGlob } from '../../verilogSimulationFiles';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined,
  module: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeModuleMock> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  vscodeState.module = createVscodeModuleMock(vscodeState.state, vi.fn);
  return vscodeState.module;
});

const folder = { uri: URI.file('E:/work'), name: 'work', index: 0 };

describe('ISE project source ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearIseProjectDiscoveryCache();
    vscodeState.state!.workspaceFolders.splice(0, vscodeState.state!.workspaceFolders.length, folder);
  });

  it('parses FILE_VERILOG paths and falls back to document order without sequence IDs', () => {
    const text = `
<project xmlns:xil_pn="http://www.xilinx.com/XMLSchema"><files>
  <file xil_pn:name="timer.v" xil_pn:type="FILE_VERILOG" />
  <file xil_pn:type='FILE_VERILOG' xil_pn:name='sub/cpu&amp;bridge.v' />
  <file xil_pn:name="constraints.ucf" xil_pn:type="FILE_UCF" />
</files></project>`;

    expect(parseXiseVerilogFileOrder(text, 'E:\\work\\cpu\\cpu.xise')).toEqual([
      'E:\\work\\cpu\\timer.v',
      'E:\\work\\cpu\\sub\\cpu&bridge.v'
    ]);
  });

  it('uses BehavioralSimulation seqID instead of file document order', () => {
    const text = `
<files>
  <file xil_pn:name="mips.v" xil_pn:type="FILE_VERILOG">
    <association xil_pn:name="BehavioralSimulation" xil_pn:seqID="19" />
  </file>
  <file xil_pn:name="Bridge.v" xil_pn:type="FILE_VERILOG">
    <association xil_pn:name="Implementation" xil_pn:seqID="0" />
    <association xil_pn:name="BehavioralSimulation" xil_pn:seqID="18" />
  </file>
  <file xil_pn:name="timer.v" xil_pn:type="FILE_VERILOG">
    <association xil_pn:name="BehavioralSimulation" xil_pn:seqID="16" />
  </file>
</files>`;

    expect(parseXiseVerilogFileOrder(text, 'E:\\work\\cpu\\cpu.xise')).toEqual([
      'E:\\work\\cpu\\timer.v',
      'E:\\work\\cpu\\Bridge.v',
      'E:\\work\\cpu\\mips.v'
    ]);
  });

  it('keeps document order when sequence IDs are missing or duplicated', () => {
    const duplicate = `
      <file xil_pn:name="mips.v" xil_pn:type="FILE_VERILOG"><association xil_pn:name="BehavioralSimulation" xil_pn:seqID="1" /></file>
      <file xil_pn:name="timer.v" xil_pn:type="FILE_VERILOG"><association xil_pn:name="BehavioralSimulation" xil_pn:seqID="1" /></file>`;
    const missing = `
      <file xil_pn:name="mips.v" xil_pn:type="FILE_VERILOG"><association xil_pn:name="BehavioralSimulation" xil_pn:seqID="2" /></file>
      <file xil_pn:name="timer.v" xil_pn:type="FILE_VERILOG" />`;

    expect(parseXiseVerilogFileOrder(duplicate, 'E:\\work\\cpu\\cpu.xise')).toEqual([
      'E:\\work\\cpu\\mips.v',
      'E:\\work\\cpu\\timer.v'
    ]);
    expect(parseXiseVerilogFileOrder(missing, 'E:\\work\\cpu\\cpu.xise')).toEqual([
      'E:\\work\\cpu\\mips.v',
      'E:\\work\\cpu\\timer.v'
    ]);
  });

  it('puts stable unlisted files first, preserves XISE order, and keeps generated extras last', () => {
    const timer = URI.file('E:/work/cpu/timer.v');
    const mips = URI.file('E:/work/cpu/mips.v');
    const unlistedZ = URI.file('E:/work/z_helper.v');
    const unlistedA = URI.file('E:/work/a_helper.v');
    const generated = URI.file('E:/work/.co/isim/co_generated_tb.v');

    expect(orderIseProjectFiles(
      [mips, unlistedZ, timer, unlistedA],
      [timer.fsPath, mips.fsPath],
      [generated]
    ).map((uri) => uri.fsPath)).toEqual([
      unlistedA.fsPath,
      unlistedZ.fsPath,
      timer.fsPath,
      mips.fsPath,
      generated.fsPath
    ]);
  });

  it('uses the unique XISE order during workspace resolution', async () => {
    const timer = URI.file('E:/work/cpu/timer.v');
    const mips = URI.file('E:/work/cpu/mips.v');
    const helper = URI.file('E:/work/helper.v');
    const generated = URI.file('E:/work/.co/isim/co_generated_tb.v');
    const xise = URI.file('E:/work/cpu/cpu.xise');
    vscodeState.module!.workspace.findFiles
      .mockResolvedValueOnce([mips, helper, timer])
      .mockResolvedValueOnce([xise]);
    vscodeState.module!.workspace.fs.readFile.mockResolvedValueOnce(Buffer.from(`
      <file xil_pn:name="mips.v" xil_pn:type="FILE_VERILOG"><association xil_pn:name="BehavioralSimulation" xil_pn:seqID="2" /></file>
      <file xil_pn:name="timer.v" xil_pn:type="FILE_VERILOG"><association xil_pn:name="BehavioralSimulation" xil_pn:seqID="1" /></file>
    `));

    await expect(resolveIseProjectFiles(folder as never, [generated])).resolves.toEqual([
      helper,
      timer,
      mips,
      generated
    ]);
  });

  it('invalidates only files that can change the cached discovery baseline', () => {
    expect(isIseProjectDiscoveryCandidate(folder as never, URI.file('E:/work/rtl/dut.v'))).toBe(true);
    expect(isIseProjectDiscoveryCandidate(folder as never, URI.file('E:/work/cpu.xise'))).toBe(true);
    expect(isIseProjectDiscoveryCandidate(folder as never, URI.file('E:/work/rtl/defs.vh'))).toBe(false);
    expect(isIseProjectDiscoveryCandidate(folder as never, URI.file('E:/outside/dut.v'))).toBe(false);

    const excludedDirectories = /\{([^{}]+)\}/.exec(verilogProjectExcludeGlob)?.[1].split(',') ?? [];
    expect(excludedDirectories.length).toBeGreaterThan(0);
    for (const directory of excludedDirectories) {
      expect(isIseProjectDiscoveryCandidate(
        folder as never,
        URI.file(`E:/work/${directory}/ignored.v`)
      )).toBe(false);
    }
  });

  it('reuses workspace discovery and XISE parsing while recomputing extras and exclusions', async () => {
    const dut = URI.file('E:/work/dut.v');
    const helper = URI.file('E:/work/helper.v');
    const userTestbench = URI.file('E:/work/dut_tb.v');
    const firstGenerated = URI.file('E:/work/.co/isim/generated_first.v');
    const secondGenerated = URI.file('E:/work/.co/isim/generated_second.v');
    const xise = URI.file('E:/work/cpu.xise');
    vscodeState.module!.workspace.findFiles
      .mockResolvedValueOnce([userTestbench, dut, helper])
      .mockResolvedValueOnce([xise]);
    vscodeState.module!.workspace.fs.readFile.mockResolvedValueOnce(Buffer.from(`
      <file xil_pn:name="dut.v" xil_pn:type="FILE_VERILOG" />
    `));

    await expect(resolveIseProjectFiles(folder as never, [firstGenerated], {
      excludedBasenames: ['DUT_TB.V']
    })).resolves.toEqual([helper, dut, firstGenerated]);
    await expect(resolveIseProjectFiles(folder as never, [secondGenerated], {
      excludedFiles: [helper]
    })).resolves.toEqual([userTestbench, dut, secondGenerated]);

    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(vscodeState.module!.workspace.fs.readFile).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent first discovery for the same workspace', async () => {
    const dut = URI.file('E:/work/dut.v');
    let releaseSources!: (sources: URI[]) => void;
    const sources = new Promise<URI[]>((resolve) => {
      releaseSources = resolve;
    });
    vscodeState.module!.workspace.findFiles
      .mockImplementationOnce(() => sources)
      .mockResolvedValueOnce([]);

    const first = resolveIseProjectFiles(folder as never, []);
    const second = resolveIseProjectFiles(folder as never, []);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(2);
    releaseSources([dut]);

    await expect(Promise.all([first, second])).resolves.toEqual([[dut], [dut]]);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(2);
  });

  it('uses an unreadable unique XISE as a one-call fallback instead of caching the failure', async () => {
    const dut = URI.file('E:/work/dut.v');
    const xise = URI.file('E:/work/cpu.xise');
    vscodeState.module!.workspace.findFiles
      .mockResolvedValueOnce([dut])
      .mockResolvedValueOnce([xise])
      .mockResolvedValueOnce([dut])
      .mockResolvedValueOnce([xise]);
    vscodeState.module!.workspace.fs.readFile
      .mockRejectedValueOnce(new Error('temporarily locked'))
      .mockResolvedValueOnce(Buffer.from(''));

    await expect(resolveIseProjectFiles(folder as never, [])).resolves.toEqual([dut]);
    await expect(resolveIseProjectFiles(folder as never, [])).resolves.toEqual([dut]);

    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(4);
    expect(vscodeState.module!.workspace.fs.readFile).toHaveBeenCalledTimes(2);
  });

  it('clears only the requested workspace and retries an invalidated pending scan', async () => {
    const folderB = { uri: URI.file('E:/other'), name: 'other', index: 1 };
    const stale = URI.file('E:/work/stale.v');
    const current = URI.file('E:/work/current.v');
    const other = URI.file('E:/other/other.v');
    let releaseStale!: (sources: URI[]) => void;
    const staleSources = new Promise<URI[]>((resolve) => {
      releaseStale = resolve;
    });
    let workSourceScan = 0;
    vscodeState.module!.workspace.findFiles.mockImplementation(async (include) => {
      const pattern = (include as { pattern: string }).pattern;
      if (pattern === '**/*.xise') {
        return [];
      }
      const base = (include as { base: { uri: URI } }).base.uri.fsPath.toLowerCase();
      if (base.includes('other')) {
        return [other];
      }
      workSourceScan += 1;
      return workSourceScan === 1 ? staleSources : [current];
    });

    const pending = resolveIseProjectFiles(folder as never, []);
    clearIseProjectDiscoveryCache(folder.uri.fsPath);
    releaseStale([stale]);
    await expect(pending).resolves.toEqual([current]);
    await expect(resolveIseProjectFiles(folderB as never, [])).resolves.toEqual([other]);
    const callsAfterBothBaselines = vscodeState.module!.workspace.findFiles.mock.calls.length;

    clearIseProjectDiscoveryCache(folder.uri.fsPath);
    await expect(resolveIseProjectFiles(folderB as never, [])).resolves.toEqual([other]);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(callsAfterBothBaselines);
    await expect(resolveIseProjectFiles(folder as never, [])).resolves.toEqual([current]);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(callsAfterBothBaselines + 2);
  });

  it('invalidates every nested workspace whose discovery baseline contains the changed path', async () => {
    const child = { uri: URI.file('E:/work/sub'), name: 'sub', index: 1 };
    const parentDut = URI.file('E:/work/parent.v');
    const childDut = URI.file('E:/work/sub/child.v');
    vscodeState.module!.workspace.findFiles.mockImplementation(async (include) => {
      const pattern = (include as { pattern: string }).pattern;
      if (pattern === '**/*.xise') return [];
      const base = (include as { base: { uri: URI } }).base.uri.fsPath.toLowerCase();
      return base.endsWith('sub') ? [childDut] : [parentDut, childDut];
    });

    await resolveIseProjectFiles(folder as never, []);
    await resolveIseProjectFiles(child as never, []);
    const callsAfterFill = vscodeState.module!.workspace.findFiles.mock.calls.length;

    expect(invalidateIseProjectDiscoveryCachesForUri(
      [folder, child] as never,
      URI.file('E:/work/sub/new.v')
    )).toBe(2);
    await resolveIseProjectFiles(folder as never, []);
    await resolveIseProjectFiles(child as never, []);

    expect(vscodeState.module!.workspace.findFiles)
      .toHaveBeenCalledTimes(callsAfterFill + 4);
  });

  it('evicts the least recently used workspace after the session bound', async () => {
    const roots = Array.from(
      { length: maximumIseProjectDiscoveryCacheWorkspaces + 1 },
      (_, index) => ({ uri: URI.file(`E:/workspace-${index}`), name: `workspace-${index}`, index })
    );
    vscodeState.module!.workspace.findFiles.mockImplementation(async (include) => {
      const pattern = (include as { pattern: string }).pattern;
      if (pattern === '**/*.xise') {
        return [];
      }
      const base = (include as { base: { uri: URI } }).base.uri.fsPath;
      return [URI.file(`${base}/dut.v`)];
    });

    for (const workspace of roots) {
      await resolveIseProjectFiles(workspace as never, []);
    }
    const callsAfterFill = vscodeState.module!.workspace.findFiles.mock.calls.length;
    expect(callsAfterFill).toBe(roots.length * 2);

    await resolveIseProjectFiles(roots.at(-1)! as never, []);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(callsAfterFill);
    await resolveIseProjectFiles(roots[0] as never, []);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(callsAfterFill + 2);
  });

  it('falls back to stable path order without a unique XISE and includes order in cache signatures', async () => {
    const z = URI.file('E:/work/z.v');
    const a = URI.file('E:/work/a.v');
    const generated = URI.file('E:/work/.co/isim/co_generated_tb.v');
    vscodeState.module!.workspace.findFiles
      .mockResolvedValueOnce([z, a])
      .mockResolvedValueOnce([]);

    await expect(resolveIseProjectFiles(folder as never, [generated])).resolves.toEqual([a, z, generated]);
    const forward = await verilogProjectSignature([a, z]);
    const reverse = await verilogProjectSignature([z, a]);
    expect(forward).not.toBe(reverse);
  });

  it('excludes configured user testbenches while preserving DUT and generated automatic sources', async () => {
    const dut = URI.file('E:/work/mips.v');
    const userTestbench = URI.file('E:/work/mips_tb.v');
    const alternateTestbench = URI.file('E:/work/test/custom.v');
    const generated = URI.file('E:/work/.co/isim/co_generated_auto_tb.v');
    vscodeState.module!.workspace.findFiles
      .mockResolvedValueOnce([userTestbench, alternateTestbench, dut])
      .mockResolvedValueOnce([]);

    await expect(resolveIseProjectFiles(folder as never, [generated], {
      excludedFiles: [alternateTestbench],
      excludedBasenames: ['mips_tb.v'],
      protectedFiles: [dut]
    })).resolves.toEqual([dut, generated]);
  });
});
