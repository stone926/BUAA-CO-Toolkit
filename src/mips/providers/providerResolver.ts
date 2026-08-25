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
  const registry = {
    assemblerProviders: [legacyProvider],
    executionProviders: [legacyProvider]
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
): { provider: MipsAssemblerProvider; preflight: ProviderPreflight } {
  const registry = registerDefaultProviders(services);
  return resolveFirstCapable(registry.assemblerProviders, request, 'assembler');
}

export function resolveExecutionProvider(
  services: AppServices,
  request: ExecuteRequest
): { provider: MipsExecutionProvider; preflight: ProviderPreflight } {
  const registry = registerDefaultProviders(services);
  return resolveFirstCapable(registry.executionProviders, request, 'execution');
}

function resolveFirstCapable<R, T extends { preflight(request: R): ProviderPreflight }>(
  providers: readonly T[],
  request: R,
  kind: 'assembler' | 'execution'
): { provider: T; preflight: ProviderPreflight } {
  if (!providers.length) {
    throw new Error(`No ${kind} provider is registered.`);
  }
  let firstFailure: { provider: T; preflight: ProviderPreflight } | undefined;
  for (const provider of providers) {
    const preflight = provider.preflight(request);
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
  const { provider, preflight } = resolveAssemblerProvider(services, request);
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
  const { provider, preflight } = resolveExecutionProvider(services, request);
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
