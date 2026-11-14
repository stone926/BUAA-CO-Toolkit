// @index mips-providers — Script-aware builtin adapters bind one immutable ISA to assembly and execution
import * as path from 'path';
import * as vscode from 'vscode';
import { getProfile } from '../../config';
import { BuiltinTsAssemblerProvider, type BuiltinAssemblerWorkerRuntime } from './builtinAssemblerProvider';
import { BuiltinTsExecutionProvider, type BuiltinWorkerRuntime } from './builtinExecutionProvider';
import type { AssembleRequest, AssembleResult, ExecuteRequest, ExecuteResult, MipsAssemblerProvider, MipsExecutionProvider, ProviderPreflight, ProviderRunContext } from './contracts';
import { failedPreflight } from './contracts';
import type { ScriptInstructionBundle } from '../host/scriptInstructionBundle';
import { validateScriptInstructionBundle } from '../host/scriptInstructionBundle';
import { captureScriptInstructions, createScriptRuntime, inspectScriptInstructions } from '../host/scriptInstructions';
import { assertScriptArtifactMatches, withScriptInstructionArtifact } from '../replay/scriptInstructionArtifact';

interface AssemblyBinding { provider: BuiltinTsAssemblerProvider; bundle?: ScriptInstructionBundle; requestedDigest?: string | null }

export class ScriptAwareAssemblerProvider implements MipsAssemblerProvider {
  private readonly standard: BuiltinTsAssemblerProvider;
  private readonly bindings = new WeakMap<AssembleRequest, AssemblyBinding>();
  get descriptor() { return this.standard.descriptor; }
  get capabilities() { return this.standard.capabilities; }
  constructor(private readonly runtime?: BuiltinAssemblerWorkerRuntime) { this.standard = new BuiltinTsAssemblerProvider(runtime); }

  async preflight(request: AssembleRequest, context?: ProviderRunContext): Promise<ProviderPreflight> {
    try {
      const resource = request.resourceUri ?? request.sourceUri;
      const root = vscode.workspace.getWorkspaceFolder?.(resource)?.uri.fsPath ?? path.dirname(resource.fsPath);
      const bundle = request.scriptInstructions === undefined
        ? await captureScriptInstructions(root, { signal: context?.signal })
        : request.scriptInstructions === null ? undefined : validateScriptInstructionBundle(request.scriptInstructions);
      assertScriptArtifactMatches(request.expectedEngineArtifact, bundle);
      const provider = bundle ? new BuiltinTsAssemblerProvider(createScriptRuntime(bundle, this.runtime)) : this.standard;
      if (bundle) await inspectScriptInstructions(bundle, this.runtime, undefined, { signal: context?.signal });
      const result = await provider.preflight(request);
      if (result.ok) this.bindings.set(request, { provider, bundle, requestedDigest: request.scriptInstructions === null ? null : request.scriptInstructions?.digest });
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
    if (!binding.bundle) return result;
    if (!result.ok || !result.image) return { ...result, scriptInstructions: binding.bundle };
    const mode = (request.requirements?.profile ?? getProfile(request.resourceUri ?? request.sourceUri));
    const inspected = await inspectScriptInstructions(binding.bundle, this.runtime, undefined, { signal: context?.signal });
    return {
      ...result,
      scriptInstructions: binding.bundle,
      customInstructionEncodings: inspected.filter(item => (item.modes as readonly string[]).includes(mode === 'P2' ? 'mars' : mode)),
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
        bundle = validateScriptInstructionBundle(binding.bundle);
      }
      const provider = bundle ? new BuiltinTsExecutionProvider(createScriptRuntime(bundle, this.runtime)) : this.standard;
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
