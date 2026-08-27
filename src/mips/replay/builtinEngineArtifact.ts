// @index mips-replay — builtin TS executor 的不可变逻辑 artifact（revision 元组 + catalog hash）

import type { EngineArtifactIdentity } from '../providers/contracts';
import { commitEventSchemaRevision } from '../core/events/commitEvent';
import { executionCoverageRevision } from '../core/events/coverage';
import { traceProjectionRevision } from '../core/events/traceProjection';
import { isaCatalogSchemaRevision, isaCatalogSha256 } from '../core/generated/isaCatalog';
import { executorSemanticsRevision } from '../core/machine/executeService';
import { canonicalJson, sha256Bytes, type CanonicalJson } from './canonical';

/**
 * The builtin executor is compiled into the extension, not downloaded as a file.
 * Exact replay still needs a registry-resolvable immutable digest, so phase 4
 * freezes the engine as this logical manifest: every field that can change its
 * observable semantics participates in the SHA-256. A missing registry entry
 * therefore fails exact replay explicitly instead of silently executing a
 * different extension build (计划第 5.8 节).
 */

export const builtinExecutionArtifactSchemaRevision = 1 as const;
export const builtinExecutionArtifactRole = 'builtin-ts-executor';
export const builtinExecutionArtifactFileName = 'builtin-ts-executor.manifest.json';

export interface BuiltinExecutionEngineArtifact {
  readonly identity: EngineArtifactIdentity;
  readonly bytes: Buffer;
  readonly document: BuiltinExecutionArtifactDocument;
}

export interface BuiltinExecutionArtifactDocument {
  readonly schemaRevision: typeof builtinExecutionArtifactSchemaRevision;
  readonly role: typeof builtinExecutionArtifactRole;
  readonly engine: {
    readonly id: 'builtin-ts';
    readonly kind: 'executor';
    readonly semanticsRevision: number;
    readonly capabilitiesRevision: number;
  };
  readonly catalog: {
    readonly revision: typeof isaCatalogSchemaRevision;
    readonly sha256: typeof isaCatalogSha256;
  };
  readonly normalizerRevision: number;
  readonly eventSchemaRevision: typeof commitEventSchemaRevision;
  readonly traceProjectionRevision: typeof traceProjectionRevision;
  readonly coverageRevision: typeof executionCoverageRevision;
  readonly courseContractRevision: number;
  readonly executorSemanticsRevision: typeof executorSemanticsRevision;
}

export function builtinExecutionEngineDocument(): BuiltinExecutionArtifactDocument {
  return Object.freeze({
    schemaRevision: builtinExecutionArtifactSchemaRevision,
    role: builtinExecutionArtifactRole,
    engine: Object.freeze({
      id: 'builtin-ts' as const,
      kind: 'executor' as const,
      semanticsRevision: 1,
      capabilitiesRevision: 1
    }),
    catalog: Object.freeze({
      revision: isaCatalogSchemaRevision,
      sha256: isaCatalogSha256
    }),
    normalizerRevision: 1,
    eventSchemaRevision: commitEventSchemaRevision,
    traceProjectionRevision,
    coverageRevision: executionCoverageRevision,
    courseContractRevision: 1,
    executorSemanticsRevision
  });
}

export function builtinExecutionArtifactBytes(): Buffer {
  return Buffer.from(`${canonicalJson(builtinExecutionEngineDocument() as unknown as CanonicalJson)}\n`, 'utf8');
}

export function builtinExecutionEngineArtifact(): BuiltinExecutionEngineArtifact {
  const bytes = builtinExecutionArtifactBytes();
  return {
    bytes,
    identity: {
      sha256: sha256Bytes(bytes),
      role: builtinExecutionArtifactRole,
      fileName: builtinExecutionArtifactFileName
    },
    document: builtinExecutionEngineDocument()
  };
}

/** True when staged registry bytes still describe this compiled executor revision tuple. */
export function builtinExecutionArtifactMatchesBytes(bytes: Uint8Array): boolean {
  const expected = builtinExecutionArtifactBytes();
  return bytes.byteLength === expected.byteLength && sha256Bytes(bytes) === sha256Bytes(expected);
}
