// @index mips-replay — ProgramImage 序列化、legacy HexText adapter 与 observability digest
import * as crypto from 'crypto';
import type { ProgramImage, SourceUnitFingerprint } from '../core/api';
import {
  iterCpuTraceEvents,
  iterMarsDetailedTraceEvents,
  type CpuTraceEvent
} from '../../language/mips/traceParser';
import { canonicalJson, sha256Bytes, sha256Canonical, type CanonicalJson } from './canonical';
import { programImageCanonicalPayload } from '../core/programImage';
import {
  maximumReplayMachineCodeWords,
  maximumReplayProgramImageBytes,
  maximumReplaySourceUnits,
  readBoundedRegularFile
} from './boundedFile';

export const serializedProgramImageSchemaRevision = 1;
/** Course images have one word per IM slot; the extra structural ceilings leave room for later providers. */
export const maximumProgramImageSegments = 16;
// Course images contain text/kernel (up to 4096 words) plus initialized data
// (up to 3072 words); keep the structural ceiling above their sum.
export const maximumProgramImageWords = maximumReplayMachineCodeWords * 4;
export const maximumProgramImageSymbols = maximumReplayMachineCodeWords * 2;
export const maximumProgramImageSourceMapEntries = maximumProgramImageWords;
export const maximumProgramImageInputUnits = maximumReplaySourceUnits;
/** The selected-source course budget is at most 4096 static words * 64 dynamic instructions. */
export const maximumOracleEvidenceSteps = maximumReplayMachineCodeWords * 64;
export const maximumOracleEvidenceEvents = maximumOracleEvidenceSteps;
/** One MIPS instruction commits at most one architectural event; 64 also covers raw SWL/SWR byte updates. */
export const maximumOracleDetailedBlockEvents = 64;
export const maximumOracleFinalRegisterTargets = 32;
/** Compact course DM contains at most 3072 words; 4096 leaves room for mapped course devices. */
export const maximumOracleFinalMemoryTargets = maximumReplayMachineCodeWords;
export const legacyObservabilitySchema = Object.freeze({
  schemaRevision: 1,
  eventSchema: 'buaa-co-cpu-commit-v1',
  eventFields: ['pc', 'kind', 'target', 'value'],
  finalState: {
    gpr: 'last-write-wins; unobserved registers are reset zero',
    dm: 'last-write-wins by aligned word address; unobserved words are reset zero',
    excluded: ['cycle', 'raw text', 'line number', 'HI', 'LO', 'CP0', 'device-internal-state']
  }
} as const);

export interface OracleEvidenceDigests {
  rawOutputDigest: string;
  eventDigest: string;
  finalStateDigest: string;
  eventCount: number;
  /** Dynamic instruction headers in coL2, or commit-event count for coL1. */
  steps: number;
}

export function createLegacyProgramImage(
  machineCodeText: string,
  inputGraph: readonly SourceUnitFingerprint[],
  entryPc = 0x3000
): ProgramImage {
  const words = parseStrictHexTextWords(machineCodeText);
  const withoutFingerprint = {
    formatVersion: 1 as const,
    entryPc: entryPc >>> 0,
    segments: [{ name: 'text', baseAddress: entryPc >>> 0, words }],
    symbols: [],
    // A legacy assembler cannot provide honest line mappings. Keep the array empty rather than
    // manufacturing locations; the separate source graph still makes all inputs replayable.
    sourceMap: [],
    inputGraph: inputGraph.map((unit) => ({
      id: unit.id,
      ...(unit.uri ? { uri: unit.uri } : {}),
      contentHash: unit.contentHash.toLowerCase()
    }))
  };
  return { ...withoutFingerprint, fingerprint: programImageFingerprint(withoutFingerprint) };
}

export function programImageFingerprint(image: Omit<ProgramImage, 'fingerprint'> | ProgramImage): string {
  assertProgramImageCardinality(image);
  return sha256Canonical(programImagePayload(image));
}

export function serializeProgramImage(image: ProgramImage): Buffer {
  const issues = programImageIssues(image);
  if (issues.length) {
    throw new Error(`invalid ProgramImage: ${issues.join('; ')}`);
  }
  return Buffer.from(`${canonicalJson(programImageJson(image))}\n`, 'utf8');
}

