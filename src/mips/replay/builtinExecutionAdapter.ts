// @index mips-replay — builtin TS executor 的 exact replay / re-evaluate adapter（进程内、无 VS Code）

import * as fs from 'fs';

import type { ProgramImage } from '../core/api';
import { CourseProfile } from '../core/generated/isaCatalog';
import {
  executeProgramForService,
  maximumExecuteSteps
} from '../core/machine/executeService';
import type { ManifestEngineInfo } from '../../courseTesting/manifestCodec';
import {
  builtinExecutionArtifactMatchesBytes
} from './builtinEngineArtifact';
import { readBoundedRegularFile } from './boundedFile';
import type {
  ReplayAdapterContext,
  ReplayAssemblyOutput,
  ReplayEngineAdapter,
  ReplayExecutableProgram,
  ReplayExecutionOutput
} from './types';

const supportedProfiles = new Set<CourseProfile>(['P3', 'P4', 'P5', 'P6', 'P7']);

export class BuiltinTsReplayAdapter implements ReplayEngineAdapter {
  readonly engineId = 'builtin-ts';

  supportsEngine(engine: ManifestEngineInfo): boolean {
    return engine.id === this.engineId
      && engine.semanticsRevision === 1
      && engine.capabilitiesRevision === 1
      && engine.catalogRevision === 1
      && engine.courseContractRevision === 1
      && engine.normalizerRevision === 1
      && engine.eventSchemaRevision === 1;
  }

  async assemble(_context: ReplayAdapterContext): Promise<ReplayAssemblyOutput> {
    return {
      ok: false,
      stdout: '',
      stderr: 'builtin-ts is executor-only; assembler replay requires the phase-5 builtin assembler'
    };
  }

  async execute(
    context: ReplayAdapterContext,
    program: ReplayExecutableProgram
  ): Promise<ReplayExecutionOutput> {
    try {
      const identityIssue = await this.verifyStagedArtifact(context);
      if (identityIssue) return { ok: false, stdout: '', stderr: identityIssue, stopReason: 'error' };
      if (context.stdinBytes?.length) {
        return {
          ok: false,
          stdout: '',
          stderr: 'builtin-ts executor has no stdin syscall host; this case cannot exact-replay on builtin',
          stopReason: 'error'
        };
      }
      const profile = context.configuration.profile as CourseProfile;
      if (!supportedProfiles.has(profile)) {
        return { ok: false, stdout: '', stderr: `builtin-ts does not support profile ${profile}`, stopReason: 'error' };
      }
      const schedule = context.configuration.deviceTimeline?.events ?? [];
      const result = executeProgramForService({
        profile,
        enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
        segments: program.image.segments.map((segment) => ({
          name: segment.name,
          baseAddress: segment.baseAddress,
          words: segment.words
        })),
        entryPc: program.image.entryPc,
        maxSteps: Math.min(
          context.configuration.stepPolicy?.limit ?? maximumExecuteSteps,
          maximumExecuteSteps
        ),
        haltPc: context.configuration.stopPolicy?.haltPc ?? undefined,
        externalInterrupts: schedule
          .filter((event) => event.kind === 'external-interrupt')
          .map((event) => ({ victimPc: event.value >>> 0, occurrence: 1 })),
        collectTrace: true
      });
      const stdout = result.trace ? `${result.trace.join('\n')}\n` : '';
      const stopReason = result.status === 'halted'
        ? 'halt-loop'
        : result.status === 'step-limit' ? 'step-limit' : 'error';
      return {
        ok: stopReason === 'halt-loop',
        stdout,
        stderr: stopReason === 'halt-loop' ? '' : result.diagnostic
          ? `[${result.diagnostic.code}] ${result.diagnostic.message}`
          : `builtin-ts execution stopped with ${result.status}`,
        stopReason
      };
    } catch (error) {
      return {
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        stopReason: 'error'
      };
    }
  }

  validateExecution(
    _context: ReplayAdapterContext,
    assembly: ReplayAssemblyOutput,
    output: ReplayExecutionOutput
  ): string | undefined {
    if (!assembly.image) return 'builtin execution replay has no assembled ProgramImage';
    if (!output.ok) return undefined; // execute() already carries the stable error.
    if (output.stopReason !== 'halt-loop') {
      return `builtin-ts replay must stop at the course halt loop, got ${output.stopReason}`;
    }
    return undefined;
  }

  private async verifyStagedArtifact(context: ReplayAdapterContext): Promise<string | undefined> {
    try {
      const bytes = await readBoundedRegularFile(context.artifactPath, {
        maximumBytes: 1024 * 1024,
        label: 'builtin-ts logical engine artifact'
      });
      return builtinExecutionArtifactMatchesBytes(bytes)
        ? undefined
        : 'staged builtin-ts artifact does not match this compiled executor revision tuple';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

export function replayProgramImageFrom(program: ReplayExecutableProgram): ProgramImage {
  return program.image;
}
