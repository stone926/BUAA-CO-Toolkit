import { describe, expect, it } from 'vitest';
import {
  formatTraceEvent,
  machineCodeNeedsDetailedMarsTrace,
  machineCodeNeedsLinkBranchOracleRepairTrace,
  machineCodeNeedsUndefinedBehaviorTrace,
  marsDetailedUndefinedBehaviorError,
  parseCpuTraceLine,
  parseMarsDetailedOutput,
  parseMarsOutput
} from '../../../language/mips/traceParser';

describe('MIPS CPU trace parser', () => {
  it('parses P4 trace lines without cycle numbers', () => {
    const events = parseMarsOutput(`
MARS 4.5
@00003000: $03 <= 0000000a
@00003004: *00001004 <= 00000000
`);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      cycle: undefined,
      pc: '00003000',
      kind: 'grf',
      target: '3',
      value: '0000000A',
      lineNumber: 3
    });
    expect(events[1]).toMatchObject({
      pc: '00003004',
      kind: 'dm',
      target: '00001004',
      value: '00000000'
    });
  });

  it('parses P5/P6 trace lines with cycle numbers', () => {
    const event = parseCpuTraceLine('120@3004: *1004 <= 0', 7);

    expect(event).toMatchObject({
      cycle: 120,
      pc: '00003004',
      kind: 'dm',
      target: '00001004',
      value: '00000000',
      raw: '120@3004: *1004 <= 0',
      lineNumber: 7
    });
  });

  it('parses modified MARS coL1 register spacing', () => {
    const event = parseCpuTraceLine('@00003000: $ 1 <= 00000001');

    expect(event).toMatchObject({
      pc: '00003000',
      kind: 'grf',
      target: '1',
      value: '00000001'
    });
  });

  it('keeps unknown simulator values parseable for comparison reports', () => {
    const event = parseCpuTraceLine('140@00003008: $2 <= xxxxxxxx');

    expect(event).toBeDefined();
    expect(event?.value).toBe('XXXXXXXX');
  });

  it('formats normalized events back to the course trace shape', () => {
    const event = parseCpuTraceLine('@0x3000: $03 <= 0xa');

    expect(event).toBeDefined();
    expect(formatTraceEvent(event!)).toBe('@00003000: $3 <= 0000000A');
  });

  it('parses the final trace line and preserves line numbers through ignored output', () => {
    const events = parseMarsOutput('log header\r\n@00003000: $1 <= 00000001\r\nignored\n@00003004: $2 <= 00000002');

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.lineNumber)).toEqual([2, 4]);
    expect(events[1]).toMatchObject({
      pc: '00003004',
      target: '2',
      value: '00000002'
    });
  });

  it('keeps only the final DM value per word inside one MARS coL2 instruction block', () => {
    const events = parseMarsDetailedOutput(`
@PC00003000 -> swl $2, 1($1) (a8220001)
\t\t*00001000 <= 000000aa
\t\t*00001000 <= 0000bbaa
\t\t*00001000 <= 00ccbbaa
\t\t*00001000 <= ddccbbaa
@PC00003004 -> addiu $3, $0, 1 (24030001)
\t\t$ 3 <= 00000001
`);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      pc: '00003000',
      kind: 'dm',
      target: '00001000',
      value: 'DDCCBBAA',
      lineNumber: 6
    });
    expect(events[1]).toMatchObject({
      pc: '00003004',
      kind: 'grf',
      target: '3',
      value: '00000001'
    });
  });

  it('does not fold the same PC and DM word across dynamic coL2 instruction blocks', () => {
    const events = parseMarsDetailedOutput(`
@PC00003000 -> swr $2, 0($1) (b8220000)
\t\t*00001000 <= 11223344
@PC00003000 -> swr $2, 0($1) (b8220000)
\t\t*00001000 <= 55667788
`);

    expect(events.map((event) => event.value)).toEqual(['11223344', '55667788']);
  });

  it('repairs the modified-MARS not-taken REGIMM link without duplicating a real taken write', () => {
    const events = parseMarsDetailedOutput([
      '@PC00003000 -> bgezal $1, target (04310001)',
      '@PC00003004 -> bltzal $2, target (04500001)',
      '\t\t$31 <= 0000300c'
    ].join('\n'));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      pc: '00003000', kind: 'grf', target: '31', value: '00003008', lineNumber: 1
    });
    expect(events[1]).toMatchObject({
      pc: '00003004', kind: 'grf', target: '31', value: '0000300C'
    });
  });

  it('ignores event-shaped program output inside a coL2 stream', () => {
    const events = parseMarsDetailedOutput(`@PC00003000 -> sw $2, 0($1) (ac220000)
*00001000 <= deadbeef
\t\t*00001000 <= 12345678
`);

    expect(events).toHaveLength(1);
    expect(events[0].value).toBe('12345678');
  });

  it('selects detailed MARS trace only when exported machine code contains SWL or SWR', () => {
    expect(machineCodeNeedsDetailedMarsTrace('a8000000\n')).toBe(true);
    expect(machineCodeNeedsDetailedMarsTrace('0xB8000000\r\n')).toBe(true);
    expect(machineCodeNeedsDetailedMarsTrace('ac000000\n24020001\n')).toBe(false);
    expect(machineCodeNeedsDetailedMarsTrace('# a8000000\nnot-a-word b8000000')).toBe(false);
  });

  it('selects coL2 oracle repair for both REGIMM link encodings only', () => {
    expect(machineCodeNeedsLinkBranchOracleRepairTrace('04300001\n04310001\n')).toBe(true);
    expect(machineCodeNeedsLinkBranchOracleRepairTrace('04200001\n04210001\n040c0001\n')).toBe(false);
  });

  it('selects dynamic validation for candidates without rejecting unreachable code', () => {
    expect(machineCodeNeedsUndefinedBehaviorTrace('0043001a\n', true)).toBe(true); // div $2,$3
    expect(machineCodeNeedsUndefinedBehaviorTrace('03e0f809\n', true)).toBe(true); // jalr $31,$31
    expect(machineCodeNeedsUndefinedBehaviorTrace('10000001\n08000c10\n', true)).toBe(true);
    expect(machineCodeNeedsUndefinedBehaviorTrace('10000001\n08000c10\n', false)).toBe(false);
    expect(machineCodeNeedsUndefinedBehaviorTrace('00000810\n', true)).toBe(true); // mfhi $1
    expect(machineCodeNeedsUndefinedBehaviorTrace('70430000\n', true)).toBe(true); // madd $2,$3
    expect(machineCodeNeedsUndefinedBehaviorTrace('07f00001\n', true)).toBe(true); // bltzal $31,target
    expect(machineCodeNeedsUndefinedBehaviorTrace('03800821\n37a10000\n', true)).toBe(true); // reads $gp/$sp

    const unreachableTrace = '@PC00003020 -> ori $1, $0, 1 (34010001)\n\t\t$ 1 <= 00000001\n';
    expect(marsDetailedUndefinedBehaviorError(unreachableTrace, true)).toBeUndefined();
  });

  it('rejects only a dynamically executed REGIMM link branch that reads its own $31 destination', () => {
    expect(marsDetailedUndefinedBehaviorError(
      '@PC00003000 -> bltzal $31, target (07f00001)\n',
      true
    )).toContain('UNPREDICTABLE');
    expect(marsDetailedUndefinedBehaviorError(
      '@PC00003000 -> bltzal $30, target (07d00001)\n',
      true
    )).toBeUndefined();
    expect(marsDetailedUndefinedBehaviorError(
      '@PC00003020 -> ori $1, $0, 1 (34010001)\n',
      true
    )).toBeUndefined();
  });

  it('rejects reads after stable MARS omits a not-taken REGIMM link until $31 is explicitly rewritten', () => {
    const omittedLinkThenRead = [
      '@PC00003000 -> bgezal $1, target (04310001)',
      '@PC00003004 -> addu $2, $31, $0 (03e01021)'
    ].join('\n');
    expect(marsDetailedUndefinedBehaviorError(omittedLinkThenRead, true)).toContain('后续执行语义');

    const explicitRewriteThenRead = [
      '@PC00003000 -> bgezal $1, target (04310001)',
      '@PC00003004 -> ori $31, $0, 7 (341f0007)',
      '\t\t$31 <= 00000007',
      '@PC00003008 -> addu $2, $31, $0 (03e01021)',
      '\t\t$ 2 <= 00000007'
    ].join('\n');
    expect(marsDetailedUndefinedBehaviorError(explicitRewriteThenRead, true)).toBeUndefined();

    const takenLinkThenRead = [
      '@PC00003000 -> bgezal $1, target (04310001)',
      '\t\t$31 <= 00003008',
      '@PC00003004 -> addu $2, $31, $0 (03e01021)',
      '\t\t$ 2 <= 00003008'
    ].join('\n');
    expect(marsDetailedUndefinedBehaviorError(takenLinkThenRead, true)).toBeUndefined();
  });

  it('rejects only an actually executed divide by zero', () => {
    const invalid = [
      '@PC00003000 -> ori $3, $0, 0 (34030000)',
      '\t\t$ 3 <= 00000000',
      '@PC00003004 -> div $2, $3 (0043001a)'
    ].join('\n');
    const valid = [
      '@PC00003000 -> ori $3, $0, 1 (34030001)',
      '\t\t$ 3 <= 00000001',
      '@PC00003004 -> div $2, $3 (0043001a)'
    ].join('\n');

    expect(marsDetailedUndefinedBehaviorError(invalid, true)).toContain('DivZero');
    expect(marsDetailedUndefinedBehaviorError(valid, true)).toBeUndefined();
  });

  it('rejects stable-MARS $gp/$sp reads until the program explicitly initializes them', () => {
    expect(marsDetailedUndefinedBehaviorError(
      '@PC00003000 -> addu $1, $gp, $0 (03800821)\n',
      true
    )).toContain('稳定版 MARS v0.6.3');
    expect(marsDetailedUndefinedBehaviorError([
      '@PC00003000 -> ori $gp, $0, 0 (341c0000)',
      '\t\t$28 <= 00000000',
      '@PC00003004 -> addu $1, $gp, $0 (03800821)',
      '\t\t$ 1 <= 00000000'
    ].join('\n'), true)).toBeUndefined();
    expect(marsDetailedUndefinedBehaviorError([
      '@PC00003000 -> lui $sp, 0 (3c1d0000)',
      '\t\t$29 <= 00000000',
      '@PC00003004 -> div $2, $sp (005d001a)'
    ].join('\n'), true)).toContain('DivZero');
  });

  it('rejects actually executed JalrSame and DoubleDelay', () => {
    expect(marsDetailedUndefinedBehaviorError(
      '@PC00003000 -> jalr $31, $31 (03e0f809)\n',
      true
    )).toContain('JalrSame');

    const doubleDelay = [
      '@PC00003000 -> beq $0, $0, target (10000001)',
      '@PC00003004 -> j target (08000c10)'
    ].join('\n');
    expect(marsDetailedUndefinedBehaviorError(doubleDelay, true)).toContain('DoubleDelay');
    expect(marsDetailedUndefinedBehaviorError(doubleDelay, false)).toBeUndefined();
  });

  it('does not mistake a REGIMM immediate trap for a branch delay slot', () => {
    const teqiThenJumpMachineCode = '040c0001\n08000c10\n'; // teqi $0, 1; j 0x3040
    const teqiThenJumpTrace = [
      '@PC00003000 -> teqi $0, 1 (040c0001)',
      '@PC00003004 -> j target (08000c10)'
    ].join('\n');

    expect(machineCodeNeedsUndefinedBehaviorTrace(teqiThenJumpMachineCode, true)).toBe(false);
    expect(marsDetailedUndefinedBehaviorError(teqiThenJumpTrace, true)).toBeUndefined();
  });

  it.each([
    ['bltz', '04000001'],
    ['bgez', '04010001'],
    ['bltzal', '04100001'],
    ['bgezal', '04110001']
  ])('keeps %s as a real REGIMM branch with a delay slot', (mnemonic, branchWord) => {
    const jumpWord = '08000c10';
    expect(machineCodeNeedsUndefinedBehaviorTrace(`${branchWord}\n${jumpWord}\n`, true)).toBe(true);
    expect(marsDetailedUndefinedBehaviorError([
      `@PC00003000 -> ${mnemonic} $0, target (${branchWord})`,
      `@PC00003004 -> j target (${jumpWord})`
    ].join('\n'), true)).toContain('DoubleDelay');
  });

  it('rejects only dynamically executed HI/LO reads before the corresponding value is defined', () => {
    expect(marsDetailedUndefinedBehaviorError(
      '@PC00003000 -> mfhi $1 (00000810)\n',
      true
    )).toContain('HI 尚未');
    expect(marsDetailedUndefinedBehaviorError([
      '@PC00003000 -> mthi $2 (00400011)',
      '@PC00003004 -> mfhi $1 (00000810)'
    ].join('\n'), true)).toBeUndefined();
    expect(marsDetailedUndefinedBehaviorError([
      '@PC00003000 -> mthi $2 (00400011)',
      '@PC00003004 -> mflo $1 (00000812)'
    ].join('\n'), true)).toContain('LO 尚未');
    expect(marsDetailedUndefinedBehaviorError(
      '@PC00003020 -> ori $1, $0, 1 (34010001)\n\t\t$ 1 <= 00000001\n',
      true
    )).toBeUndefined();
  });

  it('tracks both-register MDU definitions and MUL invalidation', () => {
    expect(marsDetailedUndefinedBehaviorError([
      '@PC00003000 -> mult $2, $3 (00430018)',
      '@PC00003004 -> mfhi $1 (00000810)',
      '@PC00003008 -> mflo $1 (00000812)'
    ].join('\n'), true)).toBeUndefined();
    expect(marsDetailedUndefinedBehaviorError([
      '@PC00003000 -> mthi $2 (00400011)',
      '@PC00003004 -> mtlo $3 (00600013)',
      '@PC00003008 -> madd $2, $3 (70430000)'
    ].join('\n'), true)).toBeUndefined();
    expect(marsDetailedUndefinedBehaviorError([
      '@PC00003000 -> mult $2, $3 (00430018)',
      '@PC00003004 -> mul $4, $2, $3 (70432002)',
      '@PC00003008 -> mfhi $1 (00000810)'
    ].join('\n'), true)).toContain('HI 尚未');
  });
});
