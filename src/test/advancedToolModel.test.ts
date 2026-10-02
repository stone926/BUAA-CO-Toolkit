import { describe, expect, it } from 'vitest';
import { buildAdvancedToolItems } from '../advancedToolModel';

function commandsFor(
  profile: Parameters<typeof buildAdvancedToolItems>[0]['profile'],
  activeKind: Parameters<typeof buildAdvancedToolItems>[0]['activeKind']
): string[] {
  return buildAdvancedToolItems({ profile, activeKind, activeFileName: 'current.v' })
    .map((item) => item.command);
}

describe('advanced tool model', () => {
  it.each(['auto', 'P0', 'P1', 'P7'] as const)('offers built-in ASM run commands under %s', (profile) => {
    const items = buildAdvancedToolItems({ profile, activeKind: 'mips', activeFileName: 'program.asm' });
    expect(items.map((item) => item.command)).toEqual(expect.arrayContaining([
      'co.mips.runWithStdinFile', 'co.mips.runInTerminal'
    ]));
    expect(items.filter((item) => ['co.mips.runWithStdinFile', 'co.mips.runInTerminal'].includes(item.command))
      .every((item) => item.description === '内置 MIPS 引擎')).toBe(true);
  });
  it('filters Verilog tools by profile and active editor kind', () => {
    const commands = commandsFor('P7', 'verilog');

    expect(commands).toContain('co.verilog.generateTestbench');
    expect(commands).toContain('co.verilog.checkSyntax');
    expect(commands).not.toContain('co.verilog.generateIseProject');
    expect(commands).not.toContain('co.verilog.exportVcd');
    expect(commands.some((command) => command.startsWith('co.test.'))).toBe(false);
    expect(commands).toContain('co.hazard.analyzeCurrentMachineCode');
    expect(commands).not.toContain('co.logisim.convertLogToCsv');
  });

  it('exposes Icarus syntax checks without ISE-only tools', () => {
    const items = buildAdvancedToolItems({ profile: 'P7', activeKind: 'verilog', activeFileName: 'current.v' });
    const commands = items.map((item) => item.command);

    expect(commands).toContain('co.verilog.checkSyntax');
    expect(commands).not.toContain('co.verilog.generateIseProject');
    expect(commands).not.toContain('co.verilog.exportVcd');
    expect(items.find((item) => item.command === 'co.verilog.checkSyntax')?.description)
      .toContain('Icarus');
  });

  it('keeps Logisim utilities but hides test preparation and diagnostics for P3', () => {
    const commands = commandsFor('P3', 'logisim');

    expect(commands).toContain('co.logisim.generateRom');
    expect(commands).toContain('co.logisim.convertLogToCsv');
    expect(commands).not.toContain('co.test.prepareLogisimCases');
    expect(commands).not.toContain('co.test.prepareGeneratedLogisimCases');
    expect(commands).not.toContain('co.test.diagnoseP3LogisimTraceCircuit');
    expect(commands).not.toContain('co.test.runFullTest');
    expect(commands.some((command) => command.startsWith('co.test.'))).toBe(false);
    expect(commands).not.toContain('co.verilog.generateIseProject');
  });

  it('keeps unresolved auto profile empty', () => {
    expect(commandsFor('auto', 'verilog')).toEqual([]);
  });

  it('describes pipeline analysis as built in', () => {
    const item = buildAdvancedToolItems({ profile: 'P7', activeKind: 'mips' })
      .find((entry) => entry.command === 'co.hazard.analyzeCurrentMachineCode');

    expect(item?.description).toBe('内置冲突分析器');
    expect(item?.detail).toContain('选择 ASM 文件');
  });

  it('uses existing command identifiers only', () => {
    const contributedCommands = new Set([
      'co.mips.openWorkbench',
      'co.mips.runWithStdinFile',
      'co.mips.runInTerminal',
      'co.mips.dumpKernelText',
      'co.verilog.generateTestbench',
      'co.verilog.checkSyntax',
      'co.waveform.openFile',
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

  it('does not duplicate the public test facade in more tools', () => {
    const contexts = [
      { profile: 'P7' as const, activeKind: 'mips' as const },
      { profile: 'P6' as const, activeKind: 'verilog' as const },
      { profile: 'P3' as const, activeKind: 'logisim' as const }
    ];

    for (const context of contexts) {
      expect(buildAdvancedToolItems(context).some((item) => item.command.startsWith('co.test.'))).toBe(false);
    }
  });
});
