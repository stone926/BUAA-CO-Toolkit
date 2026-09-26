// @index mips-replay — builtin TS assembler 的不可变逻辑 artifact（revision 元组 + catalog hash）

import type { EngineArtifactIdentity } from '../providers/contracts';
import { isaCatalogSchemaRevision, isaCatalogSha256 } from '../core/generated/isaCatalog';
import { courseAssemblerSemanticsRevision } from '../core/assembler/assembler';
import { canonicalJson, sha256Bytes, type CanonicalJson } from './canonical';

export const builtinAssemblerArtifactSchemaRevision = 1 as const;
export const builtinAssemblerArtifactRole = 'builtin-ts-assembler';
export const builtinAssemblerArtifactFileName = 'builtin-ts-assembler.manifest.json';

export interface BuiltinAssemblerEngineArtifact {
  readonly identity: EngineArtifactIdentity;
  readonly bytes: Buffer;
  readonly document: BuiltinAssemblerArtifactDocument;
}

export interface BuiltinAssemblerArtifactDocument {
  readonly schemaRevision: typeof builtinAssemblerArtifactSchemaRevision;
  readonly role: typeof builtinAssemblerArtifactRole;
  readonly engine: {
    readonly id: 'builtin-ts';
    readonly kind: 'assembler';
    readonly semanticsRevision: number;
    readonly capabilitiesRevision: number;
  };
  readonly catalog: {
    readonly revision: typeof isaCatalogSchemaRevision;
    readonly sha256: typeof isaCatalogSha256;
  };
  readonly normalizerRevision: number;
  readonly courseContractRevision: number;
  readonly assemblerSemanticsRevision: typeof courseAssemblerSemanticsRevision;
}

export function builtinAssemblerEngineDocument(): BuiltinAssemblerArtifactDocument {
  return Object.freeze({
    schemaRevision: builtinAssemblerArtifactSchemaRevision,
    role: builtinAssemblerArtifactRole,
    engine: Object.freeze({
      id: 'builtin-ts' as const,
      kind: 'assembler' as const,
      semanticsRevision: courseAssemblerSemanticsRevision,
      capabilitiesRevision: 1
    }),
    catalog: Object.freeze({
      revision: isaCatalogSchemaRevision,
      sha256: isaCatalogSha256
    }),
    normalizerRevision: 1,
    courseContractRevision: 1,
    assemblerSemanticsRevision: courseAssemblerSemanticsRevision
  });
}

export function builtinAssemblerArtifactBytes(): Buffer {
  return Buffer.from(`${canonicalJson(builtinAssemblerEngineDocument() as unknown as CanonicalJson)}\n`, 'utf8');
}

export function builtinAssemblerEngineArtifact(): BuiltinAssemblerEngineArtifact {
  const bytes = builtinAssemblerArtifactBytes();
  return {
    bytes,
    identity: {
      sha256: sha256Bytes(bytes),
      role: builtinAssemblerArtifactRole,
      fileName: builtinAssemblerArtifactFileName
    },
    document: builtinAssemblerEngineDocument()
  };
}
