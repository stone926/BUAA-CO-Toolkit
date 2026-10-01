// @index mars-args — Legacy MARS profile/memory launch policy shared by preflight and replay
import { courseProfileIds } from '../../generated/projectProfiles';

export const OFFICIAL_MARS_MEMORY_CONFIGURATIONS = [
  'Default', 'CompactDataAtZero', 'CompactTextAtZero'
] as const;

/** P7 课程约定：异常处理程序入口 0x4180 需要大内存布局。 */
export const P7_COURSE_MEMORY_CONFIG = 'CompactLargeText';

/** 支持大文本段（容纳 0x3000→0x4180+ 异常处理程序）的内存配置名称。 */
export const LARGE_TEXT_MEMORY_CONFIGS = new Set([
  'FixedCompactLargeText',
  'CompactLargeText'
]);

export const LEGACY_MARS_SUPPORTED_PROFILES = new Set([
  'P2', ...courseProfileIds
]);

export type LegacyMarsPolicyMode = 'run' | 'dumpText' | 'dumpKernel';

export interface LegacyMarsConfigurationPolicyIssue {
  code: string;
  message: string;
  capability: string;
}

export function isLargeTextMemoryConfiguration(value: string): boolean {
  return LARGE_TEXT_MEMORY_CONFIGS.has(value);
}

/**
 * Pure policy shared by production preflight and exact-replay closure checks.
 * This module deliberately has no VS Code/config/file-system dependency.
 */
export function legacyMarsConfigurationPolicyIssues(
  profile: string,
  memoryConfiguration: string,
  mode: LegacyMarsPolicyMode,
  courseInvocation: boolean
): LegacyMarsConfigurationPolicyIssue[] {
  const issues: LegacyMarsConfigurationPolicyIssue[] = [];
  if (!LEGACY_MARS_SUPPORTED_PROFILES.has(profile)) {
    issues.push({
      code: 'legacy-mars.profile-unsupported',
      message: `legacy MARS provider 不支持 profile ${profile}（支持 ${[...LEGACY_MARS_SUPPORTED_PROFILES].join('/')}）`,
      capability: `profile:${profile}`
    });
    return issues;
  }
  if (profile === 'P7') {
    if ((mode === 'dumpText' || mode === 'dumpKernel' || courseInvocation)
      && memoryConfiguration !== P7_COURSE_MEMORY_CONFIG) {
      issues.push({
        code: 'legacy-mars.p7-memory-configuration',
        message: `P7 课程 dump/oracle 必须使用 ${P7_COURSE_MEMORY_CONFIG}，当前为 ${memoryConfiguration}`,
        capability: 'p7-memory-layout'
      });
    }
  } else if (courseInvocation && !isLargeTextMemoryConfiguration(memoryConfiguration)) {
    issues.push({
      code: 'legacy-mars.course-memory-configuration',
      message: `非 P7 课程 oracle 必须使用 FixedCompactLargeText 或 CompactLargeText，当前为 ${memoryConfiguration}`,
      capability: 'course-memory-layout'
    });
  }
  return issues;
}

/** Standard MARS launch policy; the policy above only validates archived fork evidence. */
export function officialMarsConfigurationPolicyIssues(
  _profile: string,
  memoryConfiguration: string,
  mode: LegacyMarsPolicyMode,
  courseInvocation: boolean
): LegacyMarsConfigurationPolicyIssue[] {
  const issues: LegacyMarsConfigurationPolicyIssue[] = [];
  if (!(OFFICIAL_MARS_MEMORY_CONFIGURATIONS as readonly string[]).includes(memoryConfiguration)) {
    issues.push({ code: 'official-mars.memory-configuration', capability: 'memory-layout',
      message: `原版 MARS 不支持内存配置 ${memoryConfiguration}；请选择 Default、CompactDataAtZero 或 CompactTextAtZero` });
  }
  if (courseInvocation || mode === 'dumpKernel') {
    issues.push({ code: 'official-mars.course-unsupported', capability: 'course-oracle',
      message: '原版 MARS 不提供课程写回 Trace、P7 异常/Timer/中断或 0x4180 内核导出；请使用内置引擎的汇编导出和 CPU 测试' });
  }
  return issues;
}
