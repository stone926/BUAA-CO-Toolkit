import {
  BuiltinAsmGeneratorOptions,
  BuiltinAsmGeneratorResult,
  BuiltinAsmGeneratorError,
  generateBuiltinAsmTestCase as generateRandomAsmTestCase
} from './randomBody';
import { generateP7ProbeAsmTestCase } from './p7/probeEmitter';

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
  P7ProbeMetadata,
  P7ProbeOptions,
  P7ProbeScenario,
  P7ProbeScenarioKind,
  P7StressMode
} from './types';

export function generateBuiltinAsmTestCase(options: BuiltinAsmGeneratorOptions): BuiltinAsmGeneratorResult {
  const mode = options.profile === 'P7' ? (options.p7StressMode ?? 'anchor') : 'off';
  if (mode === 'probe') {
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

