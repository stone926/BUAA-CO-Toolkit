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

let defaultRegistry: ProviderRegistry | undefined;
let legacyProvider: LegacyMarsProvider | undefined;

/** Register the default provider set (currently legacy only). Idempotent per services instance. */
export function registerDefaultProviders(services: AppServices): ProviderRegistry {
  if (!defaultRegistry) {
    legacyProvider = new LegacyMarsProvider(services);
    defaultRegistry = {
      assemblerProviders: [legacyProvider],
      executionProviders: [legacyProvider]
    };
  }
  return defaultRegistry;
}

/** Registry for tests; production code uses registerDefaultProviders + resolve. */
export function setProviderRegistry(registry: ProviderRegistry | undefined): void {
  defaultRegistry = registry;
}

export function resolveAssemblerProvider(
  services: AppServices,
  request: AssembleRequest
): { provider: MipsAssemblerProvider; preflight: ProviderPreflight } {
  const registry = registerDefaultProviders(services);
  const provider = registry.assemblerProviders[0];
  return { provider, preflight: provider.preflight(request) };
}

export function resolveExecutionProvider(
  services: AppServices,
  request: ExecuteRequest
): { provider: MipsExecutionProvider; preflight: ProviderPreflight } {
  const registry = registerDefaultProviders(services);
  const provider = registry.executionProviders[0];
  return { provider, preflight: provider.preflight(request) };
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
