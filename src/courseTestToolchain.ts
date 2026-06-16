import { ProjectProfile, ToolDetection } from './types';

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
