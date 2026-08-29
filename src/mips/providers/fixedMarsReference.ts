// @index mips-providers — 固定 MARS reference：resource-scoped 路径与编译内置信任身份校验

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

import { getMarsJar } from '../../config';
import {
  fixedReferenceEngineArtifactTrustManifest,
  maximumEngineArtifactBytes,
  type EngineArtifactTrustManifest
} from '../replay/engineRegistry';
import type { EngineArtifactIdentity } from './contracts';

export const fixedMarsCourseExecutorRole = 'legacy-course-executor' as const;

export type FixedMarsReferenceDiagnosticCode =
  | 'fixed-mars-reference.not-configured'
  | 'fixed-mars-reference.trust-role-missing'
  | 'fixed-mars-reference.trust-role-ambiguous'
  | 'fixed-mars-reference.trust-entry-invalid'
  | 'fixed-mars-reference.cancelled'
  | 'fixed-mars-reference.file-missing'
  | 'fixed-mars-reference.file-unreadable'
  | 'fixed-mars-reference.file-not-regular'
  | 'fixed-mars-reference.file-changed'
  | 'fixed-mars-reference.size-mismatch'
  | 'fixed-mars-reference.sha256-mismatch';

export interface FixedMarsReferenceDiagnostic {
  readonly code: FixedMarsReferenceDiagnosticCode;
  readonly message: string;
  readonly role: typeof fixedMarsCourseExecutorRole;
  readonly path?: string;
  readonly expected?: string | number;
  readonly actual?: string | number;
}

export interface VerifiedFixedMarsReference {
  readonly ok: true;
  readonly path: string;
  readonly identity: EngineArtifactIdentity;
  readonly bytes: number;
  readonly authority: string;
  readonly trustRevision: string;
}

export interface RejectedFixedMarsReference {
  readonly ok: false;
  readonly diagnostic: FixedMarsReferenceDiagnostic;
}

export type FixedMarsReferenceVerificationResult =
  | VerifiedFixedMarsReference
  | RejectedFixedMarsReference;

export interface FixedMarsReferenceFileSnapshot {
  readonly bytes: number;
  /** Omitted when the exact-size check fails before hashing. */
  readonly sha256?: string;
}

export interface FixedMarsReferenceVerifierDependencies {
  readonly getMarsJar: (resource?: vscode.Uri) => string;
  readonly trustManifest: Readonly<EngineArtifactTrustManifest>;
  readonly inspectFile: (
    file: string,
    expectedBytes: number,
    signal?: AbortSignal
  ) => Promise<FixedMarsReferenceFileSnapshot>;
}

export interface FixedMarsReferenceVerificationOptions {
  readonly signal?: AbortSignal;
}

const defaultDependencies: FixedMarsReferenceVerifierDependencies = Object.freeze({
  // Keep configuration access lazy so ordinary builtin runs/tests do not need
  // to materialize legacy tool settings merely by importing this module.
  getMarsJar: (resource?: vscode.Uri) => getMarsJar(resource),
  trustManifest: fixedReferenceEngineArtifactTrustManifest,
  inspectFile: inspectFixedMarsReferenceFile
});

/**
 * Verify that the resource-scoped MARS setting is exactly the compiled
 * `legacy-course-executor` release identity. The configured basename is never
 * consulted: authority comes only from role + byte count + SHA-256 in the
 * application-owned trust manifest.
 *
 * `dependencies` is a narrow test seam for small fixtures. Production callers
 * must omit it so workspace files cannot replace the compiled trust root.
 */
export async function verifyConfiguredFixedMarsReference(
  resource?: vscode.Uri,
  options: FixedMarsReferenceVerificationOptions = {},
  dependencies: Partial<FixedMarsReferenceVerifierDependencies> = {}
): Promise<FixedMarsReferenceVerificationResult> {
  const resolvedDependencies: FixedMarsReferenceVerifierDependencies = {
    ...defaultDependencies,
    ...dependencies
  };
  const role = fixedMarsCourseExecutorRole;
  const configured = resolvedDependencies.getMarsJar(resource)?.trim() ?? '';
  if (!configured) {
    return rejected('fixed-mars-reference.not-configured', '固定 MARS reference 未配置', role);
  }
  const configuredPath = path.resolve(configured);
  if (options.signal?.aborted) {
    return rejected('fixed-mars-reference.cancelled', '固定 MARS reference 校验已取消', role, configuredPath);
  }

  const roleEntries = resolvedDependencies.trustManifest.artifacts.filter((entry) => entry.role === role);
  if (!roleEntries.length) {
    return rejected(
      'fixed-mars-reference.trust-role-missing',
      `编译内置信任清单缺少角色 ${role}`,
      role,
      configuredPath
    );
  }
  if (roleEntries.length !== 1) {
    return rejected(
      'fixed-mars-reference.trust-role-ambiguous',
      `编译内置信任清单中的角色 ${role} 不唯一`,
      role,
      configuredPath,
      1,
      roleEntries.length
    );
  }
  const trusted = roleEntries[0];
  if (!Number.isSafeInteger(trusted.bytes)
    || trusted.bytes <= 0
    || trusted.bytes > maximumEngineArtifactBytes
    || !/^[0-9a-f]{64}$/i.test(trusted.sha256)) {
    return rejected(
      'fixed-mars-reference.trust-entry-invalid',
      `编译内置信任清单中的角色 ${role} 元数据无效`,
      role,
      configuredPath
    );
  }

  let snapshot: FixedMarsReferenceFileSnapshot;
  try {
    snapshot = await resolvedDependencies.inspectFile(configuredPath, trusted.bytes, options.signal);
  } catch (error) {
    const issue = fixedMarsFileIssue(error);
    return rejected(issue.code, issue.message, role, configuredPath);
  }
  if (snapshot.bytes !== trusted.bytes) {
    return rejected(
      'fixed-mars-reference.size-mismatch',
      `固定 MARS reference 大小不匹配：期望 ${trusted.bytes} bytes，实际 ${snapshot.bytes} bytes`,
      role,
      configuredPath,
      trusted.bytes,
      snapshot.bytes
    );
  }
  const actualDigest = snapshot.sha256?.toLowerCase();
  const expectedDigest = trusted.sha256.toLowerCase();
  if (actualDigest !== expectedDigest) {
    return rejected(
      'fixed-mars-reference.sha256-mismatch',
      '固定 MARS reference SHA-256 与编译内置信任身份不一致',
      role,
      configuredPath,
      expectedDigest,
      actualDigest ?? 'missing'
    );
  }

  return {
    ok: true,
    path: configuredPath,
    identity: {
      role,
      sha256: expectedDigest,
      ...(trusted.fileName ? { fileName: trusted.fileName } : {})
    },
    bytes: trusted.bytes,
    authority: resolvedDependencies.trustManifest.authority,
    trustRevision: resolvedDependencies.trustManifest.revision
  };
}

