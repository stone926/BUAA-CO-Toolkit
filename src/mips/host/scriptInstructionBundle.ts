// @index mips-host — Immutable source closure and content identity for JavaScript/TypeScript instructions
import { createHash } from 'crypto';
import { canonicalJson, type CanonicalJson } from '../core/canonicalJson';

export const scriptInstructionRuntimeVersion = 'co-script-runtime-v1';
export const scriptInstructionSdkVersion = 'co-instruction-sdk-v1';
export const scriptInstructionSdkModule = '@buaa-co/instructions';
export const scriptInstructionLimits = Object.freeze({ files: 128, bytes: 2 * 1024 * 1024, fileBytes: 256 * 1024 });

export interface ScriptInstructionFile {
  /** POSIX path relative to .co/custom-instructions. */
  readonly path: string;
  readonly source: string;
  readonly javascript: string;
  readonly digest: string;
}
export interface ScriptInstructionBundle {
  readonly version: 1;
  readonly runtimeVersion: typeof scriptInstructionRuntimeVersion;
  readonly sdkVersion: typeof scriptInstructionSdkVersion;
  readonly nodeVersion: string;
  readonly digest: string;
  readonly entries: readonly string[];
  readonly files: readonly ScriptInstructionFile[];
}
export function scriptInstructionHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function scriptInstructionBundleDigest(bundle: Omit<ScriptInstructionBundle, 'digest'>): string {
  return scriptInstructionHash(canonicalJson(bundle as unknown as CanonicalJson));
}
export function freezeScriptInstructionBundle(bundle: ScriptInstructionBundle): ScriptInstructionBundle {
  bundle.files.forEach(Object.freeze);
  Object.freeze(bundle.files);
  Object.freeze(bundle.entries);
  return Object.freeze(bundle);
}
/** Recheck snapshots arriving from manifests or a worker message before running any source. */
export function validateScriptInstructionBundle(value: unknown): ScriptInstructionBundle {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'digest,entries,files,nodeVersion,runtimeVersion,sdkVersion,version'
    || value.version !== 1 || value.runtimeVersion !== scriptInstructionRuntimeVersion || value.sdkVersion !== scriptInstructionSdkVersion
    || typeof value.nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.nodeVersion)
    || !Array.isArray(value.files) || !value.files.length || value.files.length > scriptInstructionLimits.files
    || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > scriptInstructionLimits.files
    || new Set(value.entries).size !== value.entries.length) {
    throw new Error('Invalid custom instruction snapshot or unsupported runtime/SDK version');
  }
  const paths = new Set<string>();
  const exactPaths = new Set<string>();
  let bytes = 0;
  for (const file of value.files) {
    if (!record(file) || Object.keys(file).sort().join(',') !== 'digest,javascript,path,source'
      || typeof file.path !== 'string' || !safePath(file.path) || paths.has(file.path.toLowerCase())
      || typeof file.source !== 'string' || typeof file.javascript !== 'string'
      || Buffer.byteLength(file.source) > scriptInstructionLimits.fileBytes
      || Buffer.byteLength(file.javascript) > scriptInstructionLimits.fileBytes * 2
      || (bytes += Buffer.byteLength(file.source) + Buffer.byteLength(file.javascript)) > scriptInstructionLimits.bytes * 3
      || file.digest !== scriptInstructionHash(JSON.stringify([file.source, file.javascript]))) {
      throw new Error('Invalid custom instruction source snapshot');
    }
    paths.add(file.path.toLowerCase());
    exactPaths.add(file.path);
  }
  if (!value.entries.every(entry => typeof entry === 'string' && exactPaths.has(entry))) throw new Error('Custom instruction entry is missing from snapshot');
  const bundle = value as unknown as ScriptInstructionBundle;
  const { digest, ...content } = bundle;
  if (digest !== scriptInstructionBundleDigest(content)) throw new Error('Custom instruction snapshot digest does not match its sources');
  return freezeScriptInstructionBundle(bundle);
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function safePath(value: string): boolean {
  return value.length <= 512 && !value.includes('\\') && !value.includes(':') && !value.startsWith('/')
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..') && /\.(?:js|ts)$/.test(value) && !value.endsWith('.d.ts');
}
