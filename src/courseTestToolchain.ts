import type { MipsEngineMode } from './config';
import { getEffectiveRequiredTools } from './toolchainPolicy';
import { ProjectProfile, ToolDetection } from './types';

/** Compatibility API: builtin course layouts are independent of MARS settings. */
export function courseTraceMemoryConfigurationError(_profile: ProjectProfile, _memoryConfiguration: string): string | undefined {
  return undefined;
}

/** Compatibility API retained for existing course preflight callers. */
export function courseTraceMemoryConfigurationErrorForEngine(
  _profile: ProjectProfile,
  _mode: MipsEngineMode,
  _memoryConfiguration: string
): string | undefined {
  return undefined;
}

/** Detection names required by the course trace preflight for the effective tool policy. */
export function requiredCourseTraceToolchainChecks(
  profile: ProjectProfile,
  mode: MipsEngineMode,
  _memoryConfiguration: string
): Set<string> {
  const tools = normalizedEffectiveTools(profile, mode);
  const required = new Set<string>();
  if (tools.has('java')) {
    required.add('Java');
  }
  if (tools.has('logisim')) {
    required.add('Logisim');
  }
  if (tools.has('verilogsimulator')) {
    required.add('Verilog simulator');
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
