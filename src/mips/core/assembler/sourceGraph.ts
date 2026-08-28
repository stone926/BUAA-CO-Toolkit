// @index mips-core — SourceUnit/include 图展开：BOM/CRLF 归一化、递归 include 与 origin 链（纯 TS）

import { SourceUnit, SourceUnitFingerprint } from '../api';
import { sourceUnitFingerprint } from '../programImage';
import { assemblerDiagnostic, AssemblerDiagnostic, SourceSpan } from './diagnostics';

export interface SourceResolverContext {
  readonly parentId: string;
  readonly specifier: string;
}

export interface CourseSourceResolver {
  resolve(context: SourceResolverContext): SourceUnit | undefined;
}

export interface SourceGraphLimits {
  readonly maxDepth: number;
  readonly maxUnits: number;
  readonly maxBytes: number;
}

export const defaultAssemblerSourceLimits: Readonly<SourceGraphLimits> = Object.freeze({
  maxDepth: 32,
  maxUnits: 256,
  maxBytes: 8 * 1024 * 1024
});

/** A logical source line after include expansion. */
export interface ExpandedSourceLine {
  /** Leaf source unit id. */
  readonly sourceId: string;
  /** Zero-based line index in the leaf unit. */
  readonly line: number;
  /** UTF-16 offsets of the original line, excluding the line terminator. */
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  /** Innermost-first include expansion stack (does not contain the leaf span itself). */
  readonly expansionStack: readonly SourceSpan[];
}

export interface ExpandedSourceGraph {
  readonly rootId: string;
  readonly units: readonly SourceUnit[];
  readonly lines: readonly ExpandedSourceLine[];
  readonly inputGraph: readonly SourceUnitFingerprint[];
  readonly diagnostics: readonly AssemblerDiagnostic[];
  readonly totalBytes: number;
}

interface UnitRecord {
  unit: SourceUnit;
  readonly normalized: string;
  readonly lines: readonly SourceLineRecord[];
  fingerprint: SourceUnitFingerprint;
  readonly directives: readonly IncludeDirective[];
}

interface SourceLineRecord {
  readonly line: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

interface IncludeDirective {
  readonly specifier: string;
  readonly span: SourceSpan;
  targetId?: string;
}

const includePattern = /^\s*\.include\s+"([^"]*)"\s*$/i;

