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

interface ScopedEntry {
  entry: IsaInstructionEntry;
  specificity: number;
}

interface ScopedDecodeTable {
  entries: readonly ScopedEntry[];
  runtimeMemo: Map<number, RuntimeInstructionMatch | null>;
  exactMemo: Map<number, IsaInstructionEntry | null>;
}

/** Upper bound across all scopes; guards against streams of random words. */
const maxMemoEntries = 65_536;
const profileIndex: Record<CourseProfile, number> = { P3: 0, P4: 1, P5: 2, P6: 3, P7: 4 };
const scopeTables = new Map<number, ScopedDecodeTable>();
let memoEntries = 0;

function scopeTable(scope: InstructionScope | undefined): ScopedDecodeTable {
  // The catalog has three layers. A bit mask preserves set semantics without
  // allocating or sorting a layer array on every executed instruction.
  const layers = scope?.enabledLayers;
  const layerMask = layers
    ? (Number(layers.includes('required'))
      | (Number(layers.includes('commonExtensions')) << 1)
      | (Number(layers.includes('marsCompatibility')) << 2))
    : 0;
  const key = scope ? (profileIndex[scope.profile] << 3) | layerMask : -1;
  let table = scopeTables.get(key);
  if (!table) {
    const entries = byMaskSpecificity
      .filter((entry) => !scope || (entry.profiles.includes(scope.profile) && layers!.includes(entry.layer)))
      .map((entry) => ({ entry, specificity: popcount(entry.runtimeMatchMask) }));
    table = { entries, runtimeMemo: new Map(), exactMemo: new Map() };
    scopeTables.set(key, table);
  }
  return table;
}

function remember<T>(memo: Map<number, T>, key: number, value: T): T {
  if (memoEntries >= maxMemoEntries) {
    for (const table of scopeTables.values()) {
      table.runtimeMemo.clear();
      table.exactMemo.clear();
    }
    memoEntries = 0;
  }
  memo.set(key, value);
  memoEntries++;
  return value;
}

/** Most specific equally-ranked entries whose runtime masks match, or undefined. */
function runtimeCandidates(value: number, entries: readonly ScopedEntry[]): IsaInstructionEntry[] | undefined {
  let specificity = -1;
  const candidates: IsaInstructionEntry[] = [];
  for (const scoped of entries) {
    if (specificity >= 0 && scoped.specificity !== specificity) {
      break;
    }
    if (((value & scoped.entry.runtimeMatchMask) >>> 0) === scoped.entry.runtimeMatchValue) {
      specificity = scoped.specificity;
      candidates.push(scoped.entry);
    }
  }
  return candidates.length ? candidates : undefined;
}

/** Profile/layer-aware runtime recognition (RI semantics). Results are memoized; do not mutate them. */
export function matchRuntimeInstruction(word: number, scope: InstructionScope): RuntimeInstructionMatch | undefined {
  const value = word >>> 0;
  const table = scopeTable(scope);
  const cached = table.runtimeMemo.get(value);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  const candidates = runtimeCandidates(value, table.entries);
  const result = candidates
    ? Object.freeze({ candidates: Object.freeze(candidates), exactInstruction: exactFromCandidates(value, candidates) })
    : null;
  return remember(table.runtimeMemo, value, result) ?? undefined;
}

/** Exact instruction match among the runtime-recognized encodings. */
export function matchExactInstruction(word: number, scope?: InstructionScope): IsaInstructionEntry | undefined {
  const value = word >>> 0;
  const table = scopeTable(scope);
  const cached = table.exactMemo.get(value);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  const candidates = runtimeCandidates(value, table.entries);
  const result = (candidates && exactFromCandidates(value, candidates)) ?? null;
  return remember(table.exactMemo, value, result) ?? undefined;
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

function popcount(value: number): number {
  let count = 0;
  let remaining = value >>> 0;
  while (remaining) {
    remaining &= remaining - 1;
    count++;
  }
  return count;
}
