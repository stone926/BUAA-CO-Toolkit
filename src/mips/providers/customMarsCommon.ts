// @index mips-providers — 自定义 Mars 参考契约、失败分类和权威 ProgramImage 映射
import * as path from 'path';
import type { EngineDescriptor, ProgramImage, SourceMapEntry, SourceUnit } from '../core/api';
import type { CustomMarsBridgeResult } from '../host/customMarsBridge';
import { buildProgramImage, sourceUnitFingerprint } from '../core/programImage';
import type { AssembleRequest, EngineRunStatus } from './contracts';
import { CUSTOM_MARS_ENGINE_ID } from './courseEnginePolicy';
import { BUILTIN_TS_ASSEMBLER_CAPABILITIES } from './builtinAssemblerProvider';

export const CUSTOM_MARS_DESCRIPTOR: EngineDescriptor = Object.freeze({
  id: CUSTOM_MARS_ENGINE_ID, kind: 'full-stack', build: 'configured MARS + immutable instruction classes + bridge v1',
  semanticsRevision: 1, capabilitiesRevision: 1
});
export const CUSTOM_MARS_CAPABILITIES = {
  ...BUILTIN_TS_ASSEMBLER_CAPABILITIES,
  console: { deterministicInput: true, deterministicOutput: true, interactive: false }
};

export function customMarsImage(payload: CustomMarsBridgeResult, sources: readonly SourceUnit[], request: AssembleRequest): ProgramImage {
  const root = request.sourceGraphInput?.sources.find((source) => source.id === request.sourceGraphInput?.rootId) ?? sources[0];
  const sourceMap: SourceMapEntry[] = [];
  const sourceByPath = new Map<string, SourceUnit>();
  const pathKey = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  for (const location of request.sourcePaths ?? []) {
    const source = sourceById.get(location.id);
    if (source) sourceByPath.set(pathKey(location.path), source);
  }
  if (root) sourceByPath.set(pathKey(request.sourceUri.fsPath), root);
  const lineCache = new Map<string, { lines: string[]; offsets: number[] }>();
  // Only claim mappings whose actual materialized file and original SourceUnit are known.
  for (const entry of payload.sourceMap ?? []) {
    const source = sourceByPath.get(pathKey(entry.path));
    if (!source) continue;
    let lineData = lineCache.get(source.id);
    if (!lineData) {
      const lines = source.text.split('\n'), offsets: number[] = [];
      let offset = 0;
      for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
      lineData = { lines, offsets }; lineCache.set(source.id, lineData);
    }
    const { lines, offsets } = lineData;
    const segmentIndex = payload.segments.findIndex((segment) => segment.name !== 'data' && segment.name !== 'kdata'
      && entry.address >= segment.baseAddress && entry.address < segment.baseAddress + segment.words.length * 4);
    if (segmentIndex < 0) continue;
    if (entry.line > lines.length) continue;
    const startOffset = offsets[entry.line - 1];
    sourceMap.push({ segmentIndex, wordIndex: (entry.address - payload.segments[segmentIndex].baseAddress) / 4,
      sourceId: source.id, startOffset, endOffset: startOffset + lines[entry.line - 1].length });
  }
  return buildProgramImage({ entryPc: request.requirements?.profile === 'P2' ? payload.segments.find((s) => s.name === 'text')?.baseAddress : 0x3000,
    segments: payload.segments, inputGraph: request.inputGraph ?? sources.map(sourceUnitFingerprint), sourceMap,
    symbols: payload.symbols?.map((symbol) => ({ name: symbol.name, value: symbol.value, kind: 'label' as const,
      segment: payload.segments.find((segment) => (symbol.kind === 'data' ? /^(?:k?data)$/.test(segment.name) : /^(?:k?text)(?:@|$)/.test(segment.name))
        && symbol.value >= segment.baseAddress && symbol.value < segment.baseAddress + segment.words.length * 4)?.name })) });
}

export function customMarsFailureStatus(error: unknown): EngineRunStatus {
  return { ok: false, exitCode: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false };
}
