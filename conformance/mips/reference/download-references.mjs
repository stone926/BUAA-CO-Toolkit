#!/usr/bin/env node
/**
 * Download pinned MARS reference assets and fail closed on any mismatch.
 *
 * For every asset in reference-manifest.json with status "released":
 *   - if the cache file exists, verify bytes + sha256 (no network needed);
 *   - otherwise download to a temporary file, verify size/sha256, then replace the cache;
 *     on any mismatch the temporary file is deleted and the script exits non-zero.
 * Assets with status "pending-release" are skipped with a warning unless --require-all is set.
 *
 * Exit code 0 when every released asset is present and verified; 1 otherwise.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadReferenceManifest,
  referenceAssetPath,
  verifyReferenceAsset
} from './referenceAssets.mjs';

const knownArgs = new Set(['--require-all', '--force']);
const rawArgs = process.argv.slice(2);
for (const arg of rawArgs) {
  if (!knownArgs.has(arg)) {
    throw new Error(`unknown argument: ${arg}`);
  }
}
const args = new Set(rawArgs);
const requireAll = args.has('--require-all');
const forceDownload = args.has('--force');

const manifest = loadReferenceManifest();
const cacheDir = manifest.cacheDir;
fs.mkdirSync(cacheDir, { recursive: true });

async function download(sourceUrl, target, expectedBytes) {
  const response = await fetch(sourceUrl, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText} for ${sourceUrl}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new Error(`download returned invalid Content-Length ${JSON.stringify(contentLength)} for ${sourceUrl}`);
    }
    if (declaredBytes > expectedBytes) {
      throw new Error(`download exceeds pinned size before reading: expected ${expectedBytes}, declared ${declaredBytes}`);
    }
  }
  if (!response.body) throw new Error(`download returned no response body for ${sourceUrl}`);

  const handle = fs.openSync(target, 'wx');
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('download stream produced a non-byte chunk');
      received += value.byteLength;
      if (received > expectedBytes) {
        await reader.cancel('pinned reference size exceeded');
        throw new Error(`download exceeds pinned size: expected ${expectedBytes}, received at least ${received}`);
      }
      fs.writeSync(handle, value);
    }
  } finally {
    fs.closeSync(handle);
  }
  if (received !== expectedBytes) {
    throw new Error(`download size mismatch: expected ${expectedBytes}, received ${received}`);
  }
  return received;
}

let failed = false;

for (const asset of manifest.assets) {
  const file = referenceAssetPath(manifest, asset);
  console.log(`[${asset.role}]`);
  if (asset.status !== 'released') {
    const message = `  skipped: status=${asset.status}${asset.note ? ` (${asset.note})` : ''}`;
    if (requireAll) {
      console.error(message);
      failed = true;
    } else {
      console.warn(message);
    }
    continue;
  }

  const present = fs.existsSync(file);
  let temporaryFile;
  try {
    if (!present || forceDownload) {
      temporaryFile = path.join(cacheDir, `.${asset.fileName}.${process.pid}.${Date.now()}.tmp`);
      const bytes = await download(asset.url, temporaryFile, asset.bytes);
      console.log(`  downloaded ${bytes} bytes from ${asset.url}`);
      verifyReferenceAsset(manifest, asset, temporaryFile);
      fs.renameSync(temporaryFile, file);
      temporaryFile = undefined;
    } else {
      console.log(`  cached ${fs.statSync(file).size} bytes (no download)`);
    }
    verifyReferenceAsset(manifest, asset, file);
    console.log(`  verified ${file}`);
  } catch (error) {
    console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    try {
      if (temporaryFile) {
        fs.rmSync(temporaryFile, { force: true });
      }
    } catch {
      // Best-effort cleanup of a partial temporary download.
    }
    failed = true;
  }
}

if (failed) {
  console.error('Reference asset verification FAILED. Fix the manifest or re-download, then retry.');
  process.exitCode = 1;
} else {
  console.log('Reference asset verification OK.');
}
