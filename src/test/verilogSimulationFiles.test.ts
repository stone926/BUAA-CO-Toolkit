import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildIseProjectText,
  buildIsimRunTcl,
  buildIsimVcdTcl,
  buildIsimWaveTcl,
  generatedRuntimeTestbenchText,
  generatedTestbenchMarker,
  isGeneratedRuntimeTestbench,
  isUserTestbenchPath,
  p7AutoRuntimeTestbenchName,
  runtimeTestbenchFileName,
  userTestbenchFileName,
  verilogProjectExcludeGlob
} from '../verilogSimulationFiles';

describe('verilog simulation file helpers', () => {
  it('uses stable runtime testbench names', () => {
    expect(runtimeTestbenchFileName('mips_tb')).toBe('co_generated_mips_tb.v');
    expect(runtimeTestbenchFileName('cpu tb')).toBe('co_generated_cpu_tb.v');
    expect(p7AutoRuntimeTestbenchName).toBe('co_generated_p7_auto_tb');
  });

  it('names and recognizes user testbenches under .co/tb', () => {
    expect(userTestbenchFileName('alu_tb')).toBe('alu_tb.v');
    expect(userTestbenchFileName('cpu tb')).toBe('cpu_tb.v');
    const root = path.resolve('work');
    expect(isUserTestbenchPath(root, path.join(root, '.co', 'tb', 'alu_tb.v'))).toBe(true);
    expect(isUserTestbenchPath(root, path.join(root, '.co', 'tb', 'nested', 'x.v'))).toBe(true);
    expect(isUserTestbenchPath(root, path.join(root, '.co', 'tb'))).toBe(false);
    expect(isUserTestbenchPath(root, path.join(root, '.co', 'isim', 'co_generated_alu_tb.v'))).toBe(false);
    expect(isUserTestbenchPath(root, path.join(root, '.co', 'tbx', 'alu_tb.v'))).toBe(false);
    expect(isUserTestbenchPath(root, path.join(root, 'src', '.co', 'tb', 'alu_tb.v'))).toBe(false);
    expect(isUserTestbenchPath(root, path.join(root, 'tb', 'alu_tb.v'))).toBe(false);
    expect(isUserTestbenchPath(root, path.join(path.dirname(root), 'other', '.co', 'tb', 'alu_tb.v'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('matches .co/tb case-insensitively on Windows', () => {
    expect(isUserTestbenchPath('E:\\Work', 'e:\\work\\.CO\\TB\\alu_tb.v')).toBe(true);
  });

  it('marks generated runtime testbenches', () => {
    const text = generatedRuntimeTestbenchText('module mips_tb; endmodule\n');
    expect(text.startsWith(`${generatedTestbenchMarker}\n\`default_nettype wire\n`)).toBe(true);
    expect(isGeneratedRuntimeTestbench(text)).toBe(true);
    expect(isGeneratedRuntimeTestbench('module user_tb; endmodule\n')).toBe(false);
  });

  it('preserves explicit source order in ISE project files', () => {
    expect(verilogProjectExcludeGlob).toContain('.co');
    expect(verilogProjectExcludeGlob).toContain('.vscode');
    expect(verilogProjectExcludeGlob).toContain('.vscode-test');
    const prj = buildIseProjectText([
      'E:\\work\\src\\mips.v',
      'E:\\work\\.co\\isim\\co_generated_mips_tb.v'
    ]);
    expect(prj).toBe([
      'Verilog work "E:/work/src/mips.v"',
      'Verilog work "E:/work/.co/isim/co_generated_mips_tb.v"',
      ''
    ].join('\n'));
  });

  it('builds run, GUI wave, and VCD Tcl scripts', () => {
    expect(buildIsimRunTcl('200us')).toBe('run 200us;\nexit\n');
    expect(buildIsimWaveTcl('200us')).toContain('wave add -r /');
    const vcd = buildIsimVcdTcl('E:\\work\\.co\\out\\mips tb.vcd', 'mips_tb', '200us');
    expect(vcd).toContain('vcd dumpfile "E:/work/.co/out/mips tb.vcd"');
    expect(vcd).toContain('vcd dumpvars -m /mips_tb -l 0');
    expect(vcd).toContain('vcd dumpflush');
    expect(vcd).toContain('quit');
  });
});
