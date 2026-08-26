// @index course-data-initialization — 课程 Trace 的 MARS DM 初值 dump 规划与严格全零校验
import { courseDataByteLength } from './cpuState';

/** Modified MARS allocates data memory in 4 KiB blocks. */
export const courseDataDumpChunkByteLength = 0x1000;
export const courseDataDumpChunkWordCount = courseDataDumpChunkByteLength / 4;
export const courseDataDumpChunkCount = courseDataByteLength / courseDataDumpChunkByteLength;

export interface CourseDataDumpChunk {
  index: number;
  startAddress: number;
  endAddressExclusive: number;
  /**
   * MARS's range dumper treats its upper bound as exclusive while locating allocated data,
   * then subtracts one word. Passing the exclusive block end therefore dumps through end - 4.
   */
  marsRange: string;
}

export const courseDataDumpChunks: readonly CourseDataDumpChunk[] = Object.freeze(
  Array.from({ length: courseDataDumpChunkCount }, (_, index) => {
    const startAddress = index * courseDataDumpChunkByteLength;
    const endAddressExclusive = startAddress + courseDataDumpChunkByteLength;
    return Object.freeze({
      index,
      startAddress,
      endAddressExclusive,
      marsRange: `${formatAddress(startAddress)}-${formatAddress(endAddressExclusive)}`
    });
  })
);

/** First exit-zero MARS dump failure diagnostic, if any. */
export function marsDumpFailureDiagnostic(stdout: string, stderr = ''): string | undefined {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /Error while attempting to save dump|segment\/address-range .* is invalid|dump, format .* was not found/i.test(line));
}

/** MARS's explicit, non-error indication that a segment has no allocated words. */
export function marsDumpExplicitlyEmpty(stdout: string, stderr = ''): boolean {
  return /This segment has not been written to, there is nothing to dump\./i.test(`${stdout}\n${stderr}`);
}

/**
 * Validate the three modified-MARS HexText files covering course DM 0x0000..0x2fff.
 * An empty file means that its 4 KiB MARS allocation block was never written and is therefore
 * all zero. A present block must contain all 1024 words; accepting a partial or malformed dump
 * would make the course golden-model initial state indeterminate.
 */
export function courseDataInitializationError(dumpTexts: readonly string[]): string | undefined {
  if (dumpTexts.length !== courseDataDumpChunks.length) {
    return dumpFailure(`应有 ${courseDataDumpChunks.length} 个 4 KiB 地址块，实际得到 ${dumpTexts.length} 个`);
  }

  for (const chunk of courseDataDumpChunks) {
    const text = dumpTexts[chunk.index];
    if (text.length === 0) {
      continue;
    }
    const normalized = text.replace(/\r\n/g, '\n');
    if (normalized.includes('\r')) {
      return dumpFailure(`${formatAddress(chunk.startAddress)} 地址块包含非法换行`);
    }
    const withoutFinalNewline = normalized.endsWith('\n')
      ? normalized.slice(0, -1)
      : normalized;
    const lines = withoutFinalNewline.split('\n');
    if (lines.length !== courseDataDumpChunkWordCount) {
      return dumpFailure(
        `${formatAddress(chunk.startAddress)} 地址块应为空（未分配）或包含 ${courseDataDumpChunkWordCount} 个 word，实际为 ${lines.length} 个`
      );
    }
    for (let wordIndex = 0; wordIndex < lines.length; wordIndex++) {
      const word = lines[wordIndex];
      const address = chunk.startAddress + wordIndex * 4;
      if (!/^[0-9a-fA-F]{8}$/.test(word)) {
        return dumpFailure(`${formatAddress(address)} 处不是严格的 8 位 HexText word：${JSON.stringify(word)}`);
      }
      if (word !== '00000000') {
        return `课程 Trace 不允许 ASM 预置非零数据内存：MARS 在 ${formatAddress(address)} 导出 0x${word.toLowerCase()}。P3–P7 硬件 DM 复位初态全为零；请改为在程序运行时使用 store 指令初始化。`;
      }
    }
  }
  return undefined;
}

function dumpFailure(detail: string): string {
  return `课程 DM 初始化 dump 格式异常：${detail}。无法安全确认 MARS 与 P3–P7 硬件的全零 DM 初态一致，已终止课程 Trace。`;
}

function formatAddress(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}
