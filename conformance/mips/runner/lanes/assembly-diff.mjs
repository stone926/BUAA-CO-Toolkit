/**
 * assembly-diff lane: same SourceUnit graph -> MARS image vs TS image, segment
 * by segment (text, P7 ktext, data). The TS assembler runs through the versioned
 * JSONL process boundary; MARS is the pinned `mars-assembler-v0.6.3` reference.
 *
 * Without a compiled TS CLI the lane is `skipped`; without a downloaded pinned
 * MARS asset it is also `skipped` so a normal source checkout can run the other
 * lanes. On CI both prerequisites exist and `skipped` fails the runner gate.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveVerifiedReference, referenceRoles } from '../../reference/referenceAssets.mjs';
import { corpusCaseFile } from '../caseManifest.mjs';

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const conformanceRoot = path.resolve(runnerRoot, '..', '..');
const extensionRoot = path.resolve(conformanceRoot, '..', '..');
const defaultCli = process.env.BUAA_CO_MIPS_ENGINE_CLI
  ?? path.join(extensionRoot, 'out', 'mips', 'cli', 'main.js');
const supportedProfiles = new Set(['P3', 'P4', 'P5', 'P6', 'P7']);

function skipped(caseId, message) {
  return { caseId, lane: 'assembly-diff', status: 'skipped', message };
}

function failed(caseId, message) {
  return { caseId, lane: 'assembly-diff', status: 'failed', message };
}

export function runAssemblyDiffCase(manifestCase, options = {}) {
  const cli = path.resolve(options.cli ?? defaultCli);
  if (!fs.existsSync(cli) || !fs.statSync(cli).isFile()) {
    return skipped(manifestCase.caseId, `compiled TS CLI is missing: ${cli}`);
  }
  if (!supportedProfiles.has(manifestCase.profile)) {
    return failed(manifestCase.caseId, `unsupported profile ${manifestCase.profile}`);
  }

  let referenceJar = options.referenceJar;
  if (!referenceJar) {
    try {
      referenceJar = resolveVerifiedReference(referenceRoles.stockAssembler).file;
    } catch (error) {
      return skipped(manifestCase.caseId, error instanceof Error ? error.message : String(error));
    }
  }

  const source = corpusCaseFile(manifestCase);
  const tsImage = assembleWithTsCli(cli, manifestCase, source);
  if (tsImage.error) {
    return failed(manifestCase.caseId, tsImage.error);
  }
  const marsImages = assembleWithMarsReference(referenceJar, manifestCase, source);
  if (marsImages.skipped) {
    return skipped(manifestCase.caseId, marsImages.skipped);
  }
  if (marsImages.error) {
    return failed(manifestCase.caseId, marsImages.error);
  }

  const differences = [];
  compareSegment(differences, 'text', tsImage.image, marsImages.text);
  if (manifestCase.profile === 'P7') {
    compareSegment(differences, 'ktext', tsImage.image, marsImages.ktext);
  }
  compareSegment(differences, 'data', tsImage.image, marsImages.data);

  if (differences.length) {
    return failed(manifestCase.caseId, differences.join('; '));
  }
  return {
    caseId: manifestCase.caseId,
    lane: 'assembly-diff',
    status: 'passed',
    message: [
      `text ${marsImages.text.length} word(s)`,
      `data ${marsImages.data.length} word(s)`,
      `ktext ${marsImages.ktext.length} word(s)`
    ].join(', ')
  };
}

function assembleWithTsCli(cli, manifestCase, sourceFile) {
  const sourceText = fs.readFileSync(sourceFile, 'utf8');
  const request = {
    protocolVersion: 1,
    requestId: `assembly-diff:${manifestCase.caseId}`,
    operation: 'assembler.assemble',
    profile: manifestCase.profile,
    sources: [{
      id: 'source-0000',
      uri: `file://${sourceFile.replace(/\\/g, '/')}`,
      text: sourceText
    }]
  };
  const run = spawnSync(process.execPath, [cli], {
    cwd: extensionRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    input: `${JSON.stringify(request)}\n`
  });
  if (run.error) return { error: `TS CLI spawn failed: ${run.error.message}` };
  if (run.status !== 0) return { error: `TS CLI exited ${run.status}: ${run.stderr}` };
  let response;
  try {
    response = JSON.parse(run.stdout.trim().split(/\r?\n/).filter(Boolean).pop());
  } catch (error) {
    return { error: `TS CLI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response?.ok || !response.result?.ok || !response.result?.image) {
    return {
      error: `TS assembler rejected ${manifestCase.caseId}: ${
        response?.error?.message
        ?? (response?.result?.diagnostics ?? []).map((diagnostic) => `[${diagnostic.code}] ${diagnostic.message}`).join('; ')
        ?? 'unknown error'
      }`
    };
  }
  return { image: response.result.image };
}

function assembleWithMarsReference(referenceJar, manifestCase, sourceFile) {
  const profile = manifestCase.profile;
  const memoryConfiguration = profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText';
  const javaExecutable = process.env.CONFORMANCE_JAVA || 'java';
  const args = ['-jar', referenceJar, 'a', 'nc', 'mc', memoryConfiguration];
  if (['P5', 'P6', 'P7'].includes(profile)) args.push('db');
  const textFile = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'co-asm-diff-')), 'text.txt');
  const dataFile = path.join(path.dirname(textFile), 'data.txt');
  const ktextFile = path.join(path.dirname(textFile), 'ktext.txt');
  args.push('dump', '.text', 'HexText', textFile);
  args.push('dump', '.data', 'HexText', dataFile);
  if (profile === 'P7') args.push('dump', '0x00004180-0x00004ffc', 'HexText', ktextFile);
  args.push(sourceFile);

  const run = spawnSync(javaExecutable, args, {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true
  });
  if (run.error) {
    cleanupAssemblyDiffDirectory(path.dirname(textFile));
    if (run.error.code === 'ENOENT') {
      return { skipped: `pinned MARS Java runtime is unavailable: ${javaExecutable}` };
    }
    return { error: `pinned MARS spawn failed: ${run.error.message}` };
  }
  if (run.status !== 0) {
    cleanupAssemblyDiffDirectory(path.dirname(textFile));
    return { error: `pinned MARS exited ${run.status}: ${(run.stdout ?? '')} ${(run.stderr ?? '')}` };
  }
  const images = {
    text: readHexWords(textFile),
    data: readHexWords(dataFile),
    ktext: readHexWords(ktextFile)
  };
  cleanupAssemblyDiffDirectory(path.dirname(textFile));
  return images;
}

function compareSegment(differences, name, tsImage, marsWords) {
  const tsWords = (tsImage.segments ?? []).find((segment) => segment.name === name)?.words ?? [];
  if (tsWords.length !== marsWords.length) {
    differences.push(
      `${name} word count differs: TS ${tsWords.length}, MARS ${marsWords.length}`
    );
    return;
  }
  for (let index = 0; index < marsWords.length; index++) {
    const actual = Number(tsWords[index]) >>> 0;
    const expected = Number.parseInt(marsWords[index], 16) >>> 0;
    if (actual !== expected) {
      differences.push(
        `${name}[${index}] differs: TS 0x${actual.toString(16).padStart(8, '0')}, `
        + `MARS 0x${expected.toString(16).padStart(8, '0')}`
      );
      if (differences.length >= 5) return;
    }
  }
}

function cleanupAssemblyDiffDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function readHexWords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((line) => line.replace(/^0x/i, '').padStart(8, '0'));
}
