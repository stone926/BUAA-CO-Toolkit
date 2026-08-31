// @index mips-replay — SourceUnit/include graph 的 content-addressed capture、校验与重建
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { SourceUnit, SourceUnitFingerprint } from '../core/api';
import { canonicalJson, sha256Bytes, sha256Canonical, type CanonicalJson } from './canonical';
import {
  maximumReplaySourceBytes,
  maximumReplaySourceDepth,
  maximumReplaySourceUnits,
  readBoundedRegularFile
} from './boundedFile';

export const sourceGraphSchemaRevision = 1;
const maximumSourceGraphJsonBytes = 2 * 1024 * 1024;

export interface SourceCaptureLimits {
  maxDepth: number;
  maxUnits: number;
  maxBytes: number;
}

export interface SourceCapturePolicy {
  /** Every root/include realpath must remain under this trusted directory. */
  allowedRoot: string;
}

export const defaultSourceCaptureLimits: Readonly<SourceCaptureLimits> = Object.freeze({
  maxDepth: 32,
  maxUnits: 256,
  maxBytes: 8 * 1024 * 1024
});

export interface SourceGraphUnit {
  id: string;
  contentHash: string;
  bytes: number;
  blobPath: string;
  materializedPath: string;
  materializedHash: string;
  provenanceUri: string;
}

export interface SourceGraphEdge {
  from: string;
  to: string;
  ordinal: number;
  /** Original path text between quotes, retained for diagnostics/provenance. */
  requestedPath: string;
  pathStartOffset: number;
  pathEndOffset: number;
}

export interface SourceGraphBundle {
  schemaRevision: typeof sourceGraphSchemaRevision;
  rootId: string;
  graphFingerprint: string;
  limits: SourceCaptureLimits;
  units: SourceGraphUnit[];
  edges: SourceGraphEdge[];
}

export interface CapturedSourceBundle {
  graph: SourceGraphBundle;
  graphPath: string;
  rootMaterializedPath: string;
  inputGraph: SourceUnitFingerprint[];
}

interface DiscoveredUnit {
  id: string;
  /** Filename spelling used by MARS include recursion detection (not realpath-normalized). */
  marsPath: string;
  realPath: string;
  bytes: Buffer;
  contentHash: string;
  provenanceUri: string;
  directives: IncludeDirective[];
}

interface IncludeDirective {
  requestedPath: string;
  pathStartOffset: number;
  pathEndOffset: number;
  targetId?: string;
}

/**
 * Capture the root plus every recursive MARS `.include "..."` input exactly once. Original
 * bytes live in content-addressed blobs. A separate rewritten materialization keeps include
 * semantics while removing all dependencies on original absolute paths.
 */
