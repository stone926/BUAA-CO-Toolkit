import { ProjectProfile, ToolDetection } from './types';

export const MARS_COURSE_IM_CHECK = 'MARS course IM';
export const MARS_P7_CONTRACT_CHECK = 'MARS P7 contract';

interface ProcessProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

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

/**
 * Evaluate the negative probe which deliberately leaves the dumped user text, executes a
 * MARS-only `.ktext` trampoline, then returns to the validated halt tail. A capable course
 * oracle must reject the fetch itself; merely reaching coHalt would let the software oracle
 * observe instructions that can never exist in the DUT instruction memory.
 */
export function courseInstructionAddressCapability(
  result: ProcessProbeResult,
  p7PaddingResult?: ProcessProbeResult
): ToolDetection {
  const combined = `${result.stdout}\n${result.stderr}`;
  const rejectedByCourseFetchGuard = /course instruction address (?:out of range|not loaded)/i.test(combined);
  const reachedCourseHalt = /Program reached course halt loop at\s+(?:0x)?[0-9a-f]{1,8}\b/i.test(combined);
  const paddingOutput = p7PaddingResult ? `${p7PaddingResult.stdout}\n${p7PaddingResult.stderr}` : '';
  const p7PaddingMatchesLoadedImage = !p7PaddingResult || (
    p7PaddingResult.ok
    && /Program reached course halt loop at\s+(?:0x)?[0-9a-f]{1,8}\b/i.test(paddingOutput)
    && /@[0-9a-f]{4,8}:\s*\$\s*5\s*<=\s*0000600d\b/i.test(paddingOutput)
    && !/@[0-9a-f]{4,8}:\s*\$\s*4\s*<=\s*00000001\b/i.test(paddingOutput)
  );
  const ok = !result.ok && rejectedByCourseFetchGuard && !reachedCourseHalt && p7PaddingMatchesLoadedImage;
  return {
    name: MARS_COURSE_IM_CHECK,
    ok,
    detail: firstNonEmptyLine(`${combined}\n${paddingOutput}`) || '无课程取指地址校验输出',
    suggestion: ok
      ? undefined
      : '请使用会拒绝 P3–P7 程序取指进入未装载 DUT 指令存储区的 Mars-with-BUAA-CO-extension 修改版 MARS'
  };
}

/** Require explicit rejection of P7 inputs which the tutorial promises never to grade. */
export function p7CourseContractCapability(
  userInterruptGeneratorAccess: ProcessProbeResult,
  invalidHandlerInterruptGeneratorAccess: ProcessProbeResult,
  handlerException: ProcessProbeResult,
  handlerInterrupt: ProcessProbeResult,
  validPendingInterruptHandler: ProcessProbeResult
): ToolDetection {
  const probes = [
    { result: userInterruptGeneratorAccess, expected: /interrupt-generator access/i },
    { result: invalidHandlerInterruptGeneratorAccess, expected: /interrupt-generator access/i },
    { result: handlerException, expected: /synchronous exception/i },
    { result: handlerInterrupt, expected: /(?:new HWInt bit|interrupted before execution)/i }
  ];
  const outputs = probes.map(({ result }) => `${result.stdout}\n${result.stderr}`);
  const validPendingInterruptOutput = `${validPendingInterruptHandler.stdout}\n${validPendingInterruptHandler.stderr}`;
  const explicitlyRejected = probes.every(({ result, expected }, index) =>
    !result.ok
    && /Course P7 test contract violation/i.test(outputs[index])
    && expected.test(outputs[index])
    && !/Program reached course halt loop at\s+(?:0x)?[0-9a-f]{1,8}\b/i.test(outputs[index]));
  const acceptsPendingAtEntry = validPendingInterruptHandler.ok
    && /Program reached course halt loop at\s+(?:0x)?00003010\b/i.test(validPendingInterruptOutput)
    && /@[0-9a-f]{4,8}:\s*\$\s*7\s*<=\s*0000600d\b/i.test(validPendingInterruptOutput)
    && !/Course P7 test contract violation/i.test(validPendingInterruptOutput);
  const ok = explicitlyRejected && acceptsPendingAtEntry;
  return {
    name: MARS_P7_CONTRACT_CHECK,
    ok,
    detail: ok
      ? 'IG 指令/区域、handler 内异常/新中断及入场 pending 中断契约探针通过'
      : firstNonEmptyLine(`${outputs.join('\n')}\n${validPendingInterruptOutput}`) || '无 P7 测试数据契约校验输出',
    suggestion: ok
      ? undefined
      : '请使用会动态拒绝教程未承诺的 IG 访问、handler 内异常和新中断的 Mars-with-BUAA-CO-extension 修改版 MARS'
  };
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

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}
