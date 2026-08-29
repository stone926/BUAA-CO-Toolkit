// @index mips — production 与 replay 共用的 legacy MARS 兼容性诊断
import { isLargeTextMemoryConfiguration } from './legacyMarsPolicy';

export type LegacyMarsDiagnosticMode = 'run' | 'dumpText' | 'dumpKernel';

export interface LegacyMarsDiagnosticInput {
  stdout: string;
  stderr: string;
  mode: LegacyMarsDiagnosticMode;
  traceOutput: boolean;
  courseTrace: boolean;
  p7RiInstruction: boolean;
  memoryConfiguration: string;
}

/**
 * Modified MARS builds can report an unsupported command-line option while still exiting zero.
 * Treat those messages as a hard compatibility failure in every caller, rather than trusting the
 * process exit code alone.
 */
export function legacyMarsCompatibilityDiagnostic(
  input: LegacyMarsDiagnosticInput
): string | undefined {
  const output = `${input.stdout}\n${input.stderr}`;
  if (input.traceOutput && /Invalid Command Argument:\s*coL[12]/i.test(output)) {
    return '当前 MARS 不支持 coL1/coL2 trace 参数。课程自动对拍需要 Toby-Shi-cloud/Mars-with-BUAA-CO-extension 修改版 Mars，请检查 co.toolchain.mars / co.toolchain.marsP7。';
  }
  if (input.courseTrace && /Invalid Command Argument:\s*(efc|p7irq)/i.test(output)) {
    return '当前 MARS 不支持 efc / p7irq（P7 异常与外部中断）参数。P7 自动对拍需要含该功能的修改版 Mars 构建，请重新构建并配置 co.toolchain.marsP7。';
  }
  if (input.p7RiInstruction && /Invalid Command Argument:\s*cl/i.test(output)) {
    return '当前 MARS 不支持旧用例所需的 cl 额外指令加载。请改用 auto/builtin 自动测试，或配置支持 cl 的 P7 修改版 MARS。';
  }
  const memoryMatch = /Invalid memory configuration:\s*([A-Za-z0-9_]+)/i.exec(output);
  if (memoryMatch) {
    const rejected = memoryMatch[1] || input.memoryConfiguration;
    if (isLargeTextMemoryConfiguration(rejected)) {
      return `当前 MARS 不支持 ${rejected} 内存配置。非 P7 自动化测试默认使用 large text 配置以支持超长机器码，请改用修改版 Mars。`;
    }
    if (input.mode === 'dumpText' || input.mode === 'run') {
      return `当前 MARS 不支持 ${rejected} 内存配置，请检查 co.mips.memoryConfiguration 或更换修改版 Mars。`;
    }
  }
  return undefined;
}
