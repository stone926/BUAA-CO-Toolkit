#!/usr/bin/env node
/**
 * Download pinned MARS reference assets and fail closed on any mismatch.
 *
 * For every asset in reference-manifest.json with status "released":
 *   - if the cache file exists, verify bytes + sha256 (no network needed);
 *   - otherwise download from `url`, then verify name/size/sha256; on any mismatch the
 *     cached file is deleted and the script exits non-zero.
 * Assets with status "pending-release" are skipped with a warning unless --require-all is set.
 *
 * Exit code 0 when every released asset is present and verified; 1 otherwise.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const requireAll = args.has('--require-all');
const forceDownload = args.has('--force');

const manifest = JSON.parse(fs.readFileSync(path.join(here, 'reference-manifest.json'), 'utf8'));
const cacheDir = path.resolve(here, manifest.cacheDir);
fs.mkdirSync(cacheDir, { recursive: true });

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target, bytes);
  return bytes.byteLength;
}

let failed = false;

for (const asset of manifest.assets) {
  const file = path.join(cacheDir, asset.fileName);
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
  let bytes = present ? fs.statSync(file).size : undefined;
  try {
    if (!present || forceDownload) {
      if (present) {
        fs.rmSync(file, { force: true });
      }
      bytes = await download(asset.url, file);
      console.log(`  downloaded ${bytes} bytes from ${asset.url}`);
    } else {
      console.log(`  cached ${bytes} bytes (no download)`);
    }
    if (bytes !== asset.bytes) {
      throw new Error(
        `size mismatch: expected ${asset.bytes} bytes, got ${bytes}. ` +
        'The cached/downloaded file does not match the pinned reference asset.'
      );
    }
    const digest = sha256(file);
    if (digest !== asset.sha256) {
      throw new Error(
        `sha256 mismatch: expected ${asset.sha256}, got ${digest}. ` +
        'The cached/downloaded file does not match the pinned reference asset.'
      );
    }
    console.log(`  verified ${file}`);
  } catch (error) {
    console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Best-effort cleanup of a mismatched cache entry.
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
