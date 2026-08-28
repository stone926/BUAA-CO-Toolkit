// @index mips-replay — builtin TS executor 的 exact replay / re-evaluate adapter（进程内、无 VS Code）

import type { ProgramImage } from '../core/api';
import { CourseProfile } from '../core/generated/isaCatalog';
import {
  executeProgramForServiceAsync,
  maximumExecuteSteps
} from '../core/machine/executeService';
import { commitEventsCanonical } from '../core/events/commitEvent';
import { assembleProgramForService } from '../core/assembler/assemblyService';
import { imageSegmentWords, wordsToHexText } from '../core/assembler/artifacts';
import type { ManifestEngineInfo } from '../../courseTesting/manifestCodec';
import {
  builtinExecutionArtifactMatchesBytes,
  builtinExecutionArtifactRole,
  builtinExecutionEngineDocument
} from './builtinEngineArtifact';
import {
  builtinAssemblerArtifactMatchesBytes,
  builtinAssemblerArtifactRole,
  builtinAssemblerEngineDocument
} from './builtinAssemblerEngineArtifact';
import { sha256Canonical, type CanonicalJson } from './canonical';
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
    const role = engine.artifact?.role;
    const semanticsRevision = role === builtinAssemblerArtifactRole
      ? builtinAssemblerEngineDocument().engine.semanticsRevision
      : builtinExecutionEngineDocument().engine.semanticsRevision;
    return engine.id === this.engineId
      && (role === undefined || role === builtinExecutionArtifactRole || role === builtinAssemblerArtifactRole)
      && engine.semanticsRevision === semanticsRevision
      && engine.capabilitiesRevision === 1
      && engine.catalogRevision === 1
      && engine.courseContractRevision === 1
      && engine.normalizerRevision === 1
      && engine.eventSchemaRevision === 1;
  }

  async assemble(context: ReplayAdapterContext): Promise<ReplayAssemblyOutput> {
    try {
      if (context.signal?.aborted) return replayAssemblyCancelled();
      const identityIssue = await this.verifyStagedAssemblerArtifact(context);
      if (identityIssue) return { ok: false, stdout: '', stderr: identityIssue };
      if (context.signal?.aborted) return replayAssemblyCancelled();
      const profile = context.configuration.profile as CourseProfile;
      if (!supportedProfiles.has(profile)) {
        return {
          ok: false,
          stdout: '',
          stderr: `builtin-ts assembler does not support profile ${profile}`
        };
      }
      const graph = context.sourceGraphInput;
      if (!graph || !graph.sources.some((source) => source.id === graph.rootId)) {
        return {
          ok: false,
          stdout: '',
          stderr: 'builtin-ts assembler replay requires the verified original source graph'
        };
      }
      const rootIndex = graph.sources.findIndex((source) => source.id === graph.rootId);
      const orderedSources = [
        graph.sources[rootIndex],
        ...graph.sources.slice(0, rootIndex),
        ...graph.sources.slice(rootIndex + 1)
      ];
      const assembled = assembleProgramForService({
        profile,
        sources: orderedSources,
        includes: graph.includes,
        p7RiInstruction: context.configuration.executionOptions?.p7RiInstruction ?? false,
      });
      if (!assembled.ok || !assembled.image) {
        return {
          ok: false,
          stdout: '',
          stderr: assembled.diagnostics.map((diagnostic) => `[${diagnostic.code}] ${diagnostic.message}`).join('\n')
        };
      }
      const textWords = imageSegmentWords(assembled.image, 'text');
      if (!textWords.length) {
        return {
          ok: false,
          stdout: '',
          stderr: 'builtin-ts assembler replay produced no user text segment'
        };
      }
      return {
        ok: true,
        image: assembled.image,
        dutBytes: Buffer.from(wordsToHexText(textWords), 'utf8'),
        stdout: '',
        stderr: ''
      };
    } catch (error) {
      return {
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async execute(
    context: ReplayAdapterContext,
    program: ReplayExecutableProgram
  ): Promise<ReplayExecutionOutput> {
    try {
      if (context.signal?.aborted) return replayExecutionCancelled();
      const identityIssue = await this.verifyStagedExecutionArtifact(context);
      if (identityIssue) return { ok: false, stdout: '', stderr: identityIssue, stopReason: 'error' };
      if (context.signal?.aborted) return replayExecutionCancelled();
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
      const result = await executeProgramForServiceAsync({
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
      }, {
        aborted: () => context.signal?.aborted === true,
        ...(context.signal ? {
          onSlice: async () => await new Promise<void>((resolve) => setImmediate(resolve))
        } : {})
      });
      const stdout = result.trace?.join('\n') ?? '';
      const eventDigest = sha256Canonical(commitEventsCanonical(result.events) as CanonicalJson);
      const stopReason = result.haltReason === 'cancelled'
        ? 'cancelled'
        : result.status === 'halted' ? 'halt-loop'
        : result.status === 'step-limit' ? 'step-limit' : 'error';
      return {
        ok: stopReason === 'halt-loop',
        stdout,
        stderr: stopReason === 'halt-loop' ? '' : stopReason === 'cancelled'
          ? 'builtin-ts replay cancelled'
          : result.diagnostic
          ? `[${result.diagnostic.code}] ${result.diagnostic.message}`
          : `builtin-ts execution stopped with ${result.status}`,
        stopReason,
        structuredEvidence: {
          steps: result.instructions,
          eventCount: result.eventCount,
          eventDigest,
          finalStateDigest: result.finalStateDigest
        }
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

  private async verifyStagedAssemblerArtifact(context: ReplayAdapterContext): Promise<string | undefined> {
    try {
      const bytes = await readBoundedRegularFile(context.artifactPath, {
        maximumBytes: 1024 * 1024,
        label: 'builtin-ts assembler logical engine artifact'
      });
      return builtinAssemblerArtifactMatchesBytes(bytes)
        ? undefined
        : 'staged builtin-ts artifact does not match this compiled assembler revision tuple';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async verifyStagedExecutionArtifact(context: ReplayAdapterContext): Promise<string | undefined> {
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

function replayAssemblyCancelled(): ReplayAssemblyOutput {
  return { ok: false, stdout: '', stderr: 'builtin-ts assembler replay cancelled' };
}

function replayExecutionCancelled(): ReplayExecutionOutput {
  return {
    ok: false,
    stdout: '',
    stderr: 'builtin-ts replay cancelled',
    stopReason: 'cancelled'
  };
}
