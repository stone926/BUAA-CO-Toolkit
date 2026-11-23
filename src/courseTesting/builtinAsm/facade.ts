import {
  BuiltinAsmGeneratorOptions,
  BuiltinAsmGeneratorResult,
  BuiltinAsmGeneratorError,
  generateBuiltinAsmTestCase as generateRandomAsmTestCase
} from './randomBody';
import { generateP7ProbeAsmTestCase } from './p7/probeEmitter';
import { generateP7ReturnProbe } from './p7/probeReturnProgram';
import { generateP7ArchitectureProbe } from './p7/probeArchitectureProgram';
import { generateP7InstructionBoundaryProbe } from './p7/probeInstructionBoundaryProgram';
import { avoidCustomP7RiCollisions } from '../p7RiWords';
import { assertCustomGeneratorNativeDependencies, generatedSourceMnemonics } from './customGeneratorCompatibility';

export {
  BuiltinAsmGeneratorError,
  effectiveBuiltinGeneratorProfile,
  normalizeP7ExceptionTypes,
  p7InternalUnknownInstructionMnemonic,
  resolveBuiltinInstructionSet
} from './randomBody';

export type {
  BuiltinAsmGeneratorOptions,
  BuiltinAsmGeneratorResult,
  BuiltinInstructionSet,
  P7ExceptionKind
} from './randomBody';

export type {
  P7ProbeCommitExpectation,
  P7ProbeExpectedRecord,
  P7ProbeMetadata,
  P7ProbeOptions,
  P7ProbeShard,
  P7ProbeScenario,
  P7ProbeScenarioKind,
  P7StressMode
} from './types';

export function generateBuiltinAsmTestCase(options: BuiltinAsmGeneratorOptions): BuiltinAsmGeneratorResult {
  const result = generateBuiltinAsmProgram(options);
  if (options.p7StressMode === 'probe' && options.profile === 'P7') {
    assertCustomGeneratorNativeDependencies(options.customRegistry, 'P7', generatedSourceMnemonics(result.text));
  }
  return options.profile === 'P7' && options.customRegistry
    ? { ...result, text: avoidCustomP7RiCollisions(result.text, options.customRegistry) } : result;
}

function generateBuiltinAsmProgram(options: BuiltinAsmGeneratorOptions): BuiltinAsmGeneratorResult {
  const mode = options.profile === 'P7' ? (options.p7StressMode ?? 'anchor') : 'off';
  if (mode === 'probe') {
    if (options.probeShard === 'return' || options.probeShard === 'reset') return generateP7ReturnProbe(options);
    if (options.probeShard === 'architecture') return generateP7ArchitectureProbe(options);
    if (options.probeShard === 'im-boundaries') return generateP7InstructionBoundaryProbe(options);
    return generateP7ProbeAsmTestCase(options);
  }
  if (mode === 'off') {
    return generateRandomAsmTestCase({ ...options, interrupt: false, timerInterrupt: false, p7StressMode: 'off' });
  }
  if (mode === 'hybrid') {
    throw new BuiltinAsmGeneratorError('Hybrid P7 stress mode must be expanded by the course test runner.');
  }
  return generateRandomAsmTestCase({ ...options, p7StressMode: 'anchor' });
}
