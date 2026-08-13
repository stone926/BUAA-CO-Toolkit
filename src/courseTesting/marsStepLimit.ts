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
 * Require proof that MARS executed the validated final self-branch. Stable modified MARS emits
 * the executed instruction in coL2 output before eventually stopping at the native step limit;
 * newer builds may instead terminate immediately and print a dedicated course-halt marker.
 * A successful process exit alone is insufficient because MARS also treats falling off assembled
 * text as normal termination.
 */
export function courseTraceMarsHaltError(output: string, expectedHaltPc: number): string | undefined {
  const expected = expectedHaltPc >>> 0;
  const marker = /Program reached course halt loop at\s+(?:0x)?([0-9a-f]{1,8})\b/i.exec(output);
  if (marker) {
    const actual = Number.parseInt(marker[1], 16) >>> 0;
    if (actual !== expected) {
      return `MARS 黄金模型报告的停机 PC 为 0x${actual.toString(16)}，与已验证用户 .text 尾 0x${expected.toString(16)} 不一致`;
    }
    return undefined;
  }

  const detailedHeader = /^@PC(?:0x)?([0-9a-f]{1,8})\s*->.*\(([0-9a-f]{8})\)\s*$/gim;
  for (const match of output.matchAll(detailedHeader)) {
    const pc = Number.parseInt(match[1], 16) >>> 0;
    const word = Number.parseInt(match[2], 16) >>> 0;
    if (pc === expected && word === 0x1000ffff) {
      return undefined;
    }
  }

  if (/Program terminated when maximum step limit\b/i.test(output)) {
    return `MARS 黄金模型在执行预算内未到达标准停机尾 0x${expected.toString(16)}；用例可能进入了其他自环或控制流过长`;
  }
  return `MARS 黄金模型未执行标准停机尾 0x${expected.toString(16)} 的 0x1000ffff 自分支；拒绝把跳出已装载文本或其他提前终止当作通过`;
}
