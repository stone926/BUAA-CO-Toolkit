// @index mips-providers — LegacyMarsProvider：完整包装现有 runMarsFile 行为（dumpText/dumpKernel/run）
import * as vscode from 'vscode';
import { getMarsJar, getProfile } from '../../config';
import { runMarsFile, MarsRunOptions } from '../../mips';
import { AppServices } from '../../types';
import {
  AssembleRequest,
  AssembleResult,
  CapabilityDiagnostic,
  ExecuteRequest,
  ExecuteResult,
  EngineRunStatus,
  failedPreflight,
  LEGACY_MARS_CAPABILITIES,
  LEGACY_MARS_DESCRIPTOR,
  MipsAssemblerProvider,
  MipsExecutionProvider,
  okPreflight,
  ProviderPreflight,
  ProviderRunContext
} from './contracts';

/**
 * Wraps the existing MARS pipeline unchanged so phase-1 callers become
 * provider-neutral without any behavior change. The engine executes with the
 * user-configured fork build (as before); the pinned v0.6.3 reference is a
 * conformance-only role and must not be substituted here.
 */
export class LegacyMarsProvider implements MipsAssemblerProvider, MipsExecutionProvider {
  readonly descriptor = LEGACY_MARS_DESCRIPTOR;
  readonly capabilities = LEGACY_MARS_CAPABILITIES;

  constructor(private readonly services: AppServices) {}

  preflight(request: AssembleRequest | ExecuteRequest): ProviderPreflight {
    const diagnostics: CapabilityDiagnostic[] = [];
    const profile = getProfile(request.sourceUri);
    if (!['P2', 'P3', 'P4', 'P5', 'P6', 'P7'].includes(profile)) {
      diagnostics.push({
        code: 'legacy-mars.profile-unsupported',
        capability: `profile:${profile}`,
        message: `legacy MARS provider 不支持 profile ${profile}（支持 P2–P7）`
      });
    }
    if (!getMarsJar(request.sourceUri)) {
      diagnostics.push({
        code: 'legacy-mars.jar-not-configured',
        capability: 'legacy-mars',
        message: 'MARS jar 未配置。请设置 co.toolchain.mars 或 co.toolchain.marsP7'
      });
    }
    if ('imageRef' in request && request.imageRef.kind === 'program-image') {
      diagnostics.push({
        code: 'legacy-mars.program-image-unsupported',
        capability: 'program-image-execution',
        message: 'legacy MARS provider 不能执行 ProgramImage；它只能运行与已验证 MARS dump 对应的源文件'
      });
    }
    if ('imageRef' in request && request.courseTrace) {
      const haltPc = request.haltPc ?? (request.imageRef.kind === 'mars-dump' ? request.imageRef.haltPc : undefined);
      if (!Number.isSafeInteger(request.maxSteps) || (request.maxSteps ?? 0) <= 0) {
        diagnostics.push({
          code: 'legacy-mars.max-steps-required',
          capability: 'bounded-execution',
          message: '课程 oracle 运行必须提供正整数 maxSteps'
        });
      }
      if (!Number.isSafeInteger(haltPc) || (haltPc ?? -1) < 0 || (haltPc ?? 0) > 0xffff_ffff) {
        diagnostics.push({
          code: 'legacy-mars.halt-pc-required',
          capability: 'halt-loop-detection',
          message: '课程 oracle 运行必须提供由机器码 dump 验证得到的 haltPc'
        });
      }
    }
    if (diagnostics.length) {
      return failedPreflight(this.descriptor, diagnostics);
    }
    return okPreflight(this.descriptor);
  }

  async assemble(request: AssembleRequest, context?: ProviderRunContext): Promise<AssembleResult> {
    const mode = request.target.kind === 'kernelText' ? 'dumpKernel' : 'dumpText';
    const marsOptions: MarsRunOptions = {
      showMessages: false,
      revealOutput: request.revealOutput ?? false,
      courseTrace: request.courseTrace,
      p7RiInstruction: request.p7RiInstruction,
      dumpOutputFile: request.target.outputFile,
      signal: context?.signal
    };
    const output = await runMarsFile(this.services, request.sourceUri, mode, marsOptions);
    return {
      ok: output?.result.ok ?? false,
      outputFile: output?.outputFile,
      courseHaltPc: output?.courseHaltPc,
      status: engineRunStatus(output?.result),
      descriptor: this.descriptor,
      engineArtifact: output?.engineArtifact
    };
  }

  async execute(request: ExecuteRequest, context?: ProviderRunContext): Promise<ExecuteResult> {
    // The legacy engine re-assembles and re-executes from source; the validated
    // dump reference stays available to callers for image-level checking.
    const marsOptions: MarsRunOptions = {
      showMessages: false,
      revealOutput: request.revealOutput ?? false,
      stdin: request.stdin,
      stdinSource: request.stdinSource,
      courseTrace: request.courseTrace,
      traceOutput: request.traceOutput,
      traceLevel: request.traceLevel,
      runOutputFile: request.runOutputFile,
      interruptSchedule: request.interruptSchedule,
      p7RiInstruction: request.p7RiInstruction,
      maxSteps: request.maxSteps,
      haltPc: request.haltPc ?? (request.imageRef.kind === 'mars-dump' ? request.imageRef.haltPc : undefined),
      signal: context?.signal
    };
    const output = await runMarsFile(this.services, request.sourceUri, 'run', marsOptions);
    return {
      ok: output?.result.ok ?? false,
      outputFile: output?.outputFile,
      status: engineRunStatus(output?.result),
      descriptor: this.descriptor,
      engineArtifact: output?.engineArtifact
    };
  }
}

function engineRunStatus(result: {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stopped?: boolean;
  stopReason?: string;
  commandLine?: string;
  cwd?: string;
} | undefined): EngineRunStatus {
  if (result) {
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      stopped: result.stopped,
      stopReason: result.stopReason,
      commandLine: result.commandLine,
      cwd: result.cwd
    };
  }
  return {
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: 'legacy MARS provider：运行被拒绝（profile 未确定或工具未配置）',
    timedOut: false
  };
}
