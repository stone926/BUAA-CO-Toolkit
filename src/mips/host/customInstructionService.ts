// @index mips-host — Workspace custom ISA selection, inspection and bound invocation
import type { AssemblerDiagnostic } from '../core/assembler/diagnostics';
import type { CustomInstructionMetadata, CustomInstructionMode } from '../core/custom/api';
import type { CourseProfile } from '../core/generated/isaCatalog';
import { customInstructionDirectory, customInstructionRelativeDirectory, customMarsClassNames, readCustomInstructionFiles } from './customInstructionFiles';
import { captureCustomMarsEnvironment, type CustomMarsSettings } from './customMarsArtifacts';
import { invokeCustomMars } from './customMarsBridge';
import { captureScriptInstructions, createScriptRuntime, inspectScriptInstructions, type ScriptInstructionInspection, type ScriptRuntimeHost } from './scriptInstructions';
import type { ScriptInstructionBundle } from './scriptInstructionBundle';

export type CustomInstructionPolicy = 'auto' | 'builtin' | 'mars';

export interface ScriptInstructionBinding {
  readonly kind: 'script';
  readonly bundle: ScriptInstructionBundle;
  readonly runtime: ScriptRuntimeHost;
  inspect(signal?: AbortSignal): Promise<readonly ScriptInstructionInspection[]>;
}

export interface MarsInstructionSelection {
  readonly kind: 'mars';
  bind(signal?: AbortSignal): Promise<BoundMarsInstructions>;
}

export interface BoundMarsInstructions {
  readonly identity: Awaited<ReturnType<typeof captureCustomMarsEnvironment>>['identity'];
  readonly java: string;
  readonly timeoutMs: number;
  run(request: Parameters<typeof invokeCustomMars>[1]): ReturnType<typeof invokeCustomMars>;
}

export type CustomInstructionSelection = { readonly kind: 'builtin' } | ScriptInstructionBinding | MarsInstructionSelection;

interface SelectionOptions {
  policy?: CustomInstructionPolicy;
  /** null freezes an empty script registry (e.g. for replay). */
  snapshot?: ScriptInstructionBundle | null;
  runtime?: ScriptRuntimeHost;
  signal?: AbortSignal;
}

export class WorkspaceCustomInstructions {
  constructor(readonly root: string, private readonly marsSettings?: () => CustomMarsSettings) {}

  captureScripts(signal?: AbortSignal): Promise<ScriptInstructionBundle | undefined> {
    return captureScriptInstructions(this.root, { signal });
  }

  /** Choose one engine for the complete program. Selection never depends on assembly error text. */
  async select(options: SelectionOptions = {}): Promise<CustomInstructionSelection> {
    const { policy = 'auto', snapshot, runtime, signal } = options;
    signal?.throwIfAborted();
    const files = policy === 'mars' || snapshot === undefined || (policy === 'auto' && snapshot === null)
      ? await readCustomInstructionFiles(this.root) : [];
    if (policy !== 'mars') {
      const bundle = snapshot === undefined ? await captureScriptInstructions(this.root, { signal }, files) : snapshot;
      if (bundle) return bindScriptInstructionBundle(bundle, runtime);
      if (policy === 'builtin') return { kind: 'builtin' };
    }
    const classes = customMarsClassNames(files);
    signal?.throwIfAborted();
    if (!classes.length && policy === 'auto') return { kind: 'builtin' };
    return {
      kind: 'mars',
      bind: async (bindSignal = signal) => {
        if (!classes.length) throw new Error(`未找到顶层自定义指令 .class；请将课程文件放入 ${customInstructionDirectory(this.root)}`);
        const settings = this.marsSettings?.() ?? { jar: '', java: 'java', timeoutMs: 30_000 };
        const environment = await captureCustomMarsEnvironment(this.root, classes, settings, bindSignal);
        return { identity: environment.identity, java: environment.java, timeoutMs: environment.timeoutMs,
          run: request => invokeCustomMars(environment, request) };
      }
    };
  }

  async inspect(signal?: AbortSignal) {
    const selected = await this.select({ signal });
    if (selected.kind === 'script') return { instructions: await selected.inspect(signal), marsInstructions: [] };
    if (selected.kind === 'builtin') return { instructions: [], marsInstructions: [] };
    const bound = await selected.bind(signal);
    const { result, payload } = await bound.run({ mode: 'inspect', signal });
    if (!result.ok || !payload) throw new Error(result.stderr || '魔改 Mars 未返回自定义指令元数据');
    return { instructions: [], marsInstructions: payload.customInstructions };
  }
}

/** A saved script snapshot can be invoked without ever consulting today's workspace. */
export function bindScriptInstructionBundle(bundle: ScriptInstructionBundle, runtime?: ScriptRuntimeHost): ScriptInstructionBinding {
  const bound = createScriptRuntime(bundle, runtime);
  return { kind: 'script', bundle, runtime: bound, inspect: signal => inspectScriptInstructions(bundle, runtime, undefined, { signal }) };
}

export function courseModeForConsoleAssembly(
  diagnostics: readonly AssemblerDiagnostic[], instructions: readonly CustomInstructionMetadata[], profile?: CourseProfile
): CourseProfile | undefined {
  if (profile && findReferencedInstructions(diagnostics, instructions).some(item =>
    item.modes.includes(profile) && !item.modes.includes('mars'))) return profile;
}

export function customInstructionAssemblyHint(
  diagnostics: readonly AssemblerDiagnostic[] | undefined, mode: CustomInstructionMode, selection: 'builtin' | 'script',
  instructions: readonly CustomInstructionMetadata[] = []
): string | undefined {
  if (!diagnostics?.some(item => item.code === 'asm.instruction.unknown')) return undefined;
  const names = [...new Set(diagnostics.flatMap(item => item.code === 'asm.instruction.unknown' && item.mnemonic ? [item.mnemonic] : []))];
  const unknown = names.length ? `未知指令 ${names.slice(0, 8).join('、')}` : '存在未知指令';
  if (selection === 'builtin') {
    return `${unknown}。工作区 ${customInstructionRelativeDirectory} 未找到自定义指令定义；请检查助记符或添加对应的 JS/TS 定义或课程 .class。`;
  }
  const inactive = findReferencedInstructions(diagnostics, instructions).filter(item => !item.modes.includes(mode));
  if (inactive.length) return inactive.map(item =>
    `${item.mnemonic} 的定义仅在 ${item.modes.join('/')} 生效，当前指令模式为 ${mode}。`).join('\n');
  return `${unknown}。请检查 ${customInstructionRelativeDirectory} 中的 JS/TS 定义是否导出了当前模式下的指令。`;
}

function findReferencedInstructions(diagnostics: readonly AssemblerDiagnostic[], instructions: readonly CustomInstructionMetadata[]) {
  const names = new Set(diagnostics.filter(item => item.code === 'asm.instruction.unknown').map(item => item.mnemonic));
  return instructions.filter(item => names.has(item.mnemonic) || item.aliases?.some(alias => names.has(alias)));
}
