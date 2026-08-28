// @index mips-core — CLI/Worker 共用的纯汇编服务 DTO：显式 source/include graph 上限与稳定错误投影

import { CourseProfile, InstructionLayer } from '../generated/isaCatalog';
import { ProgramImage, SourceUnit } from '../api';
import { AssemblerDiagnostic } from './diagnostics';
import {
  assembleCourseSource,
  CourseAssemblerOptions,
  courseAssemblerSemanticsRevision
} from './assembler';

export { courseAssemblerSemanticsRevision };
import { defaultAssemblerSourceLimits, SourceGraphLimits } from './sourceGraph';

export const maximumAssemblerSourceUnits = defaultAssemblerSourceLimits.maxUnits;
export const maximumAssemblerSourceBytes = defaultAssemblerSourceLimits.maxBytes;
export const maximumAssemblerIncludes = defaultAssemblerSourceLimits.maxUnits * 4;

export const assemblerServiceRequestFields = [
  'profile',
  'sources',
  'layers',
  'includes',
  'maximumMacroDepth',
  'maximumExpandedInstructions',
  'maximumPseudoInstructionsPerStatement',
  'p7RiInstruction'
] as const;

export interface AssemblerServiceSource {
  readonly id: string;
  readonly uri?: string;
  readonly text: string;
}

export interface AssemblerServiceInclude {
  readonly fromId: string;
  readonly specifier: string;
  readonly toId: string;
}

export interface ParsedAssemblerServiceRequest {
  readonly profile: CourseProfile;
  readonly sources: readonly AssemblerServiceSource[];
  readonly layers?: readonly InstructionLayer[];
  readonly includes?: readonly AssemblerServiceInclude[];
  readonly maximumMacroDepth?: number;
  readonly maximumExpandedInstructions?: number;
  readonly maximumPseudoInstructionsPerStatement?: number;
  readonly p7RiInstruction?: boolean;
}

export interface AssemblerServiceResult {
  readonly ok: boolean;
  readonly semanticsRevision: typeof courseAssemblerSemanticsRevision;
  readonly expandedInstructionCount: number;
  readonly diagnostics: readonly AssemblerDiagnostic[];
  readonly image?: ProgramImage;
}

