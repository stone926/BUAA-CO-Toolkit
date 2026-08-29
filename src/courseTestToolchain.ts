import type { MipsEngineMode } from './config';
import { getEffectiveRequiredTools } from './toolchainPolicy';
import { ProjectProfile, ToolDetection } from './types';

export const MARS_P7_CHECK = 'MARS P7 efc/p7irq';

export function courseTraceMemoryConfigurationError(profile: ProjectProfile, memoryConfiguration: string): string | undefined {
  if (profile === 'P7') {
    return memoryConfiguration === 'CompactLargeText'
      ? undefined
      : `P7 持续生成测试必须使用 CompactLargeText，当前为 ${memoryConfiguration}`;
  }
  return memoryConfiguration === 'FixedCompactLargeText' || memoryConfiguration === 'CompactLargeText'
    ? undefined
    : `非 P7 Trace 测试应使用 FixedCompactLargeText 或 CompactLargeText，当前为 ${memoryConfiguration}`;
}

/** Memory-layout compatibility matters only when a legacy MARS lane will run. */
export function courseTraceMemoryConfigurationErrorForEngine(
  profile: ProjectProfile,
  mode: MipsEngineMode,
  memoryConfiguration: string
): string | undefined {
  const tools = normalizedEffectiveTools(profile, mode);
  return hasMarsTool(tools)
    ? courseTraceMemoryConfigurationError(profile, memoryConfiguration)
    : undefined;
}

/** Detection names required by the course trace preflight for the effective tool policy. */
export function requiredCourseTraceToolchainChecks(
  profile: ProjectProfile,
  mode: MipsEngineMode,
  memoryConfiguration: string
): Set<string> {
  const tools = normalizedEffectiveTools(profile, mode);
  const required = new Set<string>();
  if (tools.has('java')) {
    required.add('Java');
  }
  if (hasMarsTool(tools)) {
    required.add('MARS');
    // coL2 proves the validated final self-branch executed before MARS reaches its step limit.
    required.add('MARS coL2');
  }
  if (tools.has('logisim')) {
    required.add('Logisim');
  }
  if (tools.has('ise')) {
    required.add('ISE fuse');
  }
  if (hasMarsTool(tools)) {
    required.add(`MARS ${memoryConfiguration}`);
  }
  if (tools.has('marsp7')) {
    required.add(MARS_P7_CHECK);
  }
  return required;
}

export function formatToolchainFailure(check: ToolDetection): string {
  return `${check.name} ${check.detail}${check.suggestion ? `（${check.suggestion}）` : ''}`;
}

/** Automatic reports identify the missing capability without exposing commands or local paths. */
export function formatAutomaticToolchainFailure(check: ToolDetection): string {
  return `${check.name} 不可用，请检查工具链设置`;
}

export function requiredToolchainFailures(
  checks: readonly ToolDetection[],
  requiredNames: ReadonlySet<string>
): ToolDetection[] {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const failures: ToolDetection[] = [];
  for (const name of requiredNames) {
    const check = byName.get(name);
    if (!check) {
      failures.push({
        name,
        ok: false,
        detail: '未执行能力检查',
        suggestion: '请更新插件或检查所选 Profile 的工具链配置'
      });
    } else if (!check.ok) {
      failures.push(check);
    }
  }
  return failures;
}

function normalizedEffectiveTools(profile: ProjectProfile, mode: MipsEngineMode): Set<string> {
  return new Set(getEffectiveRequiredTools(profile, mode).map((tool) => tool.trim().toLowerCase()));
}

function hasMarsTool(tools: ReadonlySet<string>): boolean {
  return tools.has('mars') || tools.has('marsp7');
}
