// @index mips-replay — 可运行的 legacy MARS exact replay adapter（无 VS Code/config 依赖）
import * as fs from 'fs';
import * as path from 'path';
import { runProcessCore } from '../../processCore';
import {
  courseDataDumpChunks,
  courseDataInitializationError,
  marsDumpExplicitlyEmpty,
  marsDumpFailureDiagnostic
} from '../../courseTesting/courseDataInitialization';
import {
  p7ExceptionHandlerAddress,
  p7KernelTextDumpEndAddress,
  p7UserTextBaseAddress
} from '../../courseTesting/p7Hardware';
import { courseTraceMarsHaltError } from '../legacy/haltValidation';
import { legacyMarsConfigurationPolicyIssues } from '../../language/mips/legacyMarsPolicy';
import { legacyMarsCompatibilityDiagnostic } from '../../language/mips/legacyMarsDiagnostics';
import {
  maximumReplayMachineCodeBytes,
  maximumReplaySteps,
  maximumReplayTraceBytes,
  maximumReplayWallClockMs,
  readBoundedRegularFile
} from './boundedFile';
import { createLegacyProgramImage } from './programImage';
import type {
  ReplayAdapterContext,
  ReplayAssemblyOutput,
  ReplayEngineAdapter,
  ReplayExecutableProgram,
  ReplayExecutionOutput
} from './types';
import type { ManifestEngineInfo } from '../../courseTesting/manifestCodec';
import {
  legacyMarsReplayStopPolicyIssue,
  validateLegacyMarsReplayAssembly,
  validateLegacyMarsReplayExecution
} from './legacyMarsContract';

const minimumUnambiguousMarsSteps = 32;
const selfBranch = '1000ffff';
const nop = '00000000';

export class LegacyMarsReplayAdapter implements ReplayEngineAdapter {
  readonly engineId = 'legacy-mars-configured';

  constructor(private readonly trustedRuntime: { javaCommand: string }) {
    if (!trustedRuntime.javaCommand || trustedRuntime.javaCommand.includes('\0')) {
      throw new Error('a trusted Java command is required for legacy MARS replay');
    }
  }

  supportsEngine(engine: ManifestEngineInfo): boolean {
    return engine.id === this.engineId
      && engine.semanticsRevision === 1
      && engine.capabilitiesRevision === 1
      && engine.catalogRevision === 1
      && engine.courseContractRevision === 1
      && engine.normalizerRevision === 1
      && engine.eventSchemaRevision === 1;
  }

  readonly validateAssembly = validateLegacyMarsReplayAssembly;
  readonly validateExecution = validateLegacyMarsReplayExecution;

