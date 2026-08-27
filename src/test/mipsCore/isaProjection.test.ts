import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import {
  isaCatalogSchemaRevision,
  isaCatalogSha256,
  isaInstructions
} from '../../mips/core/generated/isaCatalog';
import {
  isaDisplayCatalogSchemaRevision,
  isaDisplayCatalogSha256,
  isaDisplayInstructionByMnemonic,
  isaDisplayInstructions
} from '../../language/mips/generated/isaDisplayCatalog';
import { instructions, instructionMeta } from '../../language/mips/resources';
import { generatorInstructionCatalog } from '../../courseTesting/generatorInstructionCatalog';

const profiles = ['P3', 'P4', 'P5', 'P6', 'P7'] as const;

describe('versioned ISA catalog projections', () => {
  it('generates core and LSP facts from the same revision and source hash', () => {
    expect(isaDisplayCatalogSchemaRevision).toBe(isaCatalogSchemaRevision);
    expect(isaDisplayCatalogSha256).toBe(isaCatalogSha256);
    expect(isaDisplayInstructions).toHaveLength(isaInstructions.length);

    for (const entry of isaInstructions) {
      const display = isaDisplayInstructionByMnemonic.get(entry.mnemonic);
      expect(display, entry.mnemonic).toBeDefined();
      expect(display?.layer).toBe(entry.layer);
      expect(display?.profiles).toEqual(entry.profiles);
      expect(display?.gprReads).toEqual(entry.gprReads);
      expect(display?.gprWrites).toEqual(entry.gprWrites);
      expect(display?.delaySlot).toBe(entry.delaySlotProfiles.length > 0);
      expect(display?.memoryWidth).toBe(entry.memoryAccess?.width);
      expect(display?.memoryAlignment).toBe(
        entry.memoryAccess === undefined
          ? undefined
          : entry.memoryAccess.kind.startsWith('partial-') ? 1 : entry.memoryAccess.width
      );
    }
  });

  it('generates every course profile membership from required ISA availability', () => {
    for (const profile of profiles) {
      const required = isaInstructions
        .filter((entry) => entry.layer === 'required' && entry.profiles.includes(profile))
        .map((entry) => entry.mnemonic)
        .sort();
      expect([...generatorInstructionCatalog.profiles[profile]].sort(), profile).toEqual(required);
    }
    expect([...generatorInstructionCatalog.categories.supported].sort())
      .toEqual(isaInstructions.map((entry) => entry.mnemonic).sort());
  });

  it('makes LSP structural display and validation facts consume the generated projection', () => {
    for (const fact of isaDisplayInstructions) {
      const instruction = instructions[fact.mnemonic];
      expect(instruction?.isa, fact.mnemonic).toBe(fact);
      expect(instruction?.type, fact.mnemonic).toBe(fact.type);
      expect(Boolean(instruction?.delaySlot), fact.mnemonic).toBe(fact.delaySlot);
      expect(instructionMeta.writesFirstOperand[fact.mnemonic], fact.mnemonic)
        .toBe(fact.writesFirstOperand);
      if (fact.memoryAlignment !== undefined) {
        expect(instructionMeta.memoryAlignment[fact.mnemonic], fact.mnemonic)
          .toBe(fact.memoryAlignment);
      }
    }
    expect(instructions.jalr.delaySlot).toBe(true);
    expect(instructionMeta.memoryAlignment.lwl).toBe(1);
  });

  it('passes the deterministic multi-target --check command', () => {
    const result = spawnSync(process.execPath, ['scripts/generate-mips-isa.mjs', '--check'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
