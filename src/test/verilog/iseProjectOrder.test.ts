import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import {
  orderIseProjectFiles,
  parseXiseVerilogFileOrder
} from '../../verilog/iseProjectOrder';
import {
  resolveIseProjectFiles,
  verilogProjectSignature
} from '../../verilog/iseProject';

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
});