  async assemble(context: ReplayAdapterContext): Promise<ReplayAssemblyOutput> {
    try {
      await fs.promises.mkdir(context.workingDirectory, { recursive: true });
      const outputFile = path.join(context.workingDirectory, 'replayed-code.txt');
      const dataFiles = courseDataDumpChunks.map((chunk) => path.join(context.workingDirectory, `data-${chunk.index}.txt`));
      // Match production: a legitimate unallocated MARS data block is an empty
      // pre-created file, not an unclassified missing output.
      await Promise.all(dataFiles.map((file) => fs.promises.writeFile(file, '')));
      const args = this.baseArgs(context);
      for (const chunk of courseDataDumpChunks) {
        args.push('dump', chunk.marsRange, 'HexText', dataFiles[chunk.index]);
      }
      args.push('a', 'dump', userTextRange(context.configuration.profile), 'HexText', outputFile, context.sourceRoot);
      const result = await this.run(context, args);
      if (!result.ok) return { ok: false, stdout: result.stdout, stderr: result.stderr };
      const compatibilityDiagnostic = this.compatibilityDiagnostic(context, result, 'dumpText');
      if (compatibilityDiagnostic) {
        return { ok: false, stdout: result.stdout, stderr: compatibilityDiagnostic };
      }
      const dumpDiagnostic = marsDumpFailureDiagnostic(result.stdout, result.stderr);
      if (dumpDiagnostic) {
        return { ok: false, stdout: result.stdout, stderr: `MARS dump failed: ${dumpDiagnostic}` };
      }
      const dataTexts = await Promise.all(dataFiles.map((file, index) =>
        readLegacyMarsDump(file, `MARS data dump ${index}`)));
      const dataIssue = courseDataInitializationError(dataTexts);
      if (dataIssue) return { ok: false, stdout: result.stdout, stderr: dataIssue };
      let text = await readLegacyMarsDump(outputFile, 'MARS user text dump');
      let stdout = result.stdout;
      let stderr = result.stderr;

      if (context.configuration.profile === 'P7') {
        const kernelFile = path.join(context.workingDirectory, 'replayed-kernel.txt');
        const kernelArgs = this.baseArgs(context);
        kernelArgs.push('a', 'dump', kernelTextRange(), 'HexText', kernelFile, context.sourceRoot);
        const kernelResult = await this.run(context, kernelArgs);
        stdout += kernelResult.stdout;
        stderr += kernelResult.stderr;
        if (!kernelResult.ok) return { ok: false, stdout, stderr };
        const kernelCompatibilityDiagnostic = this.compatibilityDiagnostic(context, kernelResult, 'dumpKernel');
        if (kernelCompatibilityDiagnostic) {
          return { ok: false, stdout, stderr: `${stderr}\n${kernelCompatibilityDiagnostic}` };
        }
        const kernelDiagnostic = marsDumpFailureDiagnostic(kernelResult.stdout, kernelResult.stderr);
        if (kernelDiagnostic) {
          return { ok: false, stdout, stderr: `${stderr}\nMARS kernel dump failed: ${kernelDiagnostic}` };
        }
        const explicitlyEmpty = marsDumpExplicitlyEmpty(kernelResult.stdout, kernelResult.stderr);
        let kernel = '';
        try { kernel = await readLegacyMarsDump(kernelFile, 'MARS P7 kernel dump'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (!explicitlyEmpty) {
            return { ok: false, stdout, stderr: `${stderr}\nMARS did not produce the P7 kernel dump` };
          }
        }
        if (kernel.trim().length === 0 && !explicitlyEmpty) {
          return { ok: false, stdout, stderr: `${stderr}\nMARS produced an empty P7 kernel dump without explicitly reporting an empty segment` };
        }
        text = mergeP7Image(text, kernel);
      }
      const dutBytes = Buffer.from(text, 'utf8');
      return {
        ok: true,
        image: createLegacyProgramImage(text, context.inputGraph),
        dutBytes,
        stdout,
        stderr
      };
    } catch (error) {
      return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
    }
  }

  async execute(
    context: ReplayAdapterContext,
    program: ReplayExecutableProgram
  ): Promise<ReplayExecutionOutput> {
    try {
      const stopPolicyIssue = legacyMarsReplayStopPolicyIssue(context);
      if (stopPolicyIssue) {
        return { ok: false, stdout: '', stderr: stopPolicyIssue, stopReason: 'error' };
      }
      // Stock/modified MARS executes an ASM path and cannot consume an arbitrary ProgramImage.
      // Reassemble in an isolated lane and prove byte-for-byte that the image it is about to
      // execute is the assembler output supplied through the provider contract.
      const proof = await this.assemble({
        ...context,
        stdinBytes: context.stdinBytes ? Uint8Array.from(context.stdinBytes) : undefined,
        workingDirectory: path.join(context.workingDirectory, 'assembly-proof')
      });
      if (!proof.ok || !proof.image || !proof.dutBytes) {
        return {
          ok: false,
          stdout: proof.stdout,
          stderr: `legacy MARS could not prove the executable image: ${proof.stderr || 'assembly failed'}`,
          stopReason: 'error'
        };
      }
      if (proof.image.fingerprint !== program.image.fingerprint
        || !Buffer.from(proof.dutBytes).equals(Buffer.from(program.dutBytes))) {
        return {
          ok: false,
          stdout: proof.stdout,
          stderr: 'legacy MARS reassembly does not match the ProgramImage supplied to the execution adapter',
          stopReason: 'error'
        };
      }
      await fs.promises.mkdir(context.workingDirectory, { recursive: true });
      const args = this.baseArgs(context);
      const options = context.configuration.executionOptions;
      const courseInvocation = options?.courseTrace === true || options?.traceOutput === true;
      if (options?.traceOutput) args.push(options.traceLevel === 2 ? 'coL2' : 'coL1');
      if (context.configuration.profile === 'P7' && courseInvocation) {
        args.push('efc');
        const schedule = context.configuration.deviceTimeline?.events.map((event) => event.value) ?? [];
        if (schedule.length) {
          args.push(`p7irq=${schedule.map((pc) => `0x${((pc - 4) >>> 0).toString(16)}`).join(',')}`);
        }
      }
      const limit = context.configuration.stepPolicy?.limit;
      if (courseInvocation && limit !== null && limit !== undefined) {
        args.push(String(Math.max(limit, minimumUnambiguousMarsSteps)));
      }
      args.push(context.sourceRoot);
      const result = await this.run(context, args, decodeStdin(context.stdinBytes));
      if (!result.ok) return { ok: false, stdout: result.stdout, stderr: result.stderr, stopReason: 'error' };
      const compatibilityDiagnostic = this.compatibilityDiagnostic(context, result, 'run');
      if (compatibilityDiagnostic) {
        return { ok: false, stdout: result.stdout, stderr: compatibilityDiagnostic, stopReason: 'error' };
      }
      const haltPc = context.configuration.stopPolicy!.haltPc!;
      const haltIssue = courseTraceMarsHaltError(result.stdout, haltPc);
      if (haltIssue) return { ok: false, stdout: result.stdout, stderr: haltIssue, stopReason: 'error' };
      return { ok: true, stdout: result.stdout, stderr: result.stderr, stopReason: 'halt-loop' };
    } catch (error) {
      return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error), stopReason: 'error' };
    }
  }

  private baseArgs(context: ReplayAdapterContext): string[] {
    const policyIssues = legacyMarsConfigurationPolicyIssues(
      context.configuration.profile,
      context.configuration.memoryConfiguration,
      'run',
      true
    );
    if (policyIssues.length) {
      throw new Error(`recorded legacy MARS configuration violates launch policy: ${policyIssues[0].message}`);
    }
    const options = context.configuration.executionOptions;
    let args: string[];
    if (options?.p7RiInstruction) {
      const instructionClass = context.dependencies.get('mars-p7-ri-instruction-class');
      if (!instructionClass) throw new Error('P7 RI exact replay requires mars-p7-ri-instruction-class in the immutable registry');
      args = ['-cp', `${context.artifactPath}${path.delimiter}${path.dirname(instructionClass)}`, 'Mars', 'nc', 'mc', context.configuration.memoryConfiguration];
    } else {
      args = ['-jar', context.artifactPath, 'nc', 'mc', context.configuration.memoryConfiguration];
    }
    if (options?.delayedBranching) args.push('db');
    if (options?.p7RiInstruction) args.push('cl', path.basename(context.dependencies.get('mars-p7-ri-instruction-class')!));
    args.push('ae1', 'se1');
    return args;
  }

  private compatibilityDiagnostic(
    context: ReplayAdapterContext,
    result: { stdout: string; stderr: string },
    mode: 'run' | 'dumpText' | 'dumpKernel'
  ): string | undefined {
    const options = context.configuration.executionOptions;
    return legacyMarsCompatibilityDiagnostic({
      stdout: result.stdout,
      stderr: result.stderr,
      mode,
      traceOutput: mode === 'run' && options?.traceOutput === true,
      courseTrace: mode === 'run' && (options?.courseTrace === true || options?.traceOutput === true),
      p7RiInstruction: options?.p7RiInstruction === true,
      memoryConfiguration: context.configuration.memoryConfiguration
    });
  }

  private async run(context: ReplayAdapterContext, args: string[], stdin?: string) {
    const runtime = context.configuration.runtime;
    if (!runtime || runtime.kind !== 'java' || !runtime.command) throw new Error('legacy MARS replay requires a recorded Java runtime command');
    if (runtime.command !== this.trustedRuntime.javaCommand) {
      throw new Error('recorded Java command is not authorized by the trusted replay runtime policy');
    }
    const wallClockMs = context.configuration.resourceLimits?.wallClockMs;
    const maxSteps = context.configuration.resourceLimits?.maxSteps;
    if (!Number.isSafeInteger(wallClockMs) || (wallClockMs ?? 0) <= 0
      || (wallClockMs ?? 0) > maximumReplayWallClockMs) {
      throw new Error(`legacy MARS replay wall-clock limit must be within 1..${maximumReplayWallClockMs} ms`);
    }
    if (maxSteps !== null && (!Number.isSafeInteger(maxSteps) || (maxSteps ?? 0) <= 0
      || (maxSteps ?? 0) > maximumReplaySteps)) {
      throw new Error(`legacy MARS replay step limit must be within 1..${maximumReplaySteps}`);
    }
    return await runProcessCore(this.trustedRuntime.javaCommand, args, {
      cwd: context.workingDirectory,
      timeoutMs: wallClockMs,
      maxStdoutBytes: maximumReplayTraceBytes,
      maxStderrBytes: maximumReplayTraceBytes,
      stdin,
      signal: context.signal
    });
  }
}