export function parseAssemblerServiceRequest(value: Record<string, unknown>): ParsedAssemblerServiceRequest {
  if (typeof value.profile !== 'string' || !['P3', 'P4', 'P5', 'P6', 'P7'].includes(value.profile)) {
    throw new Error('profile must be one of P3, P4, P5, P6, P7');
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > maximumAssemblerSourceUnits) {
    throw new Error(`sources must contain 1..${maximumAssemblerSourceUnits} entries`);
  }
  const sources: AssemblerServiceSource[] = [];
  let totalBytes = 0;
  const seenIds = new Set<string>();
  value.sources.forEach((source, index) => {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      throw new Error(`sources[${index}] must be an object`);
    }
    const record = source as Record<string, unknown>;
    requireOnlyKeys(record, ['id', 'uri', 'text'], `sources[${index}]`);
    if (typeof record.id !== 'string' || !record.id.trim() || seenIds.has(record.id)) {
      throw new Error(`sources[${index}].id must be a unique non-empty string`);
    }
    if (record.uri !== undefined && typeof record.uri !== 'string') {
      throw new Error(`sources[${index}].uri must be a string`);
    }
    if (typeof record.text !== 'string') {
      throw new Error(`sources[${index}].text must be a string`);
    }
    totalBytes += utf8ByteLength(record.text);
    if (totalBytes > maximumAssemblerSourceBytes) {
      throw new Error(`sources exceed the ${maximumAssemblerSourceBytes}-byte limit`);
    }
    seenIds.add(record.id);
    sources.push({
      id: record.id,
      ...(record.uri === undefined ? {} : { uri: record.uri }),
      text: record.text
    });
  });

  let layers: InstructionLayer[] | undefined;
  if (value.layers !== undefined) {
    if (!Array.isArray(value.layers) || value.layers.length === 0
      || value.layers.some((layer) => typeof layer !== 'string' || !['required', 'commonExtensions', 'marsCompatibility'].includes(layer))
      || new Set(value.layers).size !== value.layers.length) {
      throw new Error('layers must be a non-empty unique list of instruction layers');
    }
    layers = value.layers as InstructionLayer[];
  }

  let includes: AssemblerServiceInclude[] | undefined;
  if (value.includes !== undefined) {
    if (!Array.isArray(value.includes) || value.includes.length > maximumAssemblerIncludes) {
      throw new Error(`includes must contain 0..${maximumAssemblerIncludes} entries`);
    }
    includes = value.includes.map((include, index) => {
      if (typeof include !== 'object' || include === null || Array.isArray(include)) {
        throw new Error(`includes[${index}] must be an object`);
      }
      const record = include as Record<string, unknown>;
      requireOnlyKeys(record, ['fromId', 'specifier', 'toId'], `includes[${index}]`);
      if (typeof record.fromId !== 'string' || !seenIds.has(record.fromId)
        || typeof record.specifier !== 'string' || record.specifier.length === 0
        || typeof record.toId !== 'string' || !seenIds.has(record.toId)) {
        throw new Error(`includes[${index}] must reference known source ids and a non-empty specifier`);
      }
      return { fromId: record.fromId, specifier: record.specifier, toId: record.toId };
    });
  }

  const positiveInteger = (raw: unknown, label: string): number | undefined => {
    if (raw === undefined) return undefined;
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0) {
      throw new Error(`${label} must be a positive safe integer`);
    }
    return raw as number;
  };

  if (value.p7RiInstruction !== undefined && typeof value.p7RiInstruction !== 'boolean') {
    throw new Error('p7RiInstruction must be a boolean');
  }
  return {
    profile: value.profile as CourseProfile,
    sources,
    ...(layers ? { layers } : {}),
    ...(includes ? { includes } : {}),
    ...(value.p7RiInstruction !== undefined ? { p7RiInstruction: value.p7RiInstruction as boolean } : {}),
    ...(positiveInteger(value.maximumMacroDepth, 'maximumMacroDepth') !== undefined
      ? { maximumMacroDepth: positiveInteger(value.maximumMacroDepth, 'maximumMacroDepth')! }
      : {}),
    ...(positiveInteger(value.maximumExpandedInstructions, 'maximumExpandedInstructions') !== undefined
      ? { maximumExpandedInstructions: positiveInteger(value.maximumExpandedInstructions, 'maximumExpandedInstructions')! }
      : {}),
    ...(positiveInteger(value.maximumPseudoInstructionsPerStatement, 'maximumPseudoInstructionsPerStatement') !== undefined
      ? { maximumPseudoInstructionsPerStatement: positiveInteger(value.maximumPseudoInstructionsPerStatement, 'maximumPseudoInstructionsPerStatement')! }
      : {})
  };
}

export function assembleProgramForService(request: ParsedAssemblerServiceRequest): AssemblerServiceResult {
  const sourcesById = new Map(request.sources.map((source) => [source.id, source]));
  const includesByParent = new Map<string, Map<string, string>>();
  for (const include of request.includes ?? []) {
    let bySpecifier = includesByParent.get(include.fromId);
    if (!bySpecifier) {
      bySpecifier = new Map();
      includesByParent.set(include.fromId, bySpecifier);
    }
    bySpecifier.set(include.specifier, include.toId);
  }
  const options: CourseAssemblerOptions = {
    profile: request.profile,
    ...(request.layers ? { layers: request.layers } : {}),
    ...(request.maximumMacroDepth ? { maximumMacroDepth: request.maximumMacroDepth } : {}),
    ...(request.maximumExpandedInstructions ? { maximumExpandedInstructions: request.maximumExpandedInstructions } : {}),
    ...(request.maximumPseudoInstructionsPerStatement ? { maximumPseudoInstructionsPerStatement: request.maximumPseudoInstructionsPerStatement } : {}),
    ...(request.p7RiInstruction !== undefined ? { p7RiInstruction: request.p7RiInstruction } : {}),
    sourceResolver: {
      resolve(context) {
        const targetId = includesByParent.get(context.parentId)?.get(context.specifier);
        return targetId ? sourcesById.get(targetId) : undefined;
      }
    },
    sourceLimits: defaultAssemblerSourceLimits
  };
  const result = assembleCourseSource(sourcesById.get(request.sources[0].id)!, options);
  return {
    ok: result.ok,
    semanticsRevision: courseAssemblerSemanticsRevision,
    expandedInstructionCount: result.expandedInstructionCount,
    diagnostics: result.diagnostics,
    ...(result.image ? { image: result.image } : {})
  };
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) {
    throw new Error(`${label} has unknown fields: ${unknown.join(', ')}`);
  }
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
