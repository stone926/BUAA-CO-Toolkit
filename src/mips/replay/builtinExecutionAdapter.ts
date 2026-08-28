// @index mips-replay — builtin TS executor 的 exact replay / re-evaluate adapter（进程内、无 VS Code）

import * as fs from 'fs';
import * as path from 'path';

import type { ProgramImage, SourceUnit } from '../core/api';
import { CourseProfile } from '../core/generated/isaCatalog';
import {
  executeProgramForService,
  maximumExecuteSteps
} from '../core/machine/executeService';
import { assembleCourseSource } from '../core/assembler/assembler';
import { imageSegmentWords, wordsToHexText } from '../core/assembler/artifacts';
import type { ManifestEngineInfo } from '../../courseTesting/manifestCodec';
import {
  builtinExecutionArtifactMatchesBytes
} from './builtinEngineArtifact';
import { builtinAssemblerArtifactMatchesBytes } from './builtinAssemblerEngineArtifact';
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

  async assemble(context: ReplayAdapterContext): Promise<ReplayAssemblyOutput> {
    try {
      const identityIssue = await this.verifyStagedAssemblerArtifact(context);
      if (identityIssue) return { ok: false, stdout: '', stderr: identityIssue };
      const profile = context.configuration.profile as CourseProfile;
      if (!supportedProfiles.has(profile)) {
        return {
          ok: false,
          stdout: '',
          stderr: `builtin-ts assembler does not support profile ${profile}`
        };
      }
      const rootFile = path.resolve(context.sourceRoot);
      const rootId = context.inputGraph[0]?.id;
      if (!rootId) {
        return { ok: false, stdout: '', stderr: 'builtin-ts assembler replay has no root source id' };
      }
      const maximumBytes = context.configuration.resourceLimits?.maxSourceBytes ?? 8 * 1024 * 1024;
      const cache = new Map<string, SourceUnit>();
      const readMaterialized = (file: string, id: string): SourceUnit => {
        const cached = cache.get(id);
        if (cached) return cached;
        const bytes = fs.readFileSync(file);
        if (bytes.byteLength > maximumBytes) {
          throw new Error(`materialized source ${file} exceeds ${maximumBytes} bytes`);
        }
        const unit: SourceUnit = Object.freeze({ id, text: bytes.toString('utf8') });
        cache.set(id, unit);
        return unit;
      };
      const materializedId = (specifier: string): string | undefined => {
        const base = path.basename(specifier.replace(/\\/g, '/'));
        const extension = path.extname(base);
        if (!extension) return base;
        return base.slice(0, -extension.length);
      };
      const resolveMaterialized = (specifier: string): SourceUnit | undefined => {
        const id = materializedId(specifier);
        if (!id) return undefined;
        const directory = path.dirname(rootFile);
        for (const extension of ['.asm', '.s', '.mips']) {
          const candidate = path.join(directory, `${id}${extension}`);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return readMaterialized(candidate, id);
          }
        }
        return undefined;
      };
      const assembled = assembleCourseSource(readMaterialized(rootFile, rootId), {
        profile,
        p7RiInstruction: context.configuration.executionOptions?.p7RiInstruction ?? false,
        sourceResolver: { resolve: ({ specifier }) => resolveMaterialized(specifier) },
        sourceLimits: {
          maxDepth: context.configuration.resourceLimits?.maxIncludeDepth ?? 32,
          maxUnits: context.configuration.resourceLimits?.maxIncludeUnits ?? 256,
          maxBytes: maximumBytes
        }
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
      const identityIssue = await this.verifyStagedExecutionArtifact(context);
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