async function readLegacyMarsDump(file: string, label: string): Promise<string> {
  const bytes = await readBoundedRegularFile(file, {
    maximumBytes: maximumReplayMachineCodeBytes,
    label
  });
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not lossless UTF-8`);
  return text;
}

function decodeStdin(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined;
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) throw new Error('legacy MARS stdin is not lossless UTF-8');
  return text;
}

function userTextRange(profile: string): string {
  return `${hex(p7UserTextBaseAddress)}-${hex(profile === 'P7' ? p7ExceptionHandlerAddress : p7KernelTextDumpEndAddress)}`;
}

function kernelTextRange(): string { return `${hex(p7ExceptionHandlerAddress)}-${hex(p7KernelTextDumpEndAddress)}`; }
function hex(value: number): string { return `0x${(value >>> 0).toString(16).padStart(8, '0')}`; }

function mergeP7Image(userText: string, kernelText: string): string {
  const user = strictLines(userText);
  const kernel = strictLines(kernelText);
  if (!kernel.length) return `${user.join('\n')}\n`;
  const start = (p7ExceptionHandlerAddress - p7UserTextBaseAddress) / 4;
  if (user.length > start) throw new Error('P7 user text overlaps the exception handler');
  // Course replay sources already carry the required branch+nop terminator.
  if (user.length < 2 || user[user.length - 2].toLowerCase() !== selfBranch || user[user.length - 1].toLowerCase() !== nop) {
    throw new Error('P7 replayed user text lacks the captured course halt loop');
  }
  const merged = [...user];
  while (merged.length < start) merged.push(nop);
  kernel.forEach((word, index) => { merged[start + index] = word; });
  return `${merged.join('\n')}\n`;
}

function strictLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) throw new Error('MARS HexText has a bare CR');
  const lines = normalized.split('\n').filter((line) => line.length > 0);
  if (!lines.every((line) => /^[0-9a-fA-F]{8}$/.test(line))) throw new Error('MARS HexText contains a malformed word');
  return lines;
}
