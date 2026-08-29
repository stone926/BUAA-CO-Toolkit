// @index mips-providers — provider 解析：唯一入口，preflight 在副作用前完成，禁止半途 fallback
import { AppServices } from '../../types';
import { getMipsEngine, getProfile } from '../../config';
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
import {
  BUILTIN_TS_ENGINE_ID,
  type CourseEnginePlan,
  type CourseProviderEngineId,
  LEGACY_MARS_ENGINE_ID,
  resolveCourseEnginePlan
} from './courseEnginePolicy';

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

/** Register the phase-6 provider set. Resolution policy, not array order, selects a lane. */
export function registerDefaultProviders(services: AppServices): ProviderRegistry {
  if (registryOverride) {
    return registryOverride;
  }
  const existing = defaultRegistries.get(services);
  if (existing) {
    return existing;
  }
  const legacyProvider = new LegacyMarsProvider(services);
  // Keep registration order stable for evidence/tests. Phase-6 resolution is
  // by the immutable plan's engine id and never relies on this order.
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
  request: AssembleRequest,
  selection?: CourseEnginePlan
): Promise<{
  provider: MipsAssemblerProvider;
  preflight: ProviderPreflight;
  selection: CourseEnginePlan;
}> {
  const registry = registerDefaultProviders(services);
  const effectiveSelection = selection ?? resolveCourseEnginePlan(
    getMipsEngine(request.sourceUri),
    request.requirements?.profile ?? getProfile(request.sourceUri),
    request.requirements
  );
  return resolvePlannedProvider(
    registry.assemblerProviders,
    effectiveSelection.primaryEngineId,
    request,
    'assembler',
    effectiveSelection
  );
}

export function resolveExecutionProvider(
  services: AppServices,
  request: ExecuteRequest,
  selection?: CourseEnginePlan
): Promise<{
  provider: MipsExecutionProvider;
  preflight: ProviderPreflight;
  selection: CourseEnginePlan;
}> {
  const registry = registerDefaultProviders(services);
  // ExecuteRequest has no resource URI. The course orchestrator must pass the
  // assembly-time snapshot to preserve an explicit resource-scoped setting.
  // A standalone execution request intentionally receives only the safe auto
  // policy; it must never read an unrelated active editor/workspace setting.
  const effectiveSelection = selection ?? resolveCourseEnginePlan(
    'auto',
    request.requirements?.profile ?? request.profile,
    {
      deterministicConsole: request.requirements?.deterministicConsole === true
        || request.stdin !== undefined
        || request.stdinSource !== undefined,
      interactiveConsole: request.requirements?.interactiveConsole
    }
  );
  return resolvePlannedProvider(
    registry.executionProviders,
    effectiveSelection.primaryEngineId,
    request,
    'execution',
    effectiveSelection
  );
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
  return resolveExactProvider(provider, request);
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
  return resolveExactProvider(provider, request);
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

async function resolveExactProvider<
  R,
  T extends { preflight(request: R): ProviderPreflight | Promise<ProviderPreflight> }
>(provider: T, request: R): Promise<{ provider: T; preflight: ProviderPreflight }> {
  return { provider, preflight: await provider.preflight(request) };
}

async function resolvePlannedProvider<
  R,
  T extends {
    readonly descriptor: { readonly id: string };
    preflight(request: R): ProviderPreflight | Promise<ProviderPreflight>;
  }
>(
  providers: readonly T[],
  engineId: CourseProviderEngineId,
  request: R,
  kind: 'assembler' | 'execution',
  selection: CourseEnginePlan
): Promise<{ provider: T; preflight: ProviderPreflight; selection: CourseEnginePlan }> {
  const provider = providers.find((candidate) => candidate.descriptor.id === engineId);
  if (provider) {
    return {
      ...await resolveExactProvider(provider, request),
      selection
    };
  }

  // setProviderRegistry is a test seam. Preserve its historical support for
  // arbitrary fake providers (and one-provider adapter tests), while keeping
  // the production registry and every standard phase-6 selection exact.
  if (registryOverride && (providers.length === 1 || providers.some((candidate) =>
    !isCourseProviderEngineId(candidate.descriptor.id)))) {
    return {
      ...await resolveFirstCapable(providers, request, kind),
      selection
    };
  }
  throw new Error(`No ${kind} provider is registered for selected engine "${engineId}".`);
}

function isCourseProviderEngineId(engineId: string): engineId is CourseProviderEngineId {
  return engineId === LEGACY_MARS_ENGINE_ID || engineId === BUILTIN_TS_ENGINE_ID;
}

/** Convenience: run preflight, fail closed with a structured result when unsupported. */
export async function assembleWithPreflight(
  services: AppServices,
  request: AssembleRequest,
  context?: ProviderRunContext,
  selection?: CourseEnginePlan
): Promise<{
  ok: boolean;
  result?: AssembleResult;
  preflight: ProviderPreflight;
}> {
  const { provider, preflight } = await resolveAssemblerProvider(
    services,
    request,
    selection
  );
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
  context?: ProviderRunContext,
  selection?: CourseEnginePlan
): Promise<{
  ok: boolean;
  result?: ExecuteResult;
  preflight: ProviderPreflight;
}> {
  const { provider, preflight } = await resolveExecutionProvider(
    services,
    request,
    selection
  );
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