export function deserializeProgramImage(bytes: Uint8Array): ProgramImage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`ProgramImage JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const issues = programImageIssues(parsed);
  if (issues.length) {
    throw new Error(`ProgramImage is invalid: ${issues.join('; ')}`);
  }
  return parsed as ProgramImage;
}

export async function programImageFileIssues(
  file: string,
  expectedFingerprint?: string,
  expectedBytes?: number
): Promise<string[]> {
  try {
    const image = deserializeProgramImage(await readBoundedRegularFile(file, {
      maximumBytes: maximumReplayProgramImageBytes,
      expectedBytes,
      label: 'serialized ProgramImage'
    }));
    return expectedFingerprint && image.fingerprint !== expectedFingerprint.toLowerCase()
      ? ['serialized ProgramImage fingerprint does not match manifest.program.imageFingerprint']
      : [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function programImageIssues(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return ['root must be an object'];
  }
  if (!onlyKeys(value, ['formatVersion', 'fingerprint', 'entryPc', 'segments', 'symbols', 'sourceMap', 'inputGraph'])) {
    issues.push('root contains unknown fields');
  }
  if (value.formatVersion !== serializedProgramImageSchemaRevision) issues.push('formatVersion must be 1');
  if (!isSha256(value.fingerprint)) issues.push('fingerprint must be SHA-256');
  if (!isUint32(value.entryPc) || (value.entryPc as number) % 4 !== 0) issues.push('entryPc must be word-aligned uint32');
  const cardinalityIssues = programImageCardinalityIssues(value);
  if (cardinalityIssues.length) {
    issues.push(...cardinalityIssues);
    // Never walk attacker-sized arrays or construct the fingerprint until every
    // domain collection is under its trusted course ceiling.
    return [...new Set(issues)];
  }
  if (!Array.isArray(value.segments) || !value.segments.length) {
    issues.push('segments must be a non-empty array');
  } else {
    const occupied = new Set<number>();
    value.segments.forEach((segment, index) => {
      if (!isRecord(segment) || !onlyKeys(segment, ['name', 'baseAddress', 'words'])) {
        issues.push(`segments[${index}] is invalid`);
        return;
      }
      if (!nonEmpty(segment.name)) issues.push(`segments[${index}].name is invalid`);
      if (!isUint32(segment.baseAddress) || (segment.baseAddress as number) % 4 !== 0) {
        issues.push(`segments[${index}].baseAddress is invalid`);
      }
      if (!Array.isArray(segment.words) || !segment.words.every(isUint32)) {
        issues.push(`segments[${index}].words is invalid`);
      } else if (isUint32(segment.baseAddress)) {
        segment.words.forEach((_word, wordIndex) => {
          const address = (segment.baseAddress as number) + wordIndex * 4;
          if (!Number.isSafeInteger(address) || address > 0xffff_ffff || occupied.has(address)) {
            issues.push(`segments[${index}] overlaps or exceeds uint32 address space`);
          }
          occupied.add(address);
        });
      }
    });
  }
  if (!Array.isArray(value.symbols) || !value.symbols.every(validSymbol)) issues.push('symbols is invalid');
  if (!Array.isArray(value.sourceMap) || !value.sourceMap.every(validSourceMapEntry)) issues.push('sourceMap is invalid');
  if (!Array.isArray(value.inputGraph) || !value.inputGraph.length || !value.inputGraph.every(validInputUnit)) {
    issues.push('inputGraph must contain valid source fingerprints');
  }
  if (Array.isArray(value.segments) && Array.isArray(value.inputGraph)) {
    const segmentNames = value.segments.filter(isRecord).map((segment) => segment.name).filter(nonEmpty);
    const segmentNameSet = new Set(segmentNames);
    if (new Set(segmentNames).size !== segmentNames.length) issues.push('segment names must be unique');
    const sourceIds = value.inputGraph.filter(isRecord).map((unit) => unit.id).filter(nonEmpty);
    const sourceIdSet = new Set(sourceIds);
    if (new Set(sourceIds).size !== sourceIds.length) issues.push('inputGraph ids must be unique');
    if (Array.isArray(value.sourceMap)) {
      for (const [index, entry] of value.sourceMap.entries()) {
        if (!isRecord(entry) || !Number.isInteger(entry.segmentIndex) || !Number.isInteger(entry.wordIndex)) continue;
        const segment = value.segments[entry.segmentIndex as number];
        if (!isRecord(segment) || !Array.isArray(segment.words) || (entry.wordIndex as number) >= segment.words.length) {
          issues.push(`sourceMap[${index}] points outside the ProgramImage`);
        }
        if (!sourceIdSet.has(entry.sourceId as string)) issues.push(`sourceMap[${index}] references an unknown sourceId`);
        if (typeof entry.startOffset === 'number' && typeof entry.endOffset === 'number' && entry.endOffset < entry.startOffset) {
          issues.push(`sourceMap[${index}] has a reversed offset range`);
        }
      }
    }
    if (Array.isArray(value.symbols)) {
      value.symbols.forEach((symbol, index) => {
        if (isRecord(symbol) && symbol.segment !== undefined && !segmentNameSet.has(symbol.segment as string)) {
          issues.push(`symbols[${index}] references an unknown segment`);
        }
      });
    }
  }
  if (!issues.length && isSha256(value.fingerprint)) {
    const expected = programImageFingerprint(value as unknown as ProgramImage);
    if (expected !== (value.fingerprint as string).toLowerCase()) issues.push('fingerprint does not match canonical image content');
  }
  return [...new Set(issues)];
}

export function serializeObservabilitySchema(): Buffer {
  return Buffer.from(`${canonicalJson(legacyObservabilitySchema as unknown as CanonicalJson)}\n`, 'utf8');
}

export function observabilitySchemaDigest(): string {
  return sha256Bytes(serializeObservabilitySchema());
}

export function oracleEvidenceDigests(text: string, traceLevel: 1 | 2): OracleEvidenceDigests {
  const steps = traceLevel === 2 ? countDetailedTraceSteps(text) : undefined;
  const events = traceLevel === 2
    ? iterMarsDetailedTraceEvents(text, maximumOracleDetailedBlockEvents)
    : iterCpuTraceEvents(text);
  const registers = new Map<string, string>();
  const memory = new Map<string, string>();
  const eventHash = crypto.createHash('sha256');
  eventHash.update('[');
  let eventCount = 0;
  for (const rawEvent of events) {
    if (eventCount >= maximumOracleEvidenceEvents) {
      throw new Error(`oracle evidence event count exceeds the trusted limit ${maximumOracleEvidenceEvents}`);
    }
    const event = canonicalTraceEvent(rawEvent);
    eventHash.update(eventCount === 0 ? '' : ',');
    eventHash.update(canonicalJson(event as unknown as CanonicalJson));
    const state = event.kind === 'grf' ? registers : memory;
    const stateLimit = event.kind === 'grf'
      ? maximumOracleFinalRegisterTargets
      : maximumOracleFinalMemoryTargets;
    if (!state.has(event.target) && state.size >= stateLimit) {
      throw new Error(
        `oracle final ${event.kind === 'grf' ? 'register' : 'memory'} target count exceeds the trusted limit ${stateLimit}`
      );
    }
    state.set(event.target, event.value);
    eventCount++;
  }
  eventHash.update(']');
  const finalState = {
    gpr: [...registers.entries()].sort(decimalEntryOrder).map(([target, value]) => ({ target, value })),
    dm: [...memory.entries()].sort(hexEntryOrder).map(([target, value]) => ({ target, value }))
  };
  return {
    rawOutputDigest: sha256Bytes(text),
    eventDigest: eventHash.digest('hex'),
    finalStateDigest: sha256Canonical(finalState as unknown as CanonicalJson),
    eventCount,
    steps: traceLevel === 2 ? steps! : eventCount
  };
}

function countDetailedTraceSteps(text: string): number {
  const headers = /^@PC(?:0x)?[0-9a-f]{1,8}\s*->/gim;
  let steps = 0;
  while (headers.exec(text)) {
    steps++;
    if (steps > maximumOracleEvidenceSteps) {
      throw new Error(`oracle evidence step count exceeds the trusted limit ${maximumOracleEvidenceSteps}`);
    }
  }
  return steps;
}

function programImageCardinalityIssues(value: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (Array.isArray(value.segments)) {
    if (value.segments.length > maximumProgramImageSegments) {
      issues.push(`segments exceeds the trusted limit ${maximumProgramImageSegments}`);
    } else {
      let words = 0;
      for (const segment of value.segments) {
        if (!isRecord(segment) || !Array.isArray(segment.words)) continue;
        words += segment.words.length;
        if (!Number.isSafeInteger(words) || words > maximumProgramImageWords) {
          issues.push(`segment word count exceeds the course image limit ${maximumProgramImageWords}`);
          break;
        }
      }
    }
  }
  if (Array.isArray(value.symbols) && value.symbols.length > maximumProgramImageSymbols) {
    issues.push(`symbols exceeds the trusted limit ${maximumProgramImageSymbols}`);
  }
  if (Array.isArray(value.sourceMap) && value.sourceMap.length > maximumProgramImageSourceMapEntries) {
    issues.push(`sourceMap exceeds the trusted limit ${maximumProgramImageSourceMapEntries}`);
  }
  if (Array.isArray(value.inputGraph) && value.inputGraph.length > maximumProgramImageInputUnits) {
    issues.push(`inputGraph exceeds the trusted limit ${maximumProgramImageInputUnits}`);
  }
  return issues;
}

function assertProgramImageCardinality(image: Omit<ProgramImage, 'fingerprint'> | ProgramImage): void {
  const issues = programImageCardinalityIssues(image as unknown as Record<string, unknown>);
  if (issues.length) throw new Error(`invalid ProgramImage cardinality: ${issues.join('; ')}`);
}

/** Parse the exact one-word-per-line HexText format consumed by replay/DUT adapters. */
export function parseStrictHexTextWords(text: string): number[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) throw new Error('HexText contains a bare CR');
  const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  if (lines.length > maximumReplayMachineCodeWords) {
    throw new Error(`HexText word count exceeds the course IM limit ${maximumReplayMachineCodeWords}`);
  }
  return lines.map((line, index) => {
    if (!/^[0-9a-fA-F]{8}$/.test(line)) throw new Error(`HexText line ${index + 1} is not one 8-digit word`);
    return Number.parseInt(line, 16) >>> 0;
  });
}

function programImagePayload(image: Omit<ProgramImage, 'fingerprint'> | ProgramImage): CanonicalJson {
  // The canonical payload is owned by the core contract so the builtin assembler,
  // the executor and replay all fingerprint one image identically.
  return programImageCanonicalPayload(image);
}

function programImageJson(image: ProgramImage): CanonicalJson {
  return { ...(programImagePayload(image) as { [key: string]: CanonicalJson }), fingerprint: image.fingerprint.toLowerCase() };
}

function canonicalTraceEvent(event: CpuTraceEvent): { pc: string; kind: string; target: string; value: string } {
  return { pc: event.pc.toUpperCase(), kind: event.kind, target: event.target.toUpperCase(), value: event.value.toUpperCase() };
}

function hexEntryOrder(left: [string, string], right: [string, string]): number {
  const numeric = Number.parseInt(left[0], 16) - Number.parseInt(right[0], 16);
  return Number.isNaN(numeric) || numeric === 0 ? left[0].localeCompare(right[0]) : numeric;
}

function decimalEntryOrder(left: [string, string], right: [string, string]): number {
  const numeric = Number(left[0]) - Number(right[0]);
  return Number.isNaN(numeric) || numeric === 0 ? left[0].localeCompare(right[0]) : numeric;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function isSha256(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value); }
function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function validInputUnit(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ['id', 'uri', 'contentHash']) && nonEmpty(value.id)
    && (value.uri === undefined || nonEmpty(value.uri)) && isSha256(value.contentHash);
}

function validSymbol(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ['name', 'value', 'kind', 'segment']) && nonEmpty(value.name)
    && (value.value === undefined || (
      Number.isSafeInteger(value.value) && (value.value as number) >= -0x8000_0000 && (value.value as number) <= 0xffff_ffff
    )) && (value.kind === 'label' || value.kind === 'eqv')
    && (value.segment === undefined || nonEmpty(value.segment));
}

function validSourceMapEntry(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ['segmentIndex', 'wordIndex', 'sourceId', 'startOffset', 'endOffset', 'expansionStack'])
    && Number.isInteger(value.segmentIndex) && (value.segmentIndex as number) >= 0
    && Number.isInteger(value.wordIndex) && (value.wordIndex as number) >= 0 && nonEmpty(value.sourceId)
    && (value.startOffset === undefined || (Number.isInteger(value.startOffset) && (value.startOffset as number) >= 0))
    && (value.endOffset === undefined || (Number.isInteger(value.endOffset) && (value.endOffset as number) >= 0))
    && (value.expansionStack === undefined || (
      Array.isArray(value.expansionStack)
      && value.expansionStack.length > 0
      && value.expansionStack.every(validSourceOrigin)
    ));
}

function validSourceOrigin(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ['sourceId', 'startOffset', 'endOffset'])
    && nonEmpty(value.sourceId)
    && (value.startOffset === undefined || (Number.isInteger(value.startOffset) && (value.startOffset as number) >= 0))
    && (value.endOffset === undefined || (Number.isInteger(value.endOffset) && (value.endOffset as number) >= 0));
}
