import { describe, expect, it } from 'vitest';
import { appendHaltLoop, MIPS_NOP_HEX, MIPS_SELF_BRANCH_HEX } from '../../courseTesting/mipsUtil';

describe('appendHaltLoop', () => {
  it('appends a self-branch + nop halt loop to plain machine code', () => {
    const out = appendHaltLoop('3c011001\n34210002\n');
    expect(out).toBe(`3c011001\n34210002\n${MIPS_SELF_BRANCH_HEX}\n${MIPS_NOP_HEX}\n`);
  });

  it('does not double-append when already terminated by self-branch + nop', () => {
    const terminated = `3c011001\n${MIPS_SELF_BRANCH_HEX}\n${MIPS_NOP_HEX}\n`;
    expect(appendHaltLoop(terminated)).toBe(terminated);
  });

  it('treats a trailing self-branch WITHOUT its nop delay slot as not terminated', () => {
    const out = appendHaltLoop(`3c011001\n${MIPS_SELF_BRANCH_HEX}\n`);
    expect(out).toBe(`3c011001\n${MIPS_SELF_BRANCH_HEX}\n${MIPS_SELF_BRANCH_HEX}\n${MIPS_NOP_HEX}\n`);
  });

  it('normalizes CRLF and blank lines, then appends the halt loop', () => {
    const out = appendHaltLoop('3c011001\r\n\r\n34210002\r\n');
    expect(out).toBe(`3c011001\n34210002\n${MIPS_SELF_BRANCH_HEX}\n${MIPS_NOP_HEX}\n`);
  });

  it('is case-insensitive when detecting an existing halt loop', () => {
    const terminated = `3C011001\n1000FFFF\n00000000\n`;
    expect(appendHaltLoop(terminated)).toBe('3C011001\n1000FFFF\n00000000\n');
  });

  it('leaves empty input unchanged', () => {
    expect(appendHaltLoop('')).toBe('');
    expect(appendHaltLoop('\n\n')).toBe('\n\n');
  });
});

describe('MIPS hex constants', () => {
  it('NOP hex is sll $0, $0, 0', () => {
    expect(MIPS_NOP_HEX).toBe('00000000');
    // Verify it's 8 hex digits (32-bit word)
    expect(MIPS_NOP_HEX).toMatch(/^[0-9a-f]{8}$/i);
  });

  it('self-branch hex is beq $0, $0, -1', () => {
    expect(MIPS_SELF_BRANCH_HEX).toBe('1000ffff');
    // Verify it's 8 hex digits (32-bit word)
    expect(MIPS_SELF_BRANCH_HEX).toMatch(/^[0-9a-f]{8}$/i);
  });

  it('NOP and self-branch are distinct', () => {
    expect(MIPS_NOP_HEX).not.toBe(MIPS_SELF_BRANCH_HEX);
  });
});
