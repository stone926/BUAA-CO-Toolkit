// @index course-testing — shadow bundle shared immutable source-closure capture

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type { AsmCase } from '../asmCaseStore';
import type { AsmCaseSnapshot } from '../asmCaseStoreCore';
import { writeFileAtomicReplace } from '../mips/replay/atomicFile';
import {
  maximumReplaySourceBytes,
  readBoundedRegularFile
} from '../mips/replay/boundedFile';
import {
  loadAndVerifySourceGraph,
  type SourceGraphBundle
} from '../mips/replay/sourceBundle';
import { isManifestV2, isSafeCaseRelativePath } from './manifestCodec';

export interface CopyShadowSourceClosureOptions {
  /** Full-stack evidence requires the complete hashed v2 source graph, not an early-v2 subset. */
  readonly requireCompleteV2?: boolean;
}

export interface CopiedShadowSourceClosure {
  readonly graph?: SourceGraphBundle;
}

/**
 * Copy the already-verified, immutable source closure into a shadow bundle.
 * Every reference is contained beneath the case directory and is checked
 * against the byte count captured by manifest v2 before it is copied.
 */
export async function copyShadowCaseSourceClosure(
  asmCase: AsmCase,
  destination: string,
  options: CopyShadowSourceClosureOptions = {}
): Promise<CopiedShadowSourceClosure> {
  await fs.promises.mkdir(destination, { recursive: true });
  if (!isManifestV2(asmCase.manifest)) {
    if (options.requireCompleteV2) throw new Error('full-stack source closure requires manifest v2');
    return {};
  }

  const artifacts = asmCase.manifest.artifacts?.source ?? {};
  let graph: SourceGraphBundle | undefined;
  if (options.requireCompleteV2) {
    const graphReference = asmCase.manifest.program.sourceGraph;
    if (!graphReference) throw new Error('full-stack source closure has no program.sourceGraph snapshot');
    const graphArtifact = artifacts.graph;
    if (!snapshotMatches(graphArtifact, graphReference)) {
      throw new Error('artifacts.source.graph does not exactly identify program.sourceGraph');
    }
    if (artifacts.original !== undefined
      && !snapshotMatches(artifacts.original, asmCase.manifest.asmSnapshot)) {
      throw new Error('artifacts.source.original does not exactly identify asmSnapshot');
    }
    graph = await loadAndVerifySourceGraph(asmCase.dir.fsPath, graphReference.path);
    for (const unit of graph.units) {
      const blob = artifacts[`blob/${unit.contentHash}`];
      if (!snapshotMatches(blob, {
        path: unit.blobPath,
        sha256: unit.contentHash,
        bytes: unit.bytes
      })) {
        throw new Error(`artifacts.source.blob/${unit.contentHash} does not identify ${unit.id}`);
      }
      const materialized = artifacts[`materialized/${unit.id}`];
      if (!isSnapshot(materialized)
        || materialized.path !== unit.materializedPath
        || materialized.sha256.toLowerCase() !== unit.materializedHash.toLowerCase()) {
        throw new Error(`artifacts.source.materialized/${unit.id} does not identify its derived source view`);
      }
    }
  }

  if (options.requireCompleteV2 && !Object.keys(artifacts).length) {
    throw new Error('full-stack source closure has no hashed source artifacts');
  }
  const caseDir = await fs.promises.realpath(asmCase.dir.fsPath);
  const destinationRoot = await fs.promises.realpath(destination);
  const closureEntries: Array<[string, unknown]> = Object.entries(artifacts);
  if (options.requireCompleteV2 && !closureEntries.some(([, reference]) =>
    snapshotMatches(reference, asmCase.manifest.asmSnapshot))) {
    // Production v2 manifests keep the root snapshot in `asmSnapshot`; the
    // optional `artifacts.source.original` alias only exists in some early
    // drafts.  A full-stack bundle must retain it regardless of that alias.
    closureEntries.push(['original', asmCase.manifest.asmSnapshot]);
  }
  for (const [name, reference] of closureEntries) {
    if (!isSnapshot(reference)) {
      if (options.requireCompleteV2) {
        throw new Error(`source artifact ${name} is not a hashed v2 snapshot`);
      }
      continue;
    }
    if (!isSafeCaseRelativePath(reference.path)) {
      throw new Error(`source artifact ${name} path is not safe and case-relative`);
    }
    const relative = reference.path;
    const sourceFile = await resolveContainedSourceFile(caseDir, relative, name);
    const bytes = await readBoundedRegularFile(sourceFile, {
      maximumBytes: maximumReplaySourceBytes,
      expectedBytes: reference.bytes,
      label: `shadow source closure ${name}`
    });
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== reference.sha256.toLowerCase()) {
      throw new Error(`shadow source closure ${name} bytes/hash mismatch`);
    }
    const target = path.resolve(destinationRoot, ...relative.split('/'));
    assertContained(destinationRoot, target, `shadow source closure target ${name}`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomicReplace(target, Buffer.from(bytes));
  }
  return { ...(graph ? { graph } : {}) };
}

function isSnapshot(value: unknown): value is AsmCaseSnapshot {
  return value !== null && typeof value === 'object' && typeof (value as AsmCaseSnapshot).path === 'string'
    && Number.isSafeInteger((value as AsmCaseSnapshot).bytes)
    && (value as AsmCaseSnapshot).bytes >= 0
    && /^[0-9a-f]{64}$/i.test((value as AsmCaseSnapshot).sha256);
}

function snapshotMatches(value: unknown, expected: AsmCaseSnapshot): boolean {
  return isSnapshot(value)
    && value.path === expected.path
    && value.bytes === expected.bytes
    && value.sha256.toLowerCase() === expected.sha256.toLowerCase();
}

async function resolveContainedSourceFile(root: string, relative: string, name: string): Promise<string> {
  const lexical = path.resolve(root, ...relative.split('/'));
  assertContained(root, lexical, `source artifact ${name}`);
  const lexicalStat = await fs.promises.lstat(lexical);
  if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) {
    throw new Error(`source artifact ${name} is not a regular non-symlink file`);
  }
  const real = await fs.promises.realpath(lexical);
  assertContained(root, real, `source artifact ${name}`);
  return real;
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its containment root`);
  }
}
