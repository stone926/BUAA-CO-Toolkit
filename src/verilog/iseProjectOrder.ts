// @index verilog-ise-project-order — 从唯一 XISE 恢复 Verilog 编译顺序并安置未列出/生成源
import * as path from 'path';
import { dedupePaths, normalizePathKey } from '../pathUtils';

export interface VerilogFileLike {
  fsPath: string;
}

/**
 * Return FILE_VERILOG sources in ISE BehavioralSimulation seqID order. When
 * seqIDs are incomplete or ambiguous, preserve document order rather than
 * guessing. Compile order is semantically relevant to directives such as
 * `default_nettype that can leak between Verilog compilation units.
 */
export function parseXiseVerilogFileOrder(xiseText: string, xiseFile: string): string[] {
  const entries: Array<{ file: string; documentIndex: number; sequenceId?: number }> = [];
  for (const match of xiseText.matchAll(/<file\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/file\s*>)/gi)) {
    const attributes = parseXmlAttributes(match[1]);
    if (attributes.get('xil_pn:type')?.toUpperCase() !== 'FILE_VERILOG') {
      continue;
    }
    const source = attributes.get('xil_pn:name')?.trim();
    if (source) {
      entries.push({
        file: resolveXiseSourcePath(xiseFile, source),
        documentIndex: entries.length,
        sequenceId: behavioralSimulationSequenceId(match[2] ?? '')
      });
    }
  }
  const sequenceIds = entries.map((entry) => entry.sequenceId);
  const hasCompleteUniqueSequence = sequenceIds.every((value): value is number => value !== undefined)
    && new Set(sequenceIds).size === sequenceIds.length;
  const ordered = hasCompleteUniqueSequence
    ? [...entries].sort((left, right) => left.sequenceId! - right.sequenceId! || left.documentIndex - right.documentIndex)
    : entries;
  return dedupePaths(ordered.map((entry) => entry.file));
}

/**
 * Ordinary files omitted by the XISE project are compiled first in stable path
 * order, followed by the XISE sources in their declared order. Runtime files
 * supplied by the extension stay last so they see all DUT module definitions.
 */
export function orderIseProjectFiles<T extends VerilogFileLike>(
  discoveredFiles: readonly T[],
  xiseFileOrder: readonly string[],
  extraVerilogFiles: readonly T[] = []
): T[] {
  const extras = dedupeFileLikes(extraVerilogFiles);
  const extraKeys = new Set(extras.map((uri) => normalizePathKey(uri.fsPath)));
  const ordinary = dedupeFileLikes(discoveredFiles)
    .filter((uri) => !extraKeys.has(normalizePathKey(uri.fsPath)));
  const ordinaryByKey = new Map(ordinary.map((uri) => [normalizePathKey(uri.fsPath), uri]));
  const listed: T[] = [];
  const listedKeys = new Set<string>();
  for (const file of xiseFileOrder) {
    const key = normalizePathKey(file);
    const uri = ordinaryByKey.get(key);
    if (uri && !listedKeys.has(key)) {
      listed.push(uri);
      listedKeys.add(key);
    }
  }
  const unlisted = ordinary
    .filter((uri) => !listedKeys.has(normalizePathKey(uri.fsPath)))
    .sort(compareFileLikes);
  return [...unlisted, ...listed, ...extras];
}

function parseXmlAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(/([:\w.-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    attributes.set(match[1].toLowerCase(), decodeXmlEntities(match[3]));
  }
  return attributes;
}

function behavioralSimulationSequenceId(fileBody: string): number | undefined {
  for (const match of fileBody.matchAll(/<association\b([^>]*)\/?>/gi)) {
    const attributes = parseXmlAttributes(match[1]);
    if (attributes.get('xil_pn:name')?.toLowerCase() !== 'behavioralsimulation') {
      continue;
    }
    const text = attributes.get('xil_pn:seqid')?.trim();
    if (!text || !/^\d+$/.test(text)) {
      return undefined;
    }
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  return undefined;
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(?:#(x[0-9a-f]+|\d+)|amp|quot|apos|lt|gt);/gi, (entity, numeric: string | undefined) => {
    if (numeric) {
      const radix = numeric[0].toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? numeric.slice(1) : numeric;
      const value = Number.parseInt(digits, radix);
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
    }
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    return named[entity.toLowerCase()] ?? entity;
  });
}

function resolveXiseSourcePath(xiseFile: string, source: string): string {
  if (isWindowsLikePath(xiseFile) || isWindowsLikePath(source)) {
    const normalizedSource = source.replace(/\//g, '\\');
    return path.win32.isAbsolute(normalizedSource)
      ? path.win32.normalize(normalizedSource)
      : path.win32.resolve(path.win32.dirname(xiseFile), normalizedSource);
  }
  return path.resolve(path.dirname(xiseFile), source);
}

function dedupeFileLikes<T extends VerilogFileLike>(files: readonly T[]): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const key = normalizePathKey(file.fsPath);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(file);
    }
  }
  return result;
}

function compareFileLikes(left: VerilogFileLike, right: VerilogFileLike): number {
  return normalizePathKey(left.fsPath).localeCompare(normalizePathKey(right.fsPath));
}

function isWindowsLikePath(file: string): boolean {
  return file.includes('\\') || /^[A-Za-z]:[\\/]/.test(file) || /^[/\\]{2}/.test(file);
}
