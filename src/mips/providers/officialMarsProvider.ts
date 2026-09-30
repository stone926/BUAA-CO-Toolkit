// @index mips-providers — 原版 MARS P2 汇编适配；课程执行由 builtin provider 提供
import type { AppServices } from '../../types';
import { runMarsFile } from '../../mips';
import { resolveLegacyMarsLaunch, type ResolvedLegacyMarsLaunch } from './legacyMarsLaunch';
import { OFFICIAL_MARS_ENGINE_ID } from './courseEnginePolicy';
import {
  LEGACY_MARS_CAPABILITIES, capabilityRequirementDiagnostics, failedPreflight, okPreflight,
  type AssembleRequest, type AssembleResult, type ExecuteRequest, type ExecuteResult,
  type MipsAssemblerProvider, type MipsExecutionProvider, type ProviderRunContext,
  type ProviderPreflight
} from './contracts';

export class OfficialMarsProvider implements MipsAssemblerProvider, MipsExecutionProvider {
  private readonly launches = new WeakMap<AssembleRequest, ResolvedLegacyMarsLaunch>();
  readonly descriptor = {
    id: OFFICIAL_MARS_ENGINE_ID, kind: 'assembler' as const,
    build: 'user-configured official MARS 4.5', semanticsRevision: 1, capabilitiesRevision: 1
  };
  readonly capabilities = {
    ...LEGACY_MARS_CAPABILITIES,
    profiles: ['P2'],
    syscalls: { modes: ['mars-services'] as const, deterministic: false },
    devices: [],
    executionFeatures: [],
    console: { deterministicInput: false, deterministicOutput: false, interactive: false }
  };

  constructor(private readonly services: AppServices) {}

  async preflight(request: AssembleRequest | ExecuteRequest): Promise<ProviderPreflight> {
    if (!('target' in request)) return this.executionUnsupported();
    const diagnostics = [];
    if (request.courseTrace || request.target.kind === 'kernelText' || request.p7RiInstruction) {
      diagnostics.push({ code: 'official-mars.course-unsupported', capability: 'course-oracle',
        message: '原版 MARS 仅用于 P2 汇编与控制台；课程汇编和执行请使用内置引擎' });
    }
    const resolution = await resolveLegacyMarsLaunch(request.sourceUri, 'dumpText', {
      courseTrace: request.courseTrace, p7RiInstruction: request.p7RiInstruction
    });
    diagnostics.push(...resolution.diagnostics);
    diagnostics.push(...capabilityRequirementDiagnostics(this.descriptor, this.capabilities,
      request.requirements, resolution.launch?.profile));
    if (resolution.launch?.profile !== 'P2' && resolution.launch) {
      diagnostics.push({ code: 'official-mars.profile-unsupported', capability: 'profile:P2',
        message: '课程 Profile 的机器码导出请使用内置汇编器；原版 MARS provider 仅支持 P2' });
    }
    if (!diagnostics.length && resolution.launch) this.launches.set(request, resolution.launch);
    return diagnostics.length ? failedPreflight(this.descriptor, diagnostics) : okPreflight(this.descriptor);
  }

  async assemble(request: AssembleRequest, context?: ProviderRunContext): Promise<AssembleResult> {
    const preflight = await this.preflight(request);
    if (!preflight.ok) return { ok: false, descriptor: this.descriptor, status: this.failureStatus(preflight) };
    const output = await runMarsFile(this.services, request.sourceUri, 'dumpText', {
      showMessages: false, revealOutput: request.revealOutput, dumpOutputFile: request.target.outputFile,
      signal: context?.signal, nonInteractive: context?.nonInteractive, resolvedLaunch: this.launches.get(request)
    });
    if (!output) return { ok: false, descriptor: this.descriptor,
      status: this.failureStatus(failedPreflight(this.descriptor, [{ code: 'official-mars.cancelled', message: 'MARS 汇编已取消' }])) };
    return { ok: output.result.ok, descriptor: this.descriptor, status: output.result,
      outputFile: output.outputFile, engineArtifact: output.engineArtifact, resolvedRun: output.resolvedRun };
  }

  async execute(_request: ExecuteRequest): Promise<ExecuteResult> {
    return { ok: false, descriptor: this.descriptor, status: this.failureStatus(this.executionUnsupported()) };
  }

  private executionUnsupported(): ProviderPreflight {
    return failedPreflight(this.descriptor, [{ code: 'official-mars.program-image-unsupported',
      capability: 'program-image-execution', message: '原版 MARS 不支持课程 ProgramImage/写回 Trace；请使用内置引擎，控制台程序请使用 MARS 运行命令' }]);
  }

  private failureStatus(preflight: ProviderPreflight) {
    return { ok: false, exitCode: null, stdout: '', timedOut: false,
      stderr: preflight.diagnostics.map((item) => `[${item.code}] ${item.message}`).join('\n') };
  }
}
