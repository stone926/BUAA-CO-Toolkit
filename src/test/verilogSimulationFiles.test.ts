import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  generatedRuntimeTestbenchText,
  generatedTestbenchMarker,
  isCustomTestbenchPath,
  isGeneratedRuntimeTestbench,
  isPrivateRuntimeTestbenchPath,
  isUserTestbenchPath,
  p7AutoRuntimeTestbenchName,
  userTestbenchFileName,
  verilogProjectExcludeGlob
} from '../verilogSimulationFiles';

describe('verilog simulation file helpers', () => {
  it('uses stable private automatic testbench names', () => {
    expect(p7AutoRuntimeTestbenchName).toBe('co_generated_p7_auto_tb');
  });

  it('names and recognizes user testbenches under .co/tb', () => {
    expect(userTestbenchFileName('alu_tb')).toBe('alu_tb.v');
    expect(userTestbenchFileName('cpu tb')).toBe('cpu_tb.v');
    const root = path.resolve('work');
    expect(isUserTestbenchPath(root, path.join(root, '.co', 'tb', 'alu_tb.v'))).toBe(true);
    expect(isUserTestbenchPath(root, path.join(root, '.co', 'tb', 'nested', 'x.v'))).toBe(true);
    expect(isUserTestbenchPath(root, path.join(root, '.co', 'tb'))).toBe(false);
    expect(isUserTestbenchPath(root, path.join(root, '.co', 'iverilog', 'co_generated_alu_tb.v'))).toBe(false);
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

  it('recognizes only custom testbench filename suffixes outside .co', () => {
    expect(isCustomTestbenchPath('E:/work/test/alu_tb.v')).toBe(true);
    expect(isCustomTestbenchPath('E:/work/test/ALU_TESTBENCH.V')).toBe(true);
    expect(isCustomTestbenchPath('E:/work/test/tb_alu.v')).toBe(false);
    expect(isCustomTestbenchPath('E:/work/test/alu_tb_copy.v')).toBe(false);
    expect(isCustomTestbenchPath('E:/work/.co/iverilog/private_tb.v')).toBe(false);
    expect(isCustomTestbenchPath('E:/work/.co/tb/alu_tb.v')).toBe(false);
    expect(isPrivateRuntimeTestbenchPath('E:/work/.co/iverilog/private_tb.v')).toBe(true);
    expect(isPrivateRuntimeTestbenchPath('E:/work/.co/isim/legacy_tb.v')).toBe(true);
    expect(isPrivateRuntimeTestbenchPath('E:/work/.co/tb/alu_tb.v')).toBe(false);
  });

  it('excludes generated and editor-owned directories from project discovery', () => {
    expect(verilogProjectExcludeGlob).toContain('.co');
    expect(verilogProjectExcludeGlob).toContain('.vscode');
    expect(verilogProjectExcludeGlob).toContain('.vscode-test');
  });
});
