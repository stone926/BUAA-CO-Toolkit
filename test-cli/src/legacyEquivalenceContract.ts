import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const LEGACY_EQUIVALENCE_SCHEMA_VERSION = 2 as const;
export const LEGACY_EQUIVALENCE_PROFILES = ['P3', 'P5', 'P7'] as const;
export const LEGACY_EQUIVALENCE_SCENARIOS = ['success', 'assembly-failure'] as const;

export type LegacyEquivalenceProfile = typeof LEGACY_EQUIVALENCE_PROFILES[number];
export type LegacyEquivalenceScenario = typeof LEGACY_EQUIVALENCE_SCENARIOS[number];
export type LegacyEquivalenceVerdict = 'passed' | 'failed';

export interface LegacyReferenceInput {
  role: string;
  fileName: string;
  jar: string;
  sha256: string;
}

export interface LegacyEquivalenceInput {
  schemaVersion: typeof LEGACY_EQUIVALENCE_SCHEMA_VERSION;
  java: string;
  references: LegacyReferenceInput[];
}

export interface LegacyEquivalenceArtifact {
  relativePath: string;
  present: boolean;
  bytes: number;
  sha256: string | null;
}

export interface LegacyEquivalenceLaneResult {
  caseId: string;
  role: string;
  referenceSha256: string;
  profile: LegacyEquivalenceProfile;
  scenario: LegacyEquivalenceScenario;
  expectedVerdict: LegacyEquivalenceVerdict;
  verdict: LegacyEquivalenceVerdict;
  haltPc: string | null;
  machineCode: LegacyEquivalenceArtifact;
  trace: LegacyEquivalenceArtifact;
  assembleExitCode: number | null;
  executeExitCode: number | null;
  engineSha256: string | null;
}

export interface LegacyEquivalenceLaneManifest {
  schemaVersion: typeof LEGACY_EQUIVALENCE_SCHEMA_VERSION;
  implementation: 'baseline-direct-runMarsFile' | 'current-legacy-provider';
  cases: LegacyEquivalenceLaneResult[];
}

export function equivalenceCaseId(
  role: string,
  profile: LegacyEquivalenceProfile,
  scenario: LegacyEquivalenceScenario
): string {
  const safeRole = role.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `${safeRole}--${profile.toLowerCase()}--${scenario}`;
}

export function sourceForEquivalenceCase(
  profile: LegacyEquivalenceProfile,
  scenario: LegacyEquivalenceScenario
): string {
  if (scenario === 'assembly-failure') {
    return [
      '.text',
      'ori $1, $0, 1',
      'co_intentionally_invalid_instruction $2, $1, $1',
      '_co_test_end:',
      'beq $0, $0, _co_test_end',
      'nop',
      ''
    ].join('\n');
  }

  const delayedBody = profile === 'P3'
    ? [
        'beq $3, $3, taken',
        'ori $4, $0, 0xdead',
        'taken:',
        'ori $5, $0, 5'
      ]
    : [
        'beq $3, $3, taken',
        'ori $4, $0, 0x1234',
        'taken:',
        'jal subroutine',
        'ori $5, $0, 5',
        'beq $0, $0, after_subroutine',
        'nop',
        'subroutine:',
        'add $6, $4, $5',
        'jr $31',
        'nop',
        'after_subroutine:'
      ];
  const kernel = profile === 'P7'
    ? [
        '',
        '.ktext 0x4180',
        'mfc0 $26, $14',
        'ori $26, $26, 4',
        'mtc0 $26, $14',
        'eret',
        'nop'
      ]
    : [];
  return [
    '.text',
    'ori $1, $0, 1',
    'ori $2, $0, 2',
    'add $3, $1, $2',
    'sw $3, 0($0)',
    'lw $7, 0($0)',
    ...delayedBody,
    '_co_test_end:',
    'beq $0, $0, _co_test_end',
    'nop',
    ...kernel,
    ''
  ].join('\n');
}

export function expectedVerdictForScenario(scenario: LegacyEquivalenceScenario): LegacyEquivalenceVerdict {
  return scenario === 'success' ? 'passed' : 'failed';
}

export async function describeArtifact(root: string, file: string): Promise<LegacyEquivalenceArtifact> {
  const relativePath = slashPath(path.relative(root, file));
  if (!isWithin(root, file)) {
    throw new Error(`artifact path escapes lane root: ${file}`);
  }
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`artifact is not a regular non-symlink file: ${file}`);
    }
    const bytes = await fs.promises.readFile(file);
    return {
      relativePath,
      present: true,
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return {
      relativePath,
      present: false,
      bytes: 0,
      sha256: null
    };
  }
}

export function parseLaneArguments(argv: string[]): { input: string; artifacts: string; manifest: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid lane argument near ${key ?? '<end>'}`);
    }
    if (values.has(key)) {
      throw new Error(`duplicate lane argument: ${key}`);
    }
    values.set(key, value);
  }
  const allowed = new Set(['--input', '--artifacts', '--manifest']);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`unknown lane argument: ${key}`);
    }
  }
  const input = requiredAbsolutePath(values, '--input');
  const artifacts = requiredAbsolutePath(values, '--artifacts');
  const manifest = requiredAbsolutePath(values, '--manifest');
  return { input, artifacts, manifest };
}

export async function readLaneInput(file: string): Promise<LegacyEquivalenceInput> {
  const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Partial<LegacyEquivalenceInput>;
  if (parsed.schemaVersion !== LEGACY_EQUIVALENCE_SCHEMA_VERSION || typeof parsed.java !== 'string' || parsed.java.length === 0) {
    throw new Error('legacy equivalence input has an unsupported schema or missing Java command');
  }
  if (!Array.isArray(parsed.references) || parsed.references.length !== 2) {
    throw new Error('legacy equivalence input must contain exactly two references');
  }
  const roles = new Set<string>();
  for (const reference of parsed.references) {
    if (
      typeof reference?.role !== 'string' ||
      typeof reference.fileName !== 'string' ||
      typeof reference.jar !== 'string' ||
      !path.isAbsolute(reference.jar) ||
      typeof reference.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(reference.sha256) ||
      roles.has(reference.role)
    ) {
      throw new Error('legacy equivalence input contains an invalid or duplicate reference');
    }
    roles.add(reference.role);
    const bytes = await fs.promises.readFile(reference.jar);
    if (path.basename(reference.jar) !== reference.fileName || sha256(bytes) !== reference.sha256) {
      throw new Error(`reference identity mismatch: ${reference.role}`);
    }
  }
  return parsed as LegacyEquivalenceInput;
}

export async function writeLaneManifest(file: string, manifest: LegacyEquivalenceLaneManifest): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function formatHaltPc(value: number | undefined): string | null {
  return value === undefined ? null : `0x${value.toString(16).padStart(8, '0')}`;
}

export function sha256(bytes: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function requiredAbsolutePath(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path`);
  }
  return path.resolve(value);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function slashPath(value: string): string {
  return value.split(String.fromCharCode(92)).join('/');
}
