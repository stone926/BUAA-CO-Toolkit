// @index register-coverage-program — Standalone architectural GPR coverage, independent of random payload budgets.
import { CpuState, courseDataByteLength } from '../cpuState';
import { courseAsmHaltLoop } from '../mipsUtil';
import { p7UserTextBaseAddress } from './p7/constants';
import { ProgramWriter } from './programWriter';
import { emitGeneralRegisterCoverage, generalRegisterCoverageInstructionCount } from './registerCoverage';
import {
  effectiveBuiltinGeneratorProfile,
  type BuiltinAsmGeneratorOptions,
  type BuiltinAsmGeneratorResult
} from './randomBody';

/** Required course instructions intentionally remain independent of the user's payload focus. */
export function generateRegisterCoverageAsmTestCase(
  options: Pick<BuiltinAsmGeneratorOptions, 'profile' | 'generatedAt'>
): BuiltinAsmGeneratorResult {
  const profile = effectiveBuiltinGeneratorProfile(options.profile);
  const program = new ProgramWriter(p7UserTextBaseAddress);
  const allowed = new Set(['add', 'ori', 'sw']);
  emitGeneralRegisterCoverage({
    remaining: () => generalRegisterCoverageInstructionCount - program.count(),
    pc: () => program.pc(),
    emit: (_mnemonic, text) => program.emit(text),
    label: (label) => program.label(label)
  }, new CpuState(), allowed);
  program.label('_co_test_complete');
  program.emit('ori $25, $0, 0x6d6e');
  const seed = 'gpr-coverage-v1';
  return {
    text: [
      '# Built-in BUAA CO architectural GPR test',
      `# profile: ${profile}`,
      `# seed: ${seed}`,
      `# generated: ${(options.generatedAt ?? new Date()).toISOString()}`,
      `# instruction_count: ${program.count()}`,
      '# instruction_count_scope: payload (halt tail excluded)',
      '# instruction_set: add ori sw',
      '.data', '.align 2', '_co_data:', `    .space ${courseDataByteLength}`,
      '.text', '.globl main', 'main:',
      ...program.render(), ...courseAsmHaltLoop(), ''
    ].join('\n'),
    profile,
    seed,
    instructionSet: [...allowed],
    usedInstructions: [...allowed],
    instructionCount: program.count(),
    mode: 'off',
    interruptSchedule: []
  };
}
