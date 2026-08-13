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

export function formatToolchainFailure(check: ToolDetection): string {
  return `${check.name} ${check.detail}${check.suggestion ? `（${check.suggestion}）` : ''}`;
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
