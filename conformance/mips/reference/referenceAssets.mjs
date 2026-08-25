import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const referenceRoot = path.dirname(fileURLToPath(import.meta.url));
const conformanceRoot = path.resolve(referenceRoot, '..', '..');

export const referenceManifestPath = path.join(referenceRoot, 'reference-manifest.json');
export const referenceRoles = Object.freeze({
  stockAssembler: 'mars-assembler-v0.6.3',
  frozenRegression: 'mars-regression-v0.6.3',
  legacyCourseExecutor: 'legacy-course-executor'
});

const requiredRoles = new Set(Object.values(referenceRoles));
const sha256Pattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(`reference-manifest.json: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

export function loadReferenceManifest(manifestFile = referenceManifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read reference manifest ${manifestFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(manifest) || manifest.schemaRevision !== 1 || typeof manifest.cacheDir !== 'string') {
    fail('schemaRevision must be 1 and cacheDir must be a string');
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    fail('assets must be a non-empty array');
  }

  const manifestRoot = path.dirname(path.resolve(manifestFile));
  const cacheDir = path.resolve(manifestRoot, manifest.cacheDir);
  const expectedCacheDir = path.join(conformanceRoot, '.cache');
  if (cacheDir !== expectedCacheDir || !isWithin(conformanceRoot, cacheDir)) {
    fail(`cacheDir must resolve exactly to ${expectedCacheDir}`);
  }
  if (fs.existsSync(cacheDir)) {
    const cacheStat = fs.lstatSync(cacheDir);
    if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory()) {
      fail('cacheDir must be a real directory, not a symlink');
    }
    if (!isWithin(fs.realpathSync(conformanceRoot), fs.realpathSync(cacheDir))) {
      fail('cacheDir realpath escapes the conformance root');
    }
  }

  const seenRoles = new Set();
  const seenFiles = new Set();
  const assets = manifest.assets.map((asset, index) => {
    if (!isPlainObject(asset)) {
      fail(`assets[${index}] must be an object`);
    }
    const prefix = `assets[${index}]`;
    if (typeof asset.role !== 'string' || !requiredRoles.has(asset.role) || seenRoles.has(asset.role)) {
      fail(`${prefix}.role must be one unique required role`);
    }
    seenRoles.add(asset.role);
    if (
      typeof asset.fileName !== 'string' ||
      asset.fileName.length === 0 ||
      asset.fileName !== path.basename(asset.fileName) ||
      asset.fileName.includes('/') ||
      asset.fileName.includes('\\') ||
      seenFiles.has(asset.fileName)
    ) {
      fail(`${prefix}.fileName must be a unique basename`);
    }
    seenFiles.add(asset.fileName);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
      fail(`${prefix}.bytes must be a positive safe integer`);
    }
    if (typeof asset.sha256 !== 'string' || !sha256Pattern.test(asset.sha256)) {
      fail(`${prefix}.sha256 must be a lowercase SHA-256 digest`);
    }
    if (asset.status !== 'released' && asset.status !== 'pending-release') {
      fail(`${prefix}.status must be released or pending-release`);
    }
    if (typeof asset.sourceTag !== 'string' || asset.sourceTag.length === 0) {
      fail(`${prefix}.sourceTag must be a non-empty string`);
    }
    if (typeof asset.sourceCommit !== 'string' || !commitPattern.test(asset.sourceCommit)) {
      fail(`${prefix}.sourceCommit must be a lowercase 40-character commit id`);
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(asset.url);
    } catch {
      fail(`${prefix}.url must be a valid URL`);
    }
    if (parsedUrl.protocol !== 'https:' || decodeURIComponent(path.posix.basename(parsedUrl.pathname)) !== asset.fileName) {
      fail(`${prefix}.url must be HTTPS and end with fileName`);
    }
    return Object.freeze({ ...asset });
  });

  for (const role of requiredRoles) {
    if (!seenRoles.has(role)) {
      fail(`missing required role ${role}`);
    }
  }
  return Object.freeze({ ...manifest, cacheDir, assets: Object.freeze(assets) });
}

export function referenceAssetPath(manifest, asset) {
  const file = path.resolve(manifest.cacheDir, asset.fileName);
  if (!isWithin(manifest.cacheDir, file) || path.dirname(file) !== manifest.cacheDir) {
    throw new Error(`reference asset path escapes cache: ${asset.fileName}`);
  }
  return file;
}

export function verifyReferenceAsset(manifest, asset, file = referenceAssetPath(manifest, asset)) {
  let stat;
  try {
    const linkStat = fs.lstatSync(file);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      throw new Error('asset must be a regular non-symlink file');
    }
    stat = linkStat;
  } catch (error) {
    throw new Error(`[${asset.role}] reference asset unavailable at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.size !== asset.bytes) {
    throw new Error(`[${asset.role}] size mismatch: expected ${asset.bytes}, got ${stat.size}`);
  }
  const digest = sha256File(file);
  if (digest !== asset.sha256) {
    throw new Error(`[${asset.role}] sha256 mismatch: expected ${asset.sha256}, got ${digest}`);
  }
  return Object.freeze({ ...asset, file, verifiedSha256: digest });
}

/** Resolve a reference by manifest role and re-check bytes/SHA-256 on every call. */
export function resolveVerifiedReference(role) {
  const manifest = loadReferenceManifest();
  const asset = manifest.assets.find((entry) => entry.role === role);
  if (!asset) {
    throw new Error(`required reference role is not declared: ${role}`);
  }
  if (asset.status !== 'released') {
    throw new Error(`required reference role is not released: ${role} (status=${asset.status})`);
  }
  return verifyReferenceAsset(manifest, asset);
}
