// @index builtin-generator — 内置ASM生成入口，P7 stress mode分派
export {
  BuiltinAsmGeneratorError,
  effectiveBuiltinGeneratorProfile,
  generateBuiltinAsmTestCase,
  normalizeP7ExceptionTypes,
  p7InternalUnknownInstructionMnemonic,
  resolveBuiltinInstructionSet
} from './builtinAsm/facade';

export type {
  BuiltinAsmGeneratorOptions,
  BuiltinAsmGeneratorResult,
  BuiltinInstructionSet,
  P7ExceptionKind,
  P7ProbeMetadata,
  P7ProbeOptions,
  P7ProbeScenario,
  P7ProbeScenarioKind,
  P7StressMode
} from './builtinAsm/facade';
