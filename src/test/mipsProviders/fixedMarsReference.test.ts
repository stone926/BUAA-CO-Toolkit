import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  fixedMarsCourseExecutorRole,
  verifyConfiguredFixedMarsReference,
  type FixedMarsReferenceVerifierDependencies
} from '../../mips/providers/fixedMarsReference';
import { sha256Bytes } from '../../mips/replay/canonical';
import type { EngineArtifactTrustManifest } from '../../mips/replay/engineRegistry';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })
  ));
});

describe('fixed MARS reference verification', () => {
  it('fails closed when the resource-scoped MARS path is not configured', async () => {
    const result = await verifyConfiguredFixedMarsReference(
      undefined,
      {},
      dependencies('', Buffer.from('fixed-reference'))
    );

    expect(result).toEqual({
      ok: false,
      diagnostic: expect.objectContaining({
        code: 'fixed-mars-reference.not-configured',
        role: fixedMarsCourseExecutorRole
      })
    });
  });

  it('reports a missing configured file before any MARS execution', async () => {
    const directory = await temporaryDirectory();
    const missing = path.join(directory, 'missing.jar');
    const result = await verifyConfiguredFixedMarsReference(
      undefined,
      {},
      dependencies(missing, Buffer.from('fixed-reference'))
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe('fixed-mars-reference.file-missing');
  });

  it('rejects a regular file with the wrong byte count without hashing it as trusted', async () => {
    const expected = Buffer.from('fixed-reference');
    const file = await writeFixture('renamed-local.jar', Buffer.from('short'));
    const result = await verifyConfiguredFixedMarsReference(undefined, {}, dependencies(file, expected));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic).toMatchObject({
        code: 'fixed-mars-reference.size-mismatch',
        expected: expected.byteLength,
        actual: 5
      });
    }
  });

  it('rejects same-size bytes with the wrong SHA-256', async () => {
    const expected = Buffer.from('fixed-reference');
    const file = await writeFixture('renamed-local.jar', Buffer.from('wrong-reference'));
    const result = await verifyConfiguredFixedMarsReference(undefined, {}, dependencies(file, expected));

    expect(Buffer.from('wrong-reference')).toHaveLength(expected.byteLength);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe('fixed-mars-reference.sha256-mismatch');
  });

  it('accepts exact fixed bytes under an arbitrary local basename', async () => {
    const expected = Buffer.from('fixed-reference');
    const file = await writeFixture('not-the-release-name.jar', expected);
    const resource = { scheme: 'file', fsPath: path.join(path.dirname(file), 'main.asm') } as vscode.Uri;
    const getMarsJar = vi.fn(() => file);
    const result = await verifyConfiguredFixedMarsReference(
      resource,
      {},
      { ...dependencies(file, expected), getMarsJar }
    );

    expect(result).toMatchObject({
      ok: true,
      path: path.resolve(file),
      bytes: expected.byteLength,
      identity: {
        role: fixedMarsCourseExecutorRole,
        sha256: sha256Bytes(expected),
        fileName: 'canonical-release.jar'
      },
      authority: 'test authority',
      trustRevision: 'test revision'
    });
    expect(getMarsJar).toHaveBeenCalledWith(resource);
  });

  it('does not authorize bytes trusted only for another role', async () => {
    const expected = Buffer.from('fixed-reference');
    const file = await writeFixture('Mars.jar', expected);
    const manifest = trustManifest(expected, 'mars-assembler-v0.6.3');
    const result = await verifyConfiguredFixedMarsReference(undefined, {}, {
      getMarsJar: () => file,
      trustManifest: manifest
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe('fixed-mars-reference.trust-role-missing');
  });

  it('rejects a directory instead of treating it as a configured artifact', async () => {
    const expected = Buffer.from('fixed-reference');
    const directory = await temporaryDirectory();
    const result = await verifyConfiguredFixedMarsReference(undefined, {}, dependencies(directory, expected));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe('fixed-mars-reference.file-not-regular');
  });

  it('honors cancellation before reading the configured file', async () => {
    const expected = Buffer.from('fixed-reference');
    const file = await writeFixture('Mars.jar', expected);
    const inspectFile = vi.fn<FixedMarsReferenceVerifierDependencies['inspectFile']>();
    const controller = new AbortController();
    controller.abort();

    const result = await verifyConfiguredFixedMarsReference(
      undefined,
      { signal: controller.signal },
      { ...dependencies(file, expected), inspectFile }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe('fixed-mars-reference.cancelled');
    expect(inspectFile).not.toHaveBeenCalled();
  });
});

function dependencies(
  configuredPath: string,
  expected: Buffer
): Partial<FixedMarsReferenceVerifierDependencies> {
  return {
    getMarsJar: () => configuredPath,
    trustManifest: trustManifest(expected, fixedMarsCourseExecutorRole)
  };
}

function trustManifest(bytes: Buffer, role: string): Readonly<EngineArtifactTrustManifest> {
  return {
    schemaRevision: 1,
    authority: 'test authority',
    revision: 'test revision',
    artifacts: [{
      role,
      sha256: sha256Bytes(bytes),
      bytes: bytes.byteLength,
      fileName: 'canonical-release.jar'
    }]
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-fixed-mars-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeFixture(fileName: string, bytes: Buffer): Promise<string> {
  const directory = await temporaryDirectory();
  const file = path.join(directory, fileName);
  await fs.promises.writeFile(file, bytes);
  return file;
}
