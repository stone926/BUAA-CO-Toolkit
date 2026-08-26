import { describe, expect, it } from 'vitest';
import { p7InterruptAnchorPairIssue } from '../../courseTesting/p7InterruptAnchor';

describe('P7 interrupt anchor contract', () => {
  it('requires both the MARS trigger and DUT target to be canonical simple instructions', () => {
    const safe = [0x34010000, 0x24210000]; // ori; addiu
    expect(p7InterruptAnchorPairIssue(safe, 0x3004)).toBeUndefined();

    const controlAtTrigger = [0x10000000, 0x24210000]; // beq; addiu
    expect(p7InterruptAnchorPairIssue(controlAtTrigger, 0x3004)).toMatch(/trigger.*not a canonical simple/);

    const memoryAtTarget = [0x34010000, 0x8c010000]; // ori; lw
    expect(p7InterruptAnchorPairIssue(memoryAtTarget, 0x3004)).toMatch(/target.*not a canonical simple/);
  });
});
