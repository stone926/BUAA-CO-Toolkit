// @index mips-core — 基于生成 catalog 的机器码解码：runtime recognition 与课程 canonical 两层
import { CourseProfile, isaInstructions, IsaInstructionEntry, InstructionLayer } from '../generated/isaCatalog';

/**
 * 三层识别（计划第 5.2 节、COURSE-P7-EXC-017/018）：
 *
 * - `matchRuntimeInstruction`：执行期识别语义。runtimeMatch 只含 opcode
 *   与 R 型 funct（REGIMM 的 rt、COP0 的 rs 都不参与 RI 识别），所以非 canonical
 *   保留位不会额外触发 RI。返回整个候选组，绝不把组内第一项冒充唯一 mnemonic。
 * - `matchExactInstruction`：在 runtime 命中集合内用 formatRt/formatRs/全字
 *   精确区分具体指令（阶段 2+ 的语义 handler 分派入口）。
 * - `decodeCourseInstructionWord`：assembler/validator 的课程 canonical 解码，
 *   要求固定保留位全零，并对 COP0 rd 施加课程必做面限制。
 *
 * 条目按 runtimeMatchMask 的置位位数降序排列（更具体的条目优先），保证
 * nop 与 eret 先于宽泛条目命中。
 */

const byMaskSpecificity = [...isaInstructions].sort((left, right) =>
  popcount(right.runtimeMatchMask) - popcount(left.runtimeMatchMask));

export interface InstructionScope {
  profile: CourseProfile;
  enabledLayers: readonly InstructionLayer[];
}

export interface RuntimeInstructionMatch {
  /** Equally specific entries whose runtime-recognition masks match. */
  candidates: readonly IsaInstructionEntry[];
  /** Unique semantic entry after REGIMM/COP0 secondary selector dispatch, when known. */
  exactInstruction?: IsaInstructionEntry;
}

/** Profile/layer-aware runtime recognition (RI semantics). */
export function matchRuntimeInstruction(word: number, scope: InstructionScope): RuntimeInstructionMatch | undefined {
  const value = word >>> 0;
  const matches = byMaskSpecificity.filter((entry) =>
    entry.profiles.includes(scope.profile)
    && scope.enabledLayers.includes(entry.layer)
    && ((value & entry.runtimeMatchMask) >>> 0) === entry.runtimeMatchValue);
  if (!matches.length) {
    return undefined;
  }
  const specificity = popcount(matches[0].runtimeMatchMask);
  const candidates = matches.filter((entry) => popcount(entry.runtimeMatchMask) === specificity);
  return {
    candidates,
    exactInstruction: exactFromCandidates(value, candidates)
  };
}

/** Exact instruction match among the runtime-recognized encodings. */
export function matchExactInstruction(word: number, scope?: InstructionScope): IsaInstructionEntry | undefined {
  const value = word >>> 0;
  const matches = byMaskSpecificity.filter((entry) => (!scope || (
    entry.profiles.includes(scope.profile) && scope.enabledLayers.includes(entry.layer)
  )) && ((value & entry.runtimeMatchMask) >>> 0) === entry.runtimeMatchValue);
  if (!matches.length) {
    return undefined;
  }
  const specificity = popcount(matches[0].runtimeMatchMask);
  return exactFromCandidates(value, matches.filter((entry) => popcount(entry.runtimeMatchMask) === specificity));
}

function exactFromCandidates(value: number, candidates: readonly IsaInstructionEntry[]): IsaInstructionEntry | undefined {
  for (const entry of candidates) {
    switch (entry.formatKind) {
      case 'regimm':
        if (((value >>> 16) & 0x1f) === entry.formatRt) {
          return entry;
        }
        break;
      case 'cop0':
        if (((value >>> 21) & 0x1f) === entry.formatRs) {
          return entry;
        }
        break;
      case 'eret':
        return value === entry.runtimeMatchValue ? entry : undefined;
      default:
        return entry;
    }
  }
  return undefined;
}

/** Course CP0 registers that mfc0/mtc0 may address (COURSE-P7-CP0-001, EXC-022). */
const courseCp0Readable = new Set([12, 13, 14]);
const courseCp0Writable = new Set([12, 14]);

/**
 * Course canonical decode used by machine-code validation: fixed reserved bits
 * must be zero, and CP0 rd must stay within the required register surface.
 * Returns the mnemonic or undefined when unrecognized / non-canonical.
 */
export function decodeCourseInstructionWord(word: number, scope?: InstructionScope): string | undefined {
  const value = word >>> 0;
  const entry = matchExactInstruction(value, scope);
  if (!entry) {
    return undefined;
  }
  for (const [mask] of entry.canonicalFixedZeroBits) {
    if ((value & mask) !== 0) {
      return undefined;
    }
  }
  if (entry.mnemonic === 'mfc0') {
    const rd = (value >>> 11) & 0x1f;
    if (!courseCp0Readable.has(rd)) {
      return undefined;
    }
  }
  if (entry.mnemonic === 'mtc0') {
    const rd = (value >>> 11) & 0x1f;
    if (!courseCp0Writable.has(rd)) {
      return undefined;
    }
  }
  return entry.mnemonic;
}

/** True when the word matches runtime recognition regardless of reserved bits. */
export function isRuntimeInstruction(word: number, mnemonic: string, scope: InstructionScope): boolean {
  return matchRuntimeInstruction(word >>> 0, scope)?.exactInstruction?.mnemonic === mnemonic;
}

function popcount(value: number): number {
  let count = 0;
  let remaining = value >>> 0;
  while (remaining) {
    remaining &= remaining - 1;
    count++;
  }
  return count;
}