export function expandAssemblerSourceGraph(
  root: SourceUnit,
  resolver: CourseSourceResolver | undefined,
  limits: SourceGraphLimits = defaultAssemblerSourceLimits
): ExpandedSourceGraph {
  assertLimits(limits);
  const diagnostics: AssemblerDiagnostic[] = [];
  const records: UnitRecord[] = [];
  const recordById = new Map<string, UnitRecord>();
  const lines: ExpandedSourceLine[] = [];
  let totalBytes = 0;

  const visit = (
    unit: SourceUnit,
    depth: number,
    includeStack: readonly SourceSpan[]
  ): string => {
    const includeOrigin = includeStack[0];
    if (depth > limits.maxDepth) {
      diagnostics.push(assemblerDiagnostic(
        'asm.include.too-deep',
        `include 深度超过上限 ${limits.maxDepth}`,
        includeOrigin
      ));
      return unit.id;
    }
    if (records.length >= limits.maxUnits) {
      diagnostics.push(assemblerDiagnostic(
        'asm.include.too-many-units',
        `source unit 数量超过上限 ${limits.maxUnits}`,
        includeOrigin
      ));
      return unit.id;
    }
    if (typeof unit.text !== 'string') {
      diagnostics.push(assemblerDiagnostic(
        'asm.include.not-found',
        `source unit ${unit.id} 缺少文本`,
        includeOrigin
      ));
      return unit.id;
    }
    const utf8 = utf8ByteLength(unit.text);
    if (totalBytes + utf8 > limits.maxBytes) {
      diagnostics.push(assemblerDiagnostic(
        'asm.limit.source-bytes',
        `source bytes 超过上限 ${limits.maxBytes}`,
        includeOrigin
      ));
      return unit.id;
    }
    totalBytes += utf8;
    const existing = recordById.get(unit.id);
    if (existing) {
      // MARS keeps every processed include path for the rest of pre-processing:
      // a repeated or self include is a recursive-include error, even when the
      // same source unit was already emitted by another edge.
      if (includeOrigin) {
        diagnostics.push(assemblerDiagnostic(
          'asm.include.cycle',
          `include 环或重复 include：${unit.id}`,
          includeOrigin
        ));
      }
      return unit.id;
    }

    const bomOffset = unit.text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const normalized = stripBom(unit.text);
    const sourceLines = splitSourceLines(normalized, bomOffset);
    const record: UnitRecord = {
      unit,
      normalized,
      lines: sourceLines,
      fingerprint: sourceUnitFingerprint(unit),
      directives: parseIncludeDirectives(unit, sourceLines)
    };
    records.push(record);
    recordById.set(unit.id, record);
    const order = records.length - 1;
    const unitId = ensureSourceId(unit, order);
    if (unitId !== unit.id) {
      recordById.delete(unit.id);
      record.unit = { ...unit, id: unitId };
      record.fingerprint = sourceUnitFingerprint(record.unit);
      recordById.set(unitId, record);
    }
    const recordId = record.unit.id;

    for (const sourceLine of record.lines) {
      const directive = record.directives.find((item) => item.span.startOffset === sourceLine.startOffset);
      if (directive) {
        const target = resolver?.resolve({ parentId: recordId, specifier: directive.specifier });
        if (!target) {
          diagnostics.push(assemblerDiagnostic(
            'asm.include.not-found',
            `无法解析 include "${directive.specifier}"`,
            directive.span,
            includeStack
          ));
          continue;
        }
        const edgeKey = `${recordId}\u0000${directive.specifier}`;
        if (activeIncludeEdges.has(edgeKey)) {
          diagnostics.push(assemblerDiagnostic(
            'asm.include.cycle',
            `include 环：${directive.specifier} 从 ${recordId} 重新进入活动栈`,
            directive.span,
            includeStack
          ));
          continue;
        }
        activeIncludeEdges.add(edgeKey);
        visit(target, depth + 1, [directive.span, ...includeStack]);
        // MARS keeps every processed include filename for the rest of the
        // preprocessor pass; a repeated include is reported as recursive even
        // when it is sequential.
        continue;
      }
      lines.push({
        sourceId: recordId,
        line: sourceLine.line,
        startOffset: sourceLine.startOffset,
        endOffset: sourceLine.endOffset,
        text: sourceLine.text,
        expansionStack: includeStack
      });
    }
    return recordId;
  };

  const activeIncludeEdges = new Set<string>();
  const rootId = visit(root, 0, []);

  return {
    rootId,
    units: records.map((record) => record.unit),
    lines,
    inputGraph: records.map((record) => record.fingerprint),
    diagnostics,
    totalBytes
  };
}

function ensureSourceId(unit: SourceUnit, order: number): string {
  if (unit.id && !/^\s*$/.test(unit.id)) return unit.id;
  return `source-${order.toString().padStart(4, '0')}`;
}

function parseIncludeDirectives(unit: SourceUnit, sourceLines: readonly SourceLineRecord[]): IncludeDirective[] {
  const directives: IncludeDirective[] = [];
  for (const line of sourceLines) {
    const code = stripComment(line.text);
    const match = includePattern.exec(code);
    if (!match) continue;
    directives.push({
      specifier: match[1],
      span: { sourceId: unit.id, startOffset: line.startOffset, endOffset: line.endOffset }
    });
  }
  return directives;
}

function splitSourceLines(text: string, baseOffset = 0): SourceLineRecord[] {
  const result: SourceLineRecord[] = [];
  let line = 0;
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index === text.length) {
      result.push({ line, startOffset: baseOffset + start, endOffset: baseOffset + index, text: text.slice(start, index) });
      break;
    }
    const char = text[index];
    if (char === '\n' || char === '\r') {
      result.push({ line, startOffset: baseOffset + start, endOffset: baseOffset + index, text: text.slice(start, index) });
      if (char === '\r' && text[index + 1] === '\n') index++;
      line++;
      start = index + 1;
    }
  }
  return result;
}

function stripComment(text: string): string {
  let quoted: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === quoted && !escaped) quoted = undefined;
      escaped = char === '\\' && !escaped;
      if (char !== '\\') escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quoted = char;
      continue;
    }
    if (char === '#') return text.slice(0, index);
  }
  return text;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index)!;
    if (code > 0xffff) index++;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function assertLimits(limits: SourceGraphLimits): void {
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth <= 0
    || !Number.isSafeInteger(limits.maxUnits) || limits.maxUnits <= 0
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
    throw new Error('invalid assembler source graph limits');
  }
}