async function inspectFixedMarsReferenceFile(
  file: string,
  expectedBytes: number,
  signal?: AbortSignal
): Promise<FixedMarsReferenceFileSnapshot> {
  throwIfAborted(signal);
  let lexicalStat: fs.Stats;
  try {
    lexicalStat = await fs.promises.lstat(file);
  } catch (error) {
    throw fileIssueFromFsError(error, file);
  }
  throwIfAborted(signal);
  if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) {
    throw fixedMarsFileError('not-regular', `固定 MARS reference 不是普通非符号链接文件：${file}`);
  }

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch (error) {
    throw fileIssueFromFsError(error, file);
  }
  try {
    const before = await handle.stat();
    throwIfAborted(signal);
    if (!before.isFile()) {
      throw fixedMarsFileError('not-regular', `固定 MARS reference 不是普通文件：${file}`);
    }
    if (before.dev !== lexicalStat.dev || before.ino !== lexicalStat.ino) {
      throw fixedMarsFileError('changed', '固定 MARS reference 在打开期间发生变化');
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      throw fixedMarsFileError('unreadable', '固定 MARS reference 文件大小无效');
    }
    if (before.size !== expectedBytes) {
      return { bytes: before.size };
    }

    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expectedBytes)));
    let offset = 0;
    while (offset < before.size) {
      throwIfAborted(signal);
      const length = Math.min(buffer.byteLength, before.size - offset);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead <= 0) {
        throw fixedMarsFileError('changed', '固定 MARS reference 在读取期间发生变化');
      }
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      throw fixedMarsFileError('changed', '固定 MARS reference 在读取期间增长');
    }
    const after = await handle.stat();
    if (!after.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || offset !== before.size) {
      throw fixedMarsFileError('changed', '固定 MARS reference 在校验期间发生变化');
    }
    throwIfAborted(signal);
    return { bytes: offset, sha256: hash.digest('hex') };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type FixedMarsFileIssueKind = 'missing' | 'unreadable' | 'not-regular' | 'changed' | 'cancelled';

interface FixedMarsFileError extends Error {
  readonly fixedMarsFileIssue: FixedMarsFileIssueKind;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw fixedMarsFileError('cancelled', '固定 MARS reference 校验已取消');
  }
}

function fixedMarsFileError(kind: FixedMarsFileIssueKind, message: string): FixedMarsFileError {
  const error = new Error(message) as FixedMarsFileError;
  Object.defineProperty(error, 'fixedMarsFileIssue', { value: kind, enumerable: false });
  return error;
}

function fileIssueFromFsError(error: unknown, file: string): FixedMarsFileError {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return fixedMarsFileError('missing', `固定 MARS reference 文件不存在：${file}`);
  }
  return fixedMarsFileError(
    'unreadable',
    `无法读取固定 MARS reference：${error instanceof Error ? error.message : String(error)}`
  );
}

function fixedMarsFileIssue(error: unknown): {
  code: FixedMarsReferenceDiagnosticCode;
  message: string;
} {
  const kind = (error as Partial<FixedMarsFileError> | undefined)?.fixedMarsFileIssue;
  switch (kind) {
    case 'missing': return { code: 'fixed-mars-reference.file-missing', message: (error as Error).message };
    case 'not-regular': return { code: 'fixed-mars-reference.file-not-regular', message: (error as Error).message };
    case 'changed': return { code: 'fixed-mars-reference.file-changed', message: (error as Error).message };
    case 'cancelled': return { code: 'fixed-mars-reference.cancelled', message: (error as Error).message };
    default:
      return {
        code: 'fixed-mars-reference.file-unreadable',
        message: error instanceof Error ? error.message : String(error)
      };
  }
}

function rejected(
  code: FixedMarsReferenceDiagnosticCode,
  message: string,
  role: typeof fixedMarsCourseExecutorRole,
  file?: string,
  expected?: string | number,
  actual?: string | number
): RejectedFixedMarsReference {
  return {
    ok: false,
    diagnostic: {
      code,
      message,
      role,
      ...(file ? { path: file } : {}),
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual })
    }
  };
}
