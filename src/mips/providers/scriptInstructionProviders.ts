// @index mips-providers — Script-aware builtin adapters bind one immutable ISA to assembly and execution
import { getProfile } from '../../config';
import { BuiltinTsAssemblerProvider, type BuiltinAssemblerWorkerRuntime } from './builtinAssemblerProvider';
import { BuiltinTsExecutionProvider, type BuiltinWorkerRuntime } from './builtinExecutionProvider';
import type { AssembleRequest, AssembleResult, ExecuteRequest, ExecuteResult, MipsAssemblerProvider, MipsExecutionProvider, ProviderPreflight, ProviderRunContext } from './contracts';
import { failedPreflight } from './contracts';
import type { ScriptInstructionBundle } from '../host/scriptInstructionBundle';
import type { ScriptInstructionInspection } from '../host/scriptInstructions';
import { bindScriptInstructionBundle, customInstructionAssemblyHint } from '../host/customInstructionService';
import { customInstructionsForResource } from '../host/customInstructionResource';
import { customInstructionModeForProfile } from '../core/custom/mode';
import { assertScriptArtifactMatches, withScriptInstructionArtifact } from '../replay/scriptInstructionArtifact';

interface AssemblyBinding {
  provider: BuiltinTsAssemblerProvider;
  bundle?: ScriptInstructionBundle;
  instructions?: readonly ScriptInstructionInspection[];
  requestedDigest?: string | null;
}

export class ScriptAwareAssemblerProvider implements MipsAssemblerProvider {
  private readonly standard: BuiltinTsAssemblerProvider;
  private readonly bindings = new WeakMap<AssembleRequest, AssemblyBinding>();
  get descriptor() { return this.standard.descriptor; }
  get capabilities() { return this.standard.capabilities; }
  constructor(private readonly runtime?: BuiltinAssemblerWorkerRuntime) { this.standard = new BuiltinTsAssemblerProvider(runtime); }

  async preflight(request: AssembleRequest, context?: ProviderRunContext): Promise<ProviderPreflight> {
    try {
      const resource = request.resourceUri ?? request.sourceUri;
      const selected = request.workspaceInstructions ?? await customInstructionsForResource(resource).select({
        policy: 'builtin', snapshot: request.scriptInstructions, runtime: this.runtime, signal: context?.signal
      });
      const script = selected.kind === 'script' ? selected : undefined;
      const bundle = script?.bundle;
      assertScriptArtifactMatches(request.expectedEngineArtifact, bundle);
      const provider = script ? new BuiltinTsAssemblerProvider(script.runtime) : this.standard;
      const instructions = await script?.inspect(context?.signal);
      const result = await provider.preflight(request);
      if (result.ok) this.bindings.set(request, { provider, bundle, instructions, requestedDigest: request.scriptInstructions === null ? null : request.scriptInstructions?.digest });
      return result;
    } catch (error) {
      this.bindings.delete(request);
      return failedPreflight(this.descriptor, [{ code: 'custom-script.load-failed', capability: 'custom-instructions', message: error instanceof Error ? error.message : String(error) }]);
    }
  }

  async assemble(request: AssembleRequest, context?: ProviderRunContext): Promise<AssembleResult> {
    if (!this.bindings.has(request)) {
      const result = await this.preflight(request, context);
      if (!result.ok) return this.failed(result.diagnostics.map(item => item.message).join('\n'));
    }
    const binding = this.bindings.get(request)!;
    this.bindings.delete(request);
    if (binding.requestedDigest !== (request.scriptInstructions === null ? null : request.scriptInstructions?.digest)) return this.failed('自定义指令请求在预检后发生变化');
    const result = await binding.provider.assemble(request, context);
    const mode = customInstructionModeForProfile(request.requirements?.profile ?? getProfile(request.resourceUri ?? request.sourceUri));
    if (!result.ok) {
      const hint = customInstructionAssemblyHint(result.assemblyDiagnostics, mode, binding.bundle ? 'script' : 'builtin', binding.instructions);
      return hint ? { ...result, status: { ...result.status, stderr: `${hint}\n${result.status.stderr}` } } : result;
    }
    if (!binding.bundle || !result.image) return result;
    return {
      ...result,
      customInstructionEncodings: binding.instructions?.filter(item => item.modes.includes(mode)),
      engineArtifact: withScriptInstructionArtifact(result.engineArtifact, binding.bundle),
      executionBinding: { kind: 'script-instructions', providerId: 'builtin-ts', imageFingerprint: result.image.fingerprint, bundle: binding.bundle }
    };
  }
  private failed(message: string): AssembleResult {
    return { ok: false, descriptor: this.descriptor, status: { ok: false, exitCode: null, stdout: '', stderr: message, timedOut: false, stopReason: 'engine-error' } };
  }
}

export class ScriptAwareExecutionProvider implements MipsExecutionProvider {
  private readonly standard: BuiltinTsExecutionProvider;
  private readonly bindings = new WeakMap<ExecuteRequest, { provider: BuiltinTsExecutionProvider; bundle?: ScriptInstructionBundle }>();
  get descriptor() { return this.standard.descriptor; }
  get capabilities() { return this.standard.capabilities; }
  constructor(private readonly runtime?: BuiltinWorkerRuntime) { this.standard = new BuiltinTsExecutionProvider(runtime); }
  async preflight(request: ExecuteRequest): Promise<ProviderPreflight> {
    try {
      const binding = request.executionBinding;
      let bundle: ScriptInstructionBundle | undefined;
      if (binding?.kind === 'script-instructions') {
        if (binding.providerId !== 'builtin-ts' || binding.imageFingerprint !== request.image.fingerprint) throw new Error('自定义指令与当前程序映像未绑定');
        bundle = binding.bundle;
      }
      const provider = bundle ? new BuiltinTsExecutionProvider(bindScriptInstructionBundle(bundle, this.runtime).runtime) : this.standard;
      const result = await provider.preflight(request);
      if (result.ok) this.bindings.set(request, { provider, bundle });
      return result;
    } catch (error) {
      return failedPreflight(this.descriptor, [{ code: 'custom-script.binding-invalid', capability: 'custom-instructions', message: error instanceof Error ? error.message : String(error) }]);
    }
  }
  async execute(request: ExecuteRequest, context?: ProviderRunContext): Promise<ExecuteResult> {
    if (!this.bindings.has(request)) {
      const preflight = await this.preflight(request);
      if (!preflight.ok) return { ok: false, descriptor: this.descriptor, status: { ok: false, exitCode: null, stdout: '', stderr: preflight.diagnostics.map(item => item.message).join('\n'), timedOut: false, stopReason: 'engine-error' } };
    }
    const binding = this.bindings.get(request)!;
    this.bindings.delete(request);
    if (binding.bundle && (request.executionBinding?.kind !== 'script-instructions'
      || request.executionBinding.bundle.digest !== binding.bundle.digest || request.executionBinding.imageFingerprint !== request.image.fingerprint)) {
      throw new Error('自定义指令执行绑定在预检后发生变化');
    }
    const result = await binding.provider.execute(request, context);
    return binding.bundle && result.engineArtifact ? { ...result, engineArtifact: withScriptInstructionArtifact(result.engineArtifact, binding.bundle) } : result;
  }
}
