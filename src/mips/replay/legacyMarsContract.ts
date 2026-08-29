// @index mips-replay — legacy MARS 课程 machine/trace 契约的 replay adapter hook
import {
  courseMachineCodeValidationError,
  stableMarsMachineCodeCapacityPolicy
} from '../../courseTesting/machineCodeValidation';
import { courseMarsOracleCompatibilityError } from '../legacy/marsOracleCompatibility';
import type { ProjectProfile } from '../../projectProfile';
import { maximumReplaySourceBytes, readBoundedRegularFile } from './boundedFile';
import type {
  ReplayAdapterContext,
  ReplayAssemblyOutput,
  ReplayExecutionOutput
} from './types';

export async function validateLegacyMarsReplayAssembly(
  context: ReplayAdapterContext,
  output: ReplayAssemblyOutput
): Promise<string | undefined> {
  if (!output.dutBytes) return 'legacy MARS assembly did not produce DUT machine-code bytes';
  const asmText = (await readBoundedRegularFile(context.sourceRoot, {
    maximumBytes: maximumReplaySourceBytes,
    label: 'materialized replay root source'
  })).toString('utf8');
  return courseMachineCodeValidationError(
    context.configuration.profile as ProjectProfile,
    Buffer.from(output.dutBytes).toString('utf8'),
    asmText,
    context.sourceKind === 'builtin',
    stableMarsMachineCodeCapacityPolicy
  );
}

export function validateLegacyMarsReplayExecution(
  context: ReplayAdapterContext,
  assembly: ReplayAssemblyOutput,
  output: ReplayExecutionOutput
): string | undefined {
  const stopPolicyIssue = legacyMarsReplayStopPolicyIssue(context);
  if (stopPolicyIssue) return stopPolicyIssue;
  if (!assembly.dutBytes) return 'legacy MARS execution has no assembled DUT machine-code bytes';
  return courseMarsOracleCompatibilityError(
    context.configuration.profile as ProjectProfile,
    Buffer.from(assembly.dutBytes).toString('utf8'),
    output.stdout,
    context.configuration.executionOptions?.delayedBranching ?? false
  );
}

/**
 * Phase-1 MARS exposes no independent signal that its instruction budget was exhausted.
 * Therefore an exit-zero process can prove the course halt loop, but must never be
 * re-labelled as a step-limit stop merely because that was the requested policy.
 */
export function legacyMarsReplayStopPolicyIssue(context: ReplayAdapterContext): string | undefined {
  const policy = context.configuration.stopPolicy;
  if (policy?.kind === 'step-limit') {
    return 'phase-1 legacy MARS replay does not support step-limit stops because budget exhaustion cannot be verified';
  }
  if (policy?.kind !== 'halt-loop' || policy.haltPc === null || policy.haltPc === undefined) {
    return 'phase-1 legacy MARS replay requires a verifiable halt-loop stop policy';
  }
  return undefined;
}
