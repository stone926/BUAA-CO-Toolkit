import { ProjectProfile } from '../projectProfile';

const builtinRandomAsmMarker = /^#\s*Built-in BUAA CO random ASM test\s*$/im;
const instructionCountMarker = /^#\s*instruction_count:\s*(\d+)\s*$/im;

/**
 * Return the deterministic MARS execution limit for a course-trace test.
 *
 * MARS' command-line interface treats a stand-alone positive integer as the maximum number of
 * executed instructions. Generated programs deliberately finish in a permanent branch loop, so
 * the oracle must use that native limit instead of relying on the wall-clock process timeout.
 *
 * P3-P6 built-in control flow is forward-only apart from one fixed two-iteration coverage loop.
 * P7 additionally re-enters a short exception handler, potentially once per payload instruction;
 * its larger multiplier covers the handler path plus the terminating loop with ample headroom.
 * Selected/external sources do not carry trusted payload metadata, so use a conservative bound
 * scaled by the final modified-MARS dump. This still terminates the mandatory permanent halt loop
 * natively in MARS instead of depending on the wall-clock process timeout.
 */
export function generatedCourseTraceMarsStepLimit(
  profile: ProjectProfile,
  asmText: string,
  trustedBuiltinSource: boolean,
  machineCodeText: string
): number {
  // Source comments are user-controlled. Only the case manifest can establish that this text
  // was produced in-process by the built-in generator.
  if (trustedBuiltinSource && builtinRandomAsmMarker.test(asmText)) {
    const match = instructionCountMarker.exec(asmText);
    const instructionCount = match ? Number(match[1]) : Number.NaN;
    if (Number.isSafeInteger(instructionCount) && instructionCount > 0) {
      return profile === 'P7'
        ? Math.max(512, instructionCount * 16 + 256)
        : Math.max(256, instructionCount * 2 + 64);
    }
  }

  const machineCodeWords = machineCodeText
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^0x/i, ''))
    .filter((line) => /^[0-9a-f]{8}$/i.test(line))
    .length;
  return Math.max(65_536, machineCodeWords * 64);
}

/**
 * Require the modified-MARS course-halt marker. A successful process exit alone is insufficient:
 * vanilla MARS also treats falling off assembled text as normal termination, which can make an
 * invalid program's writeback prefix look identical to a DUT trace.
 */
export function courseTraceMarsHaltError(output: string, expectedHaltPc: number): string | undefined {
  const match = /Program reached course halt loop at\s+(?:0x)?([0-9a-f]{1,8})\b/i.exec(output);
  if (!match) {
    if (/Program terminated when maximum step limit\b/i.test(output)) {
      return `MARS 黄金模型在执行预算内未到达标准停机尾 0x${expectedHaltPc.toString(16)}；用例可能进入了其他自环或控制流过长`;
    }
    return `MARS 黄金模型未报告到达标准停机尾 0x${expectedHaltPc.toString(16)}；拒绝把跳出已装载文本或其他提前终止当作通过`;
  }
  const actual = Number.parseInt(match[1], 16) >>> 0;
  if (actual !== (expectedHaltPc >>> 0)) {
    return `MARS 黄金模型报告的停机 PC 为 0x${actual.toString(16)}，与已验证用户 .text 尾 0x${expectedHaltPc.toString(16)} 不一致`;
  }
  return undefined;
}
