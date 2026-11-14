// @index mips-host — Bounded Worker-only random generation using the frozen script registry
import type { CustomInstructionRegistry } from '../core/custom/registry';
import { generateBuiltinAsmTestCase, type BuiltinAsmGeneratorOptions } from '../../courseTesting/builtinAsm/facade';
import { generateRegisterCoverageAsmTestCase } from '../../courseTesting/builtinAsm/registerCoverageProgram';
import { assertCustomGeneratorNativeDependencies, generatedSourceMnemonics } from '../../courseTesting/builtinAsm/customGeneratorCompatibility';

export function executeScriptGenerationJob(payload: unknown, registry: CustomInstructionRegistry): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid script generation options');
  const value = payload as Record<string, unknown>;
  const keys = ['profile', 'instructionText', 'instructionCount', 'seed', 'generatedAt', 'registerCoverage', 'interrupt', 'exceptionRate', 'exceptionTypes',
    'p7StressMode', 'timerInterrupt', 'externalInterruptIntensity', 'timerIntensity', 'probeScenarioCount', 'probeShard', 'probeReturnVariant'];
  if (Object.keys(value).some((key) => !keys.includes(key)) || !['P3', 'P4', 'P5', 'P6', 'P7'].includes(String(value.profile))
    || typeof value.instructionText !== 'string' || value.instructionText.length > 65536
    || !Number.isSafeInteger(value.instructionCount) || (value.instructionCount as number) < 1 || (value.instructionCount as number) > 4094
    || (value.seed !== undefined && (typeof value.seed !== 'string' || value.seed.length > 4096))) throw new Error('Invalid or unbounded script generation options');
  const generatedAt = value.generatedAt === undefined ? new Date() : new Date(String(value.generatedAt));
  if (!Number.isFinite(generatedAt.getTime())) throw new Error('Invalid script generation date');
  if (value.registerCoverage !== undefined && typeof value.registerCoverage !== 'boolean') throw new Error('Invalid register coverage generation option');
  if (value.registerCoverage) {
    const result = generateRegisterCoverageAsmTestCase({ profile: value.profile as BuiltinAsmGeneratorOptions['profile'], generatedAt });
    assertCustomGeneratorNativeDependencies(registry, result.profile, generatedSourceMnemonics(result.text));
    return result;
  }
  return generateBuiltinAsmTestCase({ ...value, generatedAt, customRegistry: registry } as unknown as BuiltinAsmGeneratorOptions);
}
