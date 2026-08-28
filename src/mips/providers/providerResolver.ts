// @index mips-providers — provider 解析：唯一入口，preflight 在副作用前完成，禁止半途 fallback
import { AppServices } from '../../types';
import {
  AssembleRequest,
  AssembleResult,
  ExecuteRequest,
  ExecuteResult,
  MipsAssemblerProvider,
  MipsExecutionProvider,
  ProviderPreflight,
  ProviderRunContext
} from './contracts';
import { BuiltinTsExecutionProvider } from './builtinExecutionProvider';
import { BuiltinTsAssemblerProvider } from './builtinAssemblerProvider';
import { LegacyMarsProvider } from './legacyMarsProvider';

/**
 * Provider resolver（计划第 5.3/9 节）。
 *
 * 阶段 1 只注册 legacy；`builtin-ts` 在对应阶段 gate 通过后按
 * profile/capability 分项注册。解析失败（preflight not ok）时调用方必须以
 * 结构化诊断结束任务——任何 provider 都不允许在部分执行后隐式 fallback。
 */

interface ProviderRegistry {
  assemblerProviders: MipsAssemblerProvider[];
  executionProviders: MipsExecutionProvider[];
}

let registryOverride: ProviderRegistry | undefined;
let defaultRegistries = new WeakMap<AppServices, ProviderRegistry>();

/** Register the default provider set (currently legacy only). Idempotent per services instance. */
export function registerDefaultProviders(services: AppServices): ProviderRegistry {
  if (registryOverride) {
    return registryOverride;
  }
  const existing = defaultRegistries.get(services);
  if (existing) {
    return existing;
  }
  const legacyProvider = new LegacyMarsProvider(services);
  // Phase 4/5: builtin engines are registered behind legacy so the default
  // course pipeline stays on MARS. They are reachable through explicit
  // provider-id resolution (shadow / verify-both) until phase 6.
  const builtinAssemblerProvider = new BuiltinTsAssemblerProvider(services.mipsRuntime);
  const builtinExecutionProvider = new BuiltinTsExecutionProvider(services.mipsRuntime);
  const registry = {
    assemblerProviders: [legacyProvider, builtinAssemblerProvider],
    executionProviders: [legacyProvider, builtinExecutionProvider]
  };
  defaultRegistries.set(services, registry);
  return registry;
}

/** Registry for tests; production code uses registerDefaultProviders + resolve. */
export function setProviderRegistry(registry: ProviderRegistry | undefined): void {
  registryOverride = registry;
  if (!registry) {
    // Test isolation: do not retain providers bound to a previous AppServices.
    defaultRegistries = new WeakMap<AppServices, ProviderRegistry>();
  }
}

export function resolveAssemblerProvider(
  services: AppServices,
  request: AssembleRequest
): Promise<{ provider: MipsAssemblerProvider; preflight: ProviderPreflight }> {
  const registry = registerDefaultProviders(services);
  const providers = registryOverride ? registry.assemblerProviders : registry.assemblerProviders.slice(0, 1);
  return resolveFirstCapable(providers, request, 'assembler');
}

export function resolveExecutionProvider(
  services: AppServices,
  request: ExecuteRequest
): Promise<{ provider: MipsExecutionProvider; preflight: ProviderPreflight }> {
  const registry = registerDefaultProviders(services);
  const providers = registryOverride ? registry.executionProviders : registry.executionProviders.slice(0, 1);
  return resolveFirstCapable(providers, request, 'execution');
}
/** Resolve a specific assembler engine for explicit phase-5/full-stack runs. */
export function resolveAssemblerProviderById(
  services: AppServices,
  engineId: string,
  request: AssembleRequest
): Promise<{ provider: MipsAssemblerProvider; preflight: ProviderPreflight }> {
  const registry = registerDefaultProviders(services);
  const provider = registry.assemblerProviders.find((entry) => entry.descriptor.id === engineId);
  if (!provider) {
    throw new Error(`No assembler provider is registered for engine "${engineId}".`);
  }
  return resolveFirstCapable([provider], request, 'assembler');
}

/** Resolve a specific execution engine for explicit shadow / verify-both runs. */
export function resolveExecutionProviderById(
  services: AppServices,
  engineId: string,
  request: ExecuteRequest
): Promise<{ provider: MipsExecutionProvider; preflight: ProviderPreflight }> {
  const registry = registerDefaultProviders(services);
  const provider = registry.executionProviders.find((entry) => entry.descriptor.id === engineId);
  if (!provider) {
    throw new Error(`No execution provider is registered for engine "${engineId}".`);
  }
  return resolveFirstCapable([provider], request, 'execution');
}

/** Convenience for explicit phase-5 builtin assembler / full-stack lanes. */
export function resolveBuiltinAssemblerProvider(
  services: AppServices,
  request: AssembleRequest
): Promise<{ provider: MipsAssemblerProvider; preflight: ProviderPreflight }> {
  return resolveAssemblerProviderById(services, 'builtin-ts', request);
}

/** Convenience for the phase-4 builtin executor shadow lane. */
export function resolveBuiltinExecutionProvider(
  services: AppServices,
  request: ExecuteRequest
): Promise<{ provider: MipsExecutionProvider; preflight: ProviderPreflight }> {
  return resolveExecutionProviderById(services, 'builtin-ts', request);
}

async function resolveFirstCapable<R, T extends { preflight(request: R): ProviderPreflight | Promise<ProviderPreflight> }>(
  providers: readonly T[],
  request: R,
  kind: 'assembler' | 'execution'
): Promise<{ provider: T; preflight: ProviderPreflight }> {
  if (!providers.length) {
    throw new Error(`No ${kind} provider is registered.`);
  }
  let firstFailure: { provider: T; preflight: ProviderPreflight } | undefined;
  for (const provider of providers) {
    const preflight = await provider.preflight(request);
    if (preflight.ok) {
      return { provider, preflight };
    }
    firstFailure ??= { provider, preflight };
  }
  return firstFailure!;
}

/** Convenience: run preflight, fail closed with a structured result when unsupported. */
export async function assembleWithPreflight(
  services: AppServices,
  request: AssembleRequest,
  context?: ProviderRunContext
): Promise<{ ok: boolean; result?: AssembleResult; preflight: ProviderPreflight }> {
  const { provider, preflight } = await resolveAssemblerProvider(services, request);
  if (!preflight.ok) {
    return { ok: false, preflight };
  }
  const result = await provider.assemble(request, context);
  return { ok: result.ok, result, preflight };
}

/** Convenience: run preflight, fail closed with a structured result when unsupported. */
export async function executeWithPreflight(
  services: AppServices,
  request: ExecuteRequest,
  context?: ProviderRunContext
): Promise<{ ok: boolean; result?: ExecuteResult; preflight: ProviderPreflight }> {
  const { provider, preflight } = await resolveExecutionProvider(services, request);
  if (!preflight.ok) {
    return { ok: false, preflight };
  }
  const result = await provider.execute(request, context);
  return { ok: result.ok, result, preflight };
}

/** Render a preflight failure as a single human-readable message (stable codes preserved). */
export function preflightFailureMessage(preflight: ProviderPreflight): string {
  return preflight.diagnostics
    .map((diagnostic) => `[${diagnostic.code}] ${diagnostic.message}`)
    .join('\n');
}
