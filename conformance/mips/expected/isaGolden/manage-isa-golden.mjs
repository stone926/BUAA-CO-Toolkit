#!/usr/bin/env node
/** Sole review/integrity writer for the independent course ISA golden. */
import * as fs from '../guardedFs.mjs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isaGoldenFile,
  isaGoldenPayloadSha256,
  loadIsaGolden,
  validateIsaGolden
} from '../../runner/isaGoldenArtifact.mjs';

function usage(message) {
  throw new Error(`${message}\nUsage: manage-isa-golden.mjs --verify | --refresh-integrity`);
}

export function parseArgs(argv) {
  const result = { action: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['--verify', '--refresh-integrity'].includes(arg)) {
      if (result.action) usage('select exactly one action');
      result.action = arg.slice(2);
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  if (!result.action) usage('an action is required');
  return result;
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function refreshIsaGolden(golden) {
  const nextDigest = isaGoldenPayloadSha256(golden);
  const evidenceChanged = golden.integrity?.payloadSha256 !== nextDigest;
  const result = structuredClone(golden);
  if (result.review.status !== 'candidate') {
    result.review = {
      ...result.review,
      status: 'candidate',
      reviewer: null,
      reviewedAt: null,
      reviewRevision: 0
    };
  }
  validateIsaGolden(result, { skipIntegrity: true });
  result.integrity = { algorithm: 'sha256-canonical-json-v1', payloadSha256: nextDigest };
  validateIsaGolden(result);
  return { golden: result, evidenceChanged };
}

export function run(argv) {
  const options = parseArgs(argv);
  if (options.action === 'verify') {
    loadIsaGolden();
  } else if (options.action === 'refresh-integrity') {
    const current = JSON.parse(fs.readFileSync(isaGoldenFile, 'utf8'));
    const refreshed = refreshIsaGolden(current);
    writeAtomic(isaGoldenFile, refreshed.golden);
  }
  const checked = loadIsaGolden();
  process.stdout.write(`ISA golden verification OK: ${checked.cases.length} instructions\n`);
  return 0;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
