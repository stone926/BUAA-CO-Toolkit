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
    expect(commands).toContain('co.test.verifyWithFixedMars');
    expect(commands).toContain('co.hazard.analyzeCurrentMachineCode');
    expect(commands).not.toContain('co.logisim.convertLogToCsv');
  });

  it('includes Logisim preparation and diagnostics for P3', () => {
    const commands = commandsFor('P3', 'logisim');

    expect(commands).toContain('co.logisim.generateRom');
    expect(commands).toContain('co.logisim.convertLogToCsv');
    expect(commands).toContain('co.test.prepareLogisimCases');
    expect(commands).toContain('co.test.diagnoseP3LogisimTraceCircuit');
    expect(commands).toContain('co.test.runFullTest');
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
      'co.test.runFullTest',
      'co.test.verifyWithFixedMars',
      'co.test.runBatchTraceTests',
      'co.test.runGeneratedTraceTests',
      'co.test.generateAsmTests',
      'co.test.generateAndDumpAsmTests',
      'co.test.compareTraceFiles',
      'co.test.compareLatestOutputs',
      'co.test.openBatchTraceReport',
      'co.verilog.generateTestbench',
      'co.verilog.checkSyntaxWithIse',
      'co.verilog.generateIseProject',
      'co.verilog.exportVcd',
      'co.logisim.generateRom',
      'co.logisim.convertLogToCsv',
      'co.test.prepareLogisimCases',
      'co.test.prepareGeneratedLogisimCases',
      'co.test.diagnoseP3LogisimTraceCircuit',
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
});
