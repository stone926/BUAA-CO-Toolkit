import { describe, expect, it } from 'vitest';
import { buildAdvancedToolItems } from '../advancedToolModel';

function commandsFor(profile: Parameters<typeof buildAdvancedToolItems>[0]['profile'], activeKind: Parameters<typeof buildAdvancedToolItems>[0]['activeKind']): string[] {
  return buildAdvancedToolItems({ profile, activeKind, activeFileName: 'current.v' })
    .map((item) => item.command);
}

describe('advanced tool model', () => {
  it('filters Verilog tools by profile and active editor kind', () => {
    const commands = commandsFor('P7', 'verilog');

    expect(commands).toContain('co.verilog.generateTestbench');
    expect(commands).toContain('co.verilog.generateIseProject');
    expect(commands).toContain('co.verilog.exportVcd');
    expect(commands).toContain('co.test.runGeneratedTraceTests');
    expect(commands).toContain('co.test.startContinuousGeneratedTraceTests');
    expect(commands).toContain('co.test.stopContinuousTests');
    expect(commands).toContain('co.test.openAsmCaseIndex');
    expect(commands).not.toContain('co.test.verifyWithFixedMars');
    expect(commands).toContain('co.hazard.analyzeCurrentMachineCode');
    expect(commands).not.toContain('co.logisim.convertLogToCsv');
  });

  it('keeps Logisim utilities but hides test preparation and diagnostics for P3', () => {
    const commands = commandsFor('P3', 'logisim');

    expect(commands).toContain('co.logisim.generateRom');
    expect(commands).toContain('co.logisim.convertLogToCsv');
    expect(commands).not.toContain('co.test.prepareLogisimCases');
    expect(commands).not.toContain('co.test.prepareGeneratedLogisimCases');
    expect(commands).not.toContain('co.test.diagnoseP3LogisimTraceCircuit');
    expect(commands).not.toContain('co.test.runFullTest');
    expect(commands).toContain('co.test.runGeneratedTraceTests');
    expect(commands).not.toContain('co.verilog.generateIseProject');
  });

  it('keeps unresolved auto profile empty', () => {
    expect(commandsFor('auto', 'verilog')).toEqual([]);
  });

  it('uses existing command identifiers only', () => {
    const contributedCommands = new Set([
      'co.mips.runWithStdinFile',
      'co.mips.runInTerminal',
      'co.mips.dumpKernelText',
      'co.test.runGeneratedTraceTests',
      'co.test.startContinuousGeneratedTraceTests',
      'co.test.stopContinuousTests',
      'co.test.openAsmCaseIndex',
      'co.verilog.generateTestbench',
      'co.verilog.checkSyntaxWithIse',
      'co.verilog.generateIseProject',
      'co.verilog.exportVcd',
      'co.logisim.generateRom',
      'co.logisim.convertLogToCsv',
      'co.hazard.analyzeCurrentMachineCode',
      'co.hazard.openReport'
    ]);
    const commands = [
      ...commandsFor('P7', 'mips'),
      ...commandsFor('P7', 'verilog'),
      ...commandsFor('P3', 'logisim')
    ];

    expect(commands.every((command) => contributedCommands.has(command))).toBe(true);
  });

  it('exposes exactly four automatic-test concepts for trace profiles', () => {
    const testItems = buildAdvancedToolItems({ profile: 'P6', activeKind: 'verilog' })
      .filter((item) => item.command.startsWith('co.test.'));

    expect(testItems.map((item) => item.command)).toEqual([
      'co.test.runGeneratedTraceTests',
      'co.test.startContinuousGeneratedTraceTests',
      'co.test.stopContinuousTests',
      'co.test.openAsmCaseIndex'
    ]);
    expect(testItems.map((item) => item.label)).toEqual([
      '运行自动测试',
      '持续自动测试',
      '停止自动测试',
      '测试历史 / 失败用例'
    ]);
  });
});
