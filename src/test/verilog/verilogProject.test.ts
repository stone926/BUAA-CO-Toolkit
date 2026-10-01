import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import { orderVerilogProjectFiles } from '../../verilog/verilogProjectOrder';
import {
  clearVerilogProjectDiscoveryCache,
  invalidateVerilogProjectDiscoveryCachesForUri,
  isVerilogProjectDiscoveryCandidate,
  maximumVerilogProjectDiscoveryCacheWorkspaces,
  resolveVerilogProjectFiles
} from '../../verilog/verilogProject';

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

describe('Verilog project source discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearVerilogProjectDiscoveryCache();
    vscodeState.state!.workspaceFolders.splice(0, vscodeState.state!.workspaceFolders.length, folder);
  });

  it('sorts project sources and appends generated sources once', () => {
    const z = URI.file('E:/work/z.v');
    const a = URI.file('E:/work/a.v');
    const generated = URI.file('E:/work/.co/iverilog/generated_tb.v');
    expect(orderVerilogProjectFiles([z, a, z, generated], [generated])).toEqual([a, z, generated]);
  });

  it('caches only discovered files while applying exclusions per call', async () => {
    const a = URI.file('E:/work/a.v');
    const z = URI.file('E:/work/z.v');
    const generated = URI.file('E:/work/.co/iverilog/generated_tb.v');
    vscodeState.module!.workspace.findFiles.mockResolvedValue([z, a]);

    await expect(resolveVerilogProjectFiles(folder as never, [generated], { excludedFiles: [a] }))
      .resolves.toEqual([z, generated]);
    await expect(resolveVerilogProjectFiles(folder as never, [generated]))
      .resolves.toEqual([a, z, generated]);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledOnce();
  });

  it('keeps protected DUT files while excluding user testbenches from automatic compilation', async () => {
    const dut = URI.file('E:/work/mips.v');
    const userTb = URI.file('E:/work/mips_tb.v');
    const unrelatedTb = URI.file('E:/work/other_testbench.v');
    const plainTb = URI.file('E:/work/test/tb.v');
    const plainTestbench = URI.file('E:/work/test/testbench.v');
    const generated = URI.file('E:/work/.co/iverilog/co_generated_auto_tb.v');
    vscodeState.module!.workspace.findFiles.mockResolvedValue([userTb, unrelatedTb, plainTb, plainTestbench, dut]);
    await expect(resolveVerilogProjectFiles(folder as never, [generated], {
      excludedFiles: [dut],
      excludedBasenames: ['mips_tb.v'],
      protectedFiles: [dut],
      excludeCustomTestbenches: true
    })).resolves.toEqual([dut, generated]);
  });

  it.each(['dut_tb.v', 'dut_testbench.v', 'tb.v', 'testbench.v'])(
    'keeps selected %s while excluding unrelated custom testbenches', async (fileName) => {
      const dut = URI.file('E:/work/dut.v');
      const selected = URI.file(`E:/work/${fileName}`);
      const unrelated = URI.file('E:/work/broken_testbench.v');
      vscodeState.module!.workspace.findFiles.mockResolvedValue([unrelated, selected, dut]);
      await expect(resolveVerilogProjectFiles(folder as never, [selected], {
        protectedFiles: [selected], excludeCustomTestbenches: true
      })).resolves.toEqual([dut, selected]);
    }
  );

  it('invalidates on workspace Verilog changes but ignores generated and XISE files', async () => {
    const dut = URI.file('E:/work/dut.v');
    vscodeState.module!.workspace.findFiles.mockResolvedValue([dut]);
    await resolveVerilogProjectFiles(folder as never, []);

    expect(isVerilogProjectDiscoveryCandidate(folder as never, URI.file('E:/work/cpu.xise'))).toBe(false);
    expect(isVerilogProjectDiscoveryCandidate(folder as never, URI.file('E:/work/.co/iverilog/tb.v'))).toBe(false);
    expect(invalidateVerilogProjectDiscoveryCachesForUri([folder as never], dut)).toBe(1);
    await resolveVerilogProjectFiles(folder as never, []);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent discovery for one workspace', async () => {
    const dut = URI.file('E:/work/dut.v');
    let release!: (sources: URI[]) => void;
    vscodeState.module!.workspace.findFiles.mockImplementationOnce(() =>
      new Promise<URI[]>((resolve) => { release = resolve; }));

    const first = resolveVerilogProjectFiles(folder as never, []);
    const second = resolveVerilogProjectFiles(folder as never, []);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledOnce();
    release([dut]);
    await expect(Promise.all([first, second])).resolves.toEqual([[dut], [dut]]);
  });

  it('retries a scan invalidated while discovery was pending', async () => {
    const stale = URI.file('E:/work/stale.v');
    const current = URI.file('E:/work/current.v');
    let release!: (sources: URI[]) => void;
    vscodeState.module!.workspace.findFiles
      .mockImplementationOnce(() => new Promise<URI[]>((resolve) => { release = resolve; }))
      .mockResolvedValueOnce([current]);

    const pending = resolveVerilogProjectFiles(folder as never, []);
    clearVerilogProjectDiscoveryCache(folder.uri.fsPath);
    release([stale]);
    await expect(pending).resolves.toEqual([current]);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(2);
  });

  it('invalidates parent and nested child workspace baselines', async () => {
    const child = { uri: URI.file('E:/work/sub'), name: 'sub', index: 1 };
    vscodeState.module!.workspace.findFiles.mockResolvedValue([]);
    await resolveVerilogProjectFiles(folder as never, []);
    await resolveVerilogProjectFiles(child as never, []);
    expect(invalidateVerilogProjectDiscoveryCachesForUri(
      [folder, child] as never, URI.file('E:/work/sub/new.v')
    )).toBe(2);
    await resolveVerilogProjectFiles(folder as never, []);
    await resolveVerilogProjectFiles(child as never, []);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(4);
  });

  it('evicts the least recently used workspace at the session bound', async () => {
    const roots = Array.from({ length: maximumVerilogProjectDiscoveryCacheWorkspaces + 1 },
      (_, index) => ({ uri: URI.file(`E:/workspace-${index}`), name: `workspace-${index}`, index }));
    vscodeState.module!.workspace.findFiles.mockResolvedValue([]);
    for (const root of roots) await resolveVerilogProjectFiles(root as never, []);
    const calls = vscodeState.module!.workspace.findFiles.mock.calls.length;
    await resolveVerilogProjectFiles(roots.at(-1)! as never, []);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(calls);
    await resolveVerilogProjectFiles(roots[0] as never, []);
    expect(vscodeState.module!.workspace.findFiles).toHaveBeenCalledTimes(calls + 1);
  });
});