export async function captureSourceGraph(
  rootFile: string,
  caseDir: string,
  expectedRootBytes?: Uint8Array,
  limits: SourceCaptureLimits = { ...defaultSourceCaptureLimits },
  policy: SourceCapturePolicy = { allowedRoot: path.dirname(path.resolve(rootFile)) }
): Promise<CapturedSourceBundle> {
  assertLimits(limits);
  const allowedRoot = await fs.promises.realpath(policy.allowedRoot);
  if (!(await fs.promises.stat(allowedRoot)).isDirectory()) {
    throw new Error(`source capture allowedRoot is not a directory: ${policy.allowedRoot}`);
  }
  const sourceDir = path.join(caseDir, 'source');

  const units: DiscoveredUnit[] = [];
  // Stable MARS stores the include filename string in one global HashMap. It
  // does not realpath-normalize it, so `lib.asm` and `./lib.asm` are distinct.
  const includedMarsPaths = new Set<string>();
  let totalBytes = 0;

  const discover = async (file: string, depth: number): Promise<DiscoveredUnit> => {
    if (depth > limits.maxDepth) throw new Error(`source include depth exceeds ${limits.maxDepth}`);
    const realPath = await fs.promises.realpath(file);
    assertPathContained(allowedRoot, realPath);
    if (units.length >= limits.maxUnits) throw new Error(`source graph exceeds ${limits.maxUnits} units`);

    const bytes = await readBoundedRegularFile(realPath, {
      maximumBytes: limits.maxBytes - totalBytes,
      label: `source graph byte limit for ${realPath}`
    });
    totalBytes += bytes.byteLength;
    if (depth === 0 && expectedRootBytes && !Buffer.from(expectedRootBytes).equals(bytes)) {
      throw new Error('root ASM changed while its immutable case snapshot was being captured');
    }
    const text = decodeUtf8Losslessly(bytes, realPath);
    const unit: DiscoveredUnit = {
      id: `source-${units.length.toString().padStart(4, '0')}`,
      marsPath: file,
      realPath,
      bytes,
      contentHash: sha256Bytes(bytes),
      provenanceUri: pathToFileURL(realPath).href,
      directives: includeDirectives(text, limits.maxUnits - units.length - 1)
    };
    units.push(unit);
    for (const directive of unit.directives) {
      const requested = directive.requestedPath;
      // Match Tokenizer.processIncludes: parent + separator + raw requested
      // spelling. Do not collapse `.` segments before the duplicate check.
      const targetPath = path.isAbsolute(requested)
        ? requested
        : `${path.dirname(unit.marsPath)}${path.sep}${requested}`;
      if (includedMarsPaths.has(targetPath)) {
        throw new Error(`recursive source include (legacy MARS filename identity): ${targetPath}`);
      }
      includedMarsPaths.add(targetPath);
      const target = await discover(targetPath, depth + 1);
      directive.targetId = target.id;
    }
    return unit;
  };

  const root = await discover(rootFile, 0);
  const edges: SourceGraphEdge[] = [];
  const graphUnits: SourceGraphUnit[] = [];
  for (const unit of units) {
    const materializedName = `${unit.id}${safeAsmExtension(unit.realPath)}`;
    const materializedRelative = posixPath('source', 'materialized', materializedName);
    const rewritten = rewriteIncludes(unit, materializedName, units);
    const blobRelative = posixPath('source', 'blobs', `${unit.contentHash}.bin`);
    await writeImmutableFile(path.join(caseDir, ...blobRelative.split('/')), unit.bytes);
    await writeImmutableFile(path.join(caseDir, ...materializedRelative.split('/')), rewritten);
    graphUnits.push({
      id: unit.id,
      contentHash: unit.contentHash,
      bytes: unit.bytes.byteLength,
      blobPath: blobRelative,
      materializedPath: materializedRelative,
      materializedHash: sha256Bytes(rewritten),
      provenanceUri: unit.provenanceUri
    });
    unit.directives.forEach((directive, ordinal) => {
      if (!directive.targetId) throw new Error(`unresolved include in ${unit.realPath}`);
      edges.push({
        from: unit.id,
        to: directive.targetId,
        ordinal,
        requestedPath: directive.requestedPath,
        pathStartOffset: directive.pathStartOffset,
        pathEndOffset: directive.pathEndOffset
      });
    });
  }

  const graph: SourceGraphBundle = {
    schemaRevision: sourceGraphSchemaRevision,
    rootId: root.id,
    graphFingerprint: '',
    limits: { ...limits },
    units: graphUnits,
    edges
  };
  graph.graphFingerprint = sourceGraphFingerprint(graph);
  const graphPath = path.join(sourceDir, 'graph.json');
  await writeImmutableFile(graphPath, Buffer.from(`${canonicalJson(graph as unknown as CanonicalJson)}\n`, 'utf8'));
  const rootUnit = graphUnits.find((unit) => unit.id === root.id)!;
  return {
    graph,
    graphPath,
    rootMaterializedPath: path.join(caseDir, ...rootUnit.materializedPath.split('/')),
    inputGraph: graphUnits.map((unit) => ({ id: unit.id, contentHash: unit.contentHash }))
  };
}

function assertPathContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`source include escapes the allowed workspace root: ${candidate}`);
  }
}

export function sourceGraphFingerprint(graph: Omit<SourceGraphBundle, 'graphFingerprint'> | SourceGraphBundle): string {
  return sha256Canonical({
    schemaRevision: graph.schemaRevision,
    rootId: graph.rootId,
    limits: graph.limits as unknown as CanonicalJson,
    units: graph.units.map((unit) => ({ id: unit.id, contentHash: unit.contentHash, bytes: unit.bytes })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      ordinal: edge.ordinal,
      requestedPath: edge.requestedPath,
      pathStartOffset: edge.pathStartOffset,
      pathEndOffset: edge.pathEndOffset
    }))
  });
}

export async function loadAndVerifySourceGraph(caseDir: string, graphRelativePath: string): Promise<SourceGraphBundle> {
  return (await loadAndVerifySourceGraphState(caseDir, graphRelativePath)).graph;
}

async function loadAndVerifySourceGraphState(
  caseDir: string,
  graphRelativePath: string
): Promise<{ graph: SourceGraphBundle; rawUnits: Map<string, DiscoveredUnit> }> {
  const graphFile = await resolveContainedRegularFile(caseDir, graphRelativePath);
  let graph: unknown;
  try {
    graph = JSON.parse((await readBoundedRegularFile(graphFile, {
      maximumBytes: maximumSourceGraphJsonBytes,
      label: 'source graph JSON'
    })).toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`source graph JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const structural = sourceGraphIssues(graph);
  if (structural.length) throw new Error(structural.join('; '));
  const typed = graph as SourceGraphBundle;
  const rawUnits = new Map<string, DiscoveredUnit>();
  const materializedFiles = new Map<string, string>();
  for (const unit of typed.units) {
    const [blob, materialized] = await Promise.all([
      resolveContainedRegularFile(caseDir, unit.blobPath),
      resolveContainedRegularFile(caseDir, unit.materializedPath)
    ]);
    const blobBytes = await readBoundedRegularFile(blob, {
      maximumBytes: typed.limits.maxBytes,
      expectedBytes: unit.bytes,
      label: `source graph unit ${unit.id} blob`
    });
    if (blobBytes.byteLength !== unit.bytes || sha256Bytes(blobBytes) !== unit.contentHash) {
      throw new Error(`source graph unit ${unit.id} blob bytes/hash mismatch`);
    }
    const declaredEdges = typed.edges
      .filter((edge) => edge.from === unit.id)
      .sort((left, right) => left.ordinal - right.ordinal);
    const parsedDirectives = includeDirectives(
      decodeUtf8Losslessly(blobBytes, unit.provenanceUri),
      declaredEdges.length
    );
    if (parsedDirectives.length !== declaredEdges.length
      || parsedDirectives.some((directive, index) => {
        const edge = declaredEdges[index];
        return !edge
          || edge.ordinal !== index
          || edge.requestedPath !== directive.requestedPath
          || edge.pathStartOffset !== directive.pathStartOffset
          || edge.pathEndOffset !== directive.pathEndOffset;
      })) {
      throw new Error(`source graph edges do not match parsed include directives for ${unit.id}`);
    }
    rawUnits.set(unit.id, {
      id: unit.id,
      marsPath: unit.provenanceUri,
      realPath: unit.provenanceUri,
      bytes: blobBytes,
      contentHash: unit.contentHash,
      provenanceUri: unit.provenanceUri,
      directives: parsedDirectives.map((directive, index) => ({
        ...directive,
        targetId: declaredEdges[index].to
      }))
    });
    materializedFiles.set(unit.id, materialized);
  }
  for (const unit of typed.units) {
    const reconstructed = rewriteIncludes(
      rawUnits.get(unit.id)!,
      path.basename(unit.materializedPath),
      [...rawUnits.values()]
    );
    if (sha256Bytes(reconstructed) !== unit.materializedHash) {
      throw new Error(`source graph unit ${unit.id} materialized view is not derived from its immutable blob/edges`);
    }
    const materializedBytes = await readBoundedRegularFile(materializedFiles.get(unit.id)!, {
      maximumBytes: typed.limits.maxBytes,
      expectedBytes: reconstructed.byteLength,
      label: `source graph unit ${unit.id} materialized view`
    });
    if (!materializedBytes.equals(reconstructed)) {
      throw new Error(`source graph unit ${unit.id} materialized bytes do not equal the derived view`);
    }
  }
  return { graph: typed, rawUnits };
}

export async function sourceGraphBundleIssues(caseDir: string, graphRelativePath: string): Promise<string[]> {
  try {
    await loadAndVerifySourceGraph(caseDir, graphRelativePath);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export interface VerifiedSourceGraphInput {
  readonly graph: SourceGraphBundle;
  readonly sourceGraphInput: {
    readonly rootId: string;
    readonly sources: readonly SourceUnit[];
    readonly includes: readonly { readonly fromId: string; readonly specifier: string; readonly toId: string }[];
  };
}

/** Load the immutable original source identities used by both production assembly and replay. */
export async function loadVerifiedSourceGraphInput(
  caseDir: string,
  graphRelativePath: string
): Promise<VerifiedSourceGraphInput> {
  const { graph, rawUnits } = await loadOriginalSourceGraph(caseDir, graphRelativePath);
  return {
    graph,
    sourceGraphInput: {
      rootId: graph.rootId,
      sources: graph.units.map((unit) => {
        const original = rawUnits.get(unit.id)!;
        return {
          id: unit.id,
          uri: unit.provenanceUri,
          text: decodeUtf8Losslessly(original.bytes, unit.provenanceUri)
        };
      }),
      includes: graph.edges.map((edge) => ({
        fromId: edge.from,
        specifier: edge.requestedPath,
        toId: edge.to
      }))
    }
  };
}

/** Rebuild a disposable, read-only source tree from original content-addressed blobs. */
export async function materializeSourceGraph(
  caseDir: string,
  graphRelativePath: string,
  destination: string
): Promise<{
  graph: SourceGraphBundle;
  rootFile: string;
  sourceGraphInput: {
    rootId: string;
    sources: SourceUnit[];
    includes: Array<{ fromId: string; specifier: string; toId: string }>;
  };
}> {
  const { graph, rawUnits } = await loadOriginalSourceGraph(caseDir, graphRelativePath);
  await fs.promises.mkdir(destination, { recursive: true });
  for (const unit of graph.units) {
    const discovered = rawUnits.get(unit.id)!;
    const fileName = path.basename(unit.materializedPath);
    const bytes = rewriteIncludes(discovered, fileName, [...rawUnits.values()]);
    if (sha256Bytes(bytes) !== unit.materializedHash) {
      throw new Error(`source graph unit ${unit.id} cannot be deterministically materialized`);
    }
    await writeImmutableFile(path.join(destination, fileName), bytes);
  }
  const rootUnit = graph.units.find((unit) => unit.id === graph.rootId)!;
  return {
    graph,
    rootFile: path.join(destination, path.basename(rootUnit.materializedPath)),
    sourceGraphInput: {
      rootId: graph.rootId,
      sources: graph.units.map((unit) => {
        const original = rawUnits.get(unit.id)!;
        return {
          id: unit.id,
          uri: unit.provenanceUri,
          text: decodeUtf8Losslessly(original.bytes, unit.provenanceUri)
        };
      }),
      includes: graph.edges.map((edge) => ({
        fromId: edge.from,
        specifier: edge.requestedPath,
        toId: edge.to
      }))
    }
  };
}

async function loadOriginalSourceGraph(
  caseDir: string,
  graphRelativePath: string
): Promise<{ graph: SourceGraphBundle; rawUnits: Map<string, DiscoveredUnit> }> {
  // The verifier already read, hashed and parsed every immutable blob. Reuse those
  // exact bytes as one atomic snapshot instead of reopening every file immediately.
  return await loadAndVerifySourceGraphState(caseDir, graphRelativePath);
}

export function sourceGraphIssues(value: unknown): string[] {
  if (!isRecord(value)) return ['source graph root must be an object'];
  const issues: string[] = [];
  if (!onlyKeys(value, ['schemaRevision', 'rootId', 'graphFingerprint', 'limits', 'units', 'edges'])) issues.push('source graph contains unknown fields');
  if (value.schemaRevision !== sourceGraphSchemaRevision) issues.push('source graph schemaRevision must be 1');
  if (!nonEmpty(value.rootId)) issues.push('source graph rootId is invalid');
  if (!isSha256(value.graphFingerprint)) issues.push('source graph graphFingerprint is invalid');
  if (!validLimits(value.limits)) issues.push('source graph limits are invalid');
  if (!Array.isArray(value.units) || !value.units.length || !value.units.every(validUnit)) issues.push('source graph units are invalid');
  if (!Array.isArray(value.edges) || !value.edges.every(validEdge)) issues.push('source graph edges are invalid');
  if (!issues.length) {
    const graph = value as unknown as SourceGraphBundle;
    const ids = graph.units.map((unit) => unit.id);
    if (new Set(ids).size !== ids.length) issues.push('source graph unit ids are not unique');
    if (!ids.includes(graph.rootId)) issues.push('source graph rootId does not exist');
    if (graph.rootId !== 'source-0000') issues.push('source graph rootId must be source-0000');
    graph.units.forEach((unit, index) => {
      if (unit.id !== `source-${index.toString().padStart(4, '0')}`) {
        issues.push('source graph unit ids are not in canonical discovery order');
      }
    });
    if (graph.units.length > graph.limits.maxUnits) issues.push('source graph exceeds its declared maxUnits');
    if (graph.units.reduce((sum, unit) => sum + unit.bytes, 0) > graph.limits.maxBytes) {
      issues.push('source graph exceeds its declared maxBytes');
    }
    for (const edge of graph.edges) {
      if (!ids.includes(edge.from) || !ids.includes(edge.to)) issues.push('source graph edge references an unknown unit');
    }
    const topology = sourceGraphTopologyIssues(graph);
    issues.push(...topology);
    if (sourceGraphFingerprint(graph) !== graph.graphFingerprint.toLowerCase()) issues.push('source graph fingerprint mismatch');
  }
  return [...new Set(issues)];
}

function sourceGraphTopologyIssues(graph: SourceGraphBundle): string[] {
  const issues: string[] = [];
  const index = new Map(graph.units.map((unit, unitIndex) => [unit.id, unitIndex]));
  const outgoing = new Map(graph.units.map((unit) => [unit.id, [] as SourceGraphEdge[]]));
  const incoming = new Map(graph.units.map((unit) => [unit.id, 0]));
  for (const edge of graph.edges) {
    if (!index.has(edge.from) || !index.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    if (index.get(edge.to)! <= index.get(edge.from)!) {
      issues.push('source graph edges must follow canonical acyclic discovery order');
    }
  }
  for (const unit of graph.units) {
    const expected = unit.id === graph.rootId ? 0 : 1;
    if ((incoming.get(unit.id) ?? 0) !== expected) {
      issues.push('source graph must be the captured include tree with one parent per non-root unit');
    }
  }
  for (const edges of outgoing.values()) {
    edges.sort((left, right) => left.ordinal - right.ordinal);
    if (edges.some((edge, ordinal) => edge.ordinal !== ordinal)) {
      issues.push('source graph edge ordinals must be contiguous per source unit');
    }
  }
  const depth = new Map<string, number>([[graph.rootId, 0]]);
  for (const unit of graph.units) {
    const unitDepth = depth.get(unit.id);
    if (unitDepth === undefined) continue;
    for (const edge of outgoing.get(unit.id) ?? []) {
      const nextDepth = unitDepth + 1;
      depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, nextDepth));
      if (nextDepth > graph.limits.maxDepth) issues.push('source graph exceeds its declared maxDepth');
    }
  }
  if (depth.size !== graph.units.length) issues.push('source graph contains units unreachable from its root');
  const discoveryOrder: string[] = [];
  const visit = (id: string): void => {
    if (discoveryOrder.includes(id)) return;
    discoveryOrder.push(id);
    for (const edge of outgoing.get(id) ?? []) visit(edge.to);
  };
  visit(graph.rootId);
  if (JSON.stringify(discoveryOrder) !== JSON.stringify(graph.units.map((unit) => unit.id))) {
    issues.push('source graph units do not follow canonical depth-first discovery order');
  }
  return issues;
}

function includeDirectives(text: string, maximumDirectives: number): IncludeDirective[] {
  if (!Number.isSafeInteger(maximumDirectives) || maximumDirectives < 0) {
    throw new Error('source include directive ceiling is invalid');
  }
  const result: IncludeDirective[] = [];
  let lineStart = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== '\n') continue;
    const lineEnd = index > lineStart && text[index - 1] === '\r' ? index - 1 : index;
    const scanStart = lineStart === 0 && text.charCodeAt(0) === 0xfeff ? 1 : lineStart;
    const directive = firstMarsIncludeDirective(text, scanStart, lineEnd);
    if (directive) {
      if (result.length >= maximumDirectives) {
        throw new Error(`source include directive count exceeds the trusted ceiling ${maximumDirectives}`);
      }
      result.push(directive);
    }
    lineStart = index + 1;
  }
  return result;
}

/**
 * Stream the offset-preserving subset of MARS Tokenizer.tokenizeLine needed by
 * Tokenizer.processIncludes. Keeping only whether the preceding token was
 * `.include` avoids allocating one object and substring per token on a large
 * generated source line.
 */
function firstMarsIncludeDirective(text: string, lineStart: number, lineEnd: number): IncludeDirective | undefined {
  let tokenStart = -1;
  let previousWasInclude = false;
  const flushOtherToken = (end: number): void => {
    if (tokenStart < 0) return;
    previousWasInclude = isMarsIncludeToken(text, tokenStart, end);
    tokenStart = -1;
  };

  for (let index = lineStart; index < lineEnd; index++) {
    const char = text[index];
    if (char === '#') {
      flushOtherToken(index);
      return undefined;
    }
    if (char === ' ' || char === '\t' || char === ',') {
      flushOtherToken(index);
      continue;
    }
    if (char === '"') {
      flushOtherToken(index);
      const start = index;
      index++;
      while (index < lineEnd) {
        if (text[index] === '"' && text[index - 1] !== '\\') break;
        index++;
      }
      const closed = index < lineEnd;
      const end = Math.min(index + 1, lineEnd);
      if (closed && previousWasInclude) {
        // Tokenizer.processIncludes replaces the complete source line with the
        // first include it finds; later tokens on that line are not processed.
        return {
          requestedPath: text.slice(start + 1, end - 1),
          pathStartOffset: start + 1,
          pathEndOffset: end - 1
        };
      }
      previousWasInclude = false;
      continue;
    }
    if (char === '\'') {
      flushOtherToken(index);
      index++;
      while (index < lineEnd) {
        if (text[index] === '\'' && text[index - 1] !== '\\') break;
        index++;
      }
      previousWasInclude = false;
      continue;
    }
    if (char === ':' || char === '(' || char === ')' || char === '+' || char === '-') {
      flushOtherToken(index);
      previousWasInclude = false;
      continue;
    }
    if (tokenStart < 0) tokenStart = index;
  }
  flushOtherToken(lineEnd);
  return undefined;
}

function isMarsIncludeToken(text: string, start: number, end: number): boolean {
  if (end - start !== 8 || text.charCodeAt(start) !== 0x2e) return false; // '.'
  return asciiLowerCode(text.charCodeAt(start + 1)) === 0x69 // i
    && asciiLowerCode(text.charCodeAt(start + 2)) === 0x6e // n
    && asciiLowerCode(text.charCodeAt(start + 3)) === 0x63 // c
    && asciiLowerCode(text.charCodeAt(start + 4)) === 0x6c // l
    && asciiLowerCode(text.charCodeAt(start + 5)) === 0x75 // u
    && asciiLowerCode(text.charCodeAt(start + 6)) === 0x64 // d
    && asciiLowerCode(text.charCodeAt(start + 7)) === 0x65; // e
}

function asciiLowerCode(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

function rewriteIncludes(unit: DiscoveredUnit, ownName: string, units: readonly DiscoveredUnit[]): Buffer {
  if (!unit.directives.length) return unit.bytes;
  const text = decodeUtf8Losslessly(unit.bytes, unit.realPath);
  const names = new Map(units.map((entry) => [entry.id, `${entry.id}${safeAsmExtension(entry.realPath)}`]));
  const chunks: string[] = [];
  let cursor = 0;
  for (const directive of [...unit.directives].sort((a, b) => a.pathStartOffset - b.pathStartOffset)) {
    const target = directive.targetId && names.get(directive.targetId);
    if (!target) throw new Error(`source materialization has an unresolved edge in ${ownName}`);
    if (directive.pathStartOffset < cursor
      || directive.pathEndOffset < directive.pathStartOffset
      || directive.pathEndOffset > text.length) {
      throw new Error(`source materialization has overlapping or invalid include offsets in ${ownName}`);
    }
    const relative = `./${target}`;
    chunks.push(text.slice(cursor, directive.pathStartOffset), relative);
    cursor = directive.pathEndOffset;
  }
  chunks.push(text.slice(cursor));
  return Buffer.from(chunks.join(''), 'utf8');
}

async function writeImmutableFile(file: string, bytes: Uint8Array): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  try {
    const existing = await readBoundedRegularFile(file, {
      maximumBytes: bytes.byteLength,
      expectedBytes: bytes.byteLength,
      label: `immutable content-addressed file ${file}`
    });
    if (!Buffer.from(existing).equals(Buffer.from(bytes))) throw new Error(`content-addressed file collision at ${file}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.promises.writeFile(temp, bytes, { flag: 'wx', mode: 0o444 });
    await fs.promises.rename(temp, file);
    await fs.promises.chmod(file, 0o444).catch(() => undefined);
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function resolveContainedRegularFile(rootDir: string, relativePath: string): Promise<string> {
  if (!safeRelative(relativePath)) throw new Error(`unsafe source bundle path: ${relativePath}`);
  const root = await fs.promises.realpath(rootDir);
  const candidate = path.resolve(root, ...relativePath.split('/'));
  const real = await fs.promises.realpath(candidate);
  const relative = path.relative(root, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('source bundle path escapes case directory');
  const stat = await fs.promises.lstat(real);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('source bundle path is not a regular non-symlink file');
  return real;
}

function decodeUtf8Losslessly(bytes: Buffer, file: string): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`source is not lossless UTF-8: ${file}`);
  return text;
}

function safeAsmExtension(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ['.asm', '.s', '.mips'].includes(extension) ? extension : '.asm';
}

function posixPath(...parts: string[]): string { return parts.join('/'); }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function isSha256(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const set = new Set(keys); return Object.keys(value).every((key) => set.has(key)); }
function safeRelative(value: string): boolean {
  return value.length > 0 && !value.includes('\\')
    && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function assertLimits(value: SourceCaptureLimits): void {
  if (!validLimits(value)) throw new Error('invalid source capture limits');
}

function validLimits(value: unknown): value is SourceCaptureLimits {
  return isRecord(value) && onlyKeys(value, ['maxDepth', 'maxUnits', 'maxBytes'])
    && Number.isSafeInteger(value.maxDepth) && (value.maxDepth as number) > 0
    && (value.maxDepth as number) <= maximumReplaySourceDepth
    && Number.isSafeInteger(value.maxUnits) && (value.maxUnits as number) > 0
    && (value.maxUnits as number) <= maximumReplaySourceUnits
    && Number.isSafeInteger(value.maxBytes) && (value.maxBytes as number) > 0
    && (value.maxBytes as number) <= maximumReplaySourceBytes;
}

function validUnit(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ['id', 'contentHash', 'bytes', 'blobPath', 'materializedPath', 'materializedHash', 'provenanceUri'])
    && nonEmpty(value.id) && isSha256(value.contentHash) && Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0
    && typeof value.blobPath === 'string' && safeRelative(value.blobPath)
    && typeof value.materializedPath === 'string' && safeRelative(value.materializedPath)
    && isSha256(value.materializedHash) && nonEmpty(value.provenanceUri);
}

function validEdge(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ['from', 'to', 'ordinal', 'requestedPath', 'pathStartOffset', 'pathEndOffset'])
    && nonEmpty(value.from) && nonEmpty(value.to) && Number.isSafeInteger(value.ordinal) && (value.ordinal as number) >= 0
    && nonEmpty(value.requestedPath) && Number.isSafeInteger(value.pathStartOffset) && (value.pathStartOffset as number) >= 0
    && Number.isSafeInteger(value.pathEndOffset) && (value.pathEndOffset as number) > (value.pathStartOffset as number);
}
