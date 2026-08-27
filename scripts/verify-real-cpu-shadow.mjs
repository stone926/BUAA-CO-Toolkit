#!/usr/bin/env node
/**
 * Optional phase-4 real-CPU shadow evidence.
 *
 * Scans archived .co/cases under caller-provided real CPU repositories, rebuilds
 * the legacy ProgramImage from the archived HexText, runs the compiled builtin TS
 * executor, and compares its projected architectural writes with the archived
 * legacy MARS trace. Java/MARS and ISim are not required: both sides come from
 * immutable case artifacts plus the in-process TS core.
 *
 * Usage:
 *   node scripts/verify-real-cpu-shadow.mjs <repo-or-case-dir> [...]
 *   CO_REAL_SHADOW_OUTPUT=/path/to/result.json node ...
 *
 * Exit code 0 when every executed case is matched or not-comparable with a
 * stable core diagnostic; 1 on unclassified trace differences or corrupt input.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { executeProgramForService } = require(path.join(root, 'out/mips/core/machine/executeService.js'));
const { createLegacyProgramImage } = require(path.join(root, 'out/mips/replay/programImage.js'));
const { iterMarsDetailedTraceEvents, iterCpuTraceEvents } = require(path.join(root, 'out/language/mips/traceParser.js'));
const { compareTraceIterables } = require(path.join(root, 'out/language/mips/traceCompare.js'));

const maximumSteps = 262144;

const args = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (process.env.CO_REAL_CPU_ROOTS ?? '').split(path.delimiter).filter(Boolean);
if (!args.length) {
  console.error('usage: verify-real-cpu-shadow.mjs <repo-or-case-dir> [...]');
  process.exit(2);
}

const summary = {
  schemaRevision: 1,
  kind: 'phase4-real-cpu-shadow',
  generatedAt: new Date().toISOString(),
  roots: args.map((item) => path.resolve(item)),
  cases: 0,
  matched: 0,
  notComparable: 0,
  inconclusive: 0,
  corrupt: 0,
  results: []
};

const roots = new Set(args.map((item) => path.resolve(item)));
for (const rootDir of roots) {
  for (const manifestFile of discoverManifests(rootDir)) {
    const caseDir = path.dirname(manifestFile);
    const result = await evaluateCase(caseDir);
    summary.cases++;
    summary[result.status] = (summary[result.status] ?? 0) + 1;
    summary.results.push(result);
    console.log(`${result.status.padEnd(14)} ${path.relative(path.dirname(rootDir), caseDir)} ${result.message}`);
  }
}

const output = process.env.CO_REAL_SHADOW_OUTPUT;
if (output) {
  const absolute = path.resolve(output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`);
  fs.renameSync(temporary, absolute);
  console.log(`evidence: ${absolute}`);
}
console.log(JSON.stringify({
  cases: summary.cases,
  matched: summary.matched,
  notComparable: summary.notComparable,
  inconclusive: summary.inconclusive,
  corrupt: summary.corrupt
}));
process.exitCode = summary.inconclusive || summary.corrupt ? 1 : 0;

async function evaluateCase(caseDir) {
  const manifestFile = path.join(caseDir, 'case.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return { status: 'corrupt', caseDir, message: `manifest: ${error.message}` };
  }
  if (manifest.version !== 1 && manifest.version !== 2) {
    return { status: 'corrupt', caseDir, message: `unsupported manifest version ${manifest.version}` };
  }
  const machineCode = manifest.version === 2 ? manifest.program?.machineCode : manifest.machineCode;
  const legacyTracePath = findLegacyTrace(caseDir, manifest);
  if (!machineCode || !legacyTracePath) {
    return { status: 'notComparable', caseDir, message: 'no archived machine-code/MARS trace' };
  }
  const codeFile = localArchiveFile(caseDir, machineCode.path ?? 'code.txt', 'code.txt');
  const legacyRaw = readBoundedText(legacyTracePath, 4 * 1024 * 1024, 'legacy trace');
  let words;
  try {
    const code = readBoundedText(codeFile, 2 * 1024 * 1024, 'machine code');
    words = code.trim().split(/\r?\n/).filter(Boolean).map((line) => Number.parseInt(line, 16));
    if (words.some((word) => !Number.isFinite(word))) throw new Error('malformed HexText');
  } catch (error) {
    return { status: 'corrupt', caseDir, message: `machine code: ${error.message}` };
  }
  if (!words.length) {
    return { status: 'notComparable', caseDir, message: 'empty archived machine code' };
  }
  const image = createLegacyProgramImage(
    `${words.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('\n')}\n`,
    [{
      id: manifest.caseId ?? path.basename(caseDir),
      ...(manifest.originalAsmPath ? { uri: manifest.originalAsmPath } : {}),
      contentHash: manifest.asmSnapshot?.sha256 ?? crypto.createHash('sha256').update('empty').digest('hex')
    }]
  );
  const schedule = (manifest.p7?.interruptSchedule ?? []).map((value) => Number(value)).filter(Number.isFinite);
  const builtin = executeProgramForService({
    profile: manifest.profile ?? 'P7',
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    segments: image.segments.map((segment) => ({
      name: segment.name,
      baseAddress: segment.baseAddress,
      words: segment.words
    })),
    entryPc: image.entryPc,
    maxSteps: maximumSteps,
    ...(schedule.length ? { externalInterrupts: schedule.map((pc) => ({ victimPc: pc >>> 0, occurrence: 1 })) } : {}),
    collectTrace: true,
    collectCoverage: true
  });
  if (builtin.status !== 'halted') {
    return {
      status: 'notComparable',
      caseDir,
      message: `${builtin.status}${builtin.diagnostic ? `: ${builtin.diagnostic.code}` : ''}`,
      diagnostic: builtin.diagnostic
    };
  }
  const legacy = parseLegacyTrace(legacyRaw);
  const builtinRaw = (builtin.trace ?? []).join('\n');
  const builtinTrace = [...iterCpuTraceEvents(builtinRaw)];
  const diff = compareTraceIterables(legacy, builtinTrace, {
    compareCycles: false,
    retainedEntryLimit: 1
  });
  if (diff.matched) {
    return {
      status: 'matched',
      caseDir,
      message: `${legacy.length} trace events, ${builtin.instructions} instructions`,
      legacyEvents: legacy.length,
      builtinEvents: builtinTrace.length,
      instructions: builtin.instructions,
      finalStateDigest: builtin.finalStateDigest
    };
  }
  return {
    status: 'inconclusive',
    caseDir,
    message: `first diff @${diff.firstDiffIndex}: ${JSON.stringify(diff.firstDiffEntry ?? null)}`,
    legacyEvents: legacy.length,
    builtinEvents: builtinTrace.length,
    instructions: builtin.instructions,
    firstDiff: diff.firstDiffEntry ?? null
  };
}

function discoverManifests(rootDir) {
  const stat = fs.statSync(rootDir, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile() && path.basename(rootDir) === 'case.json') return [rootDir];
  const caseRoot = path.join(rootDir, '.co', 'cases');
  const result = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name === 'case.json') result.push(full);
    }
  };
  visit(caseRoot);
  return result;
}

function findLegacyTrace(caseDir, manifest) {
  if (manifest.version === 2) {
    const ref = manifest.artifacts?.oracle?.traceOut;
    if (ref) {
      const relative = typeof ref === 'string' ? ref : ref.path;
      return path.resolve(caseDir, ...relative.replace(/\\/g, '/').split('/'));
    }
  }
  const candidates = [
    path.join(caseDir, 'mars', 'program.mars.out'),
    path.join(caseDir, 'program.mars.out')
  ];
  return candidates.find((file) => fs.existsSync(file));
}

function localArchiveFile(caseDir, archivePath, fallbackName) {
  if (typeof archivePath === 'string' && path.isAbsolute(archivePath)) {
    return archivePath;
  }
  const direct = path.resolve(caseDir, ...String(archivePath ?? fallbackName).replace(/\\/g, '/').split('/'));
  if (fs.existsSync(direct)) return direct;
  return path.join(caseDir, fallbackName);
}

function parseLegacyTrace(text) {
  return /^@PC(?:0x)?[0-9a-f]{1,8}\s*->/gim.test(text)
    ? [...iterMarsDetailedTraceEvents(text, 64)]
    : [...iterCpuTraceEvents(text)];
}

function readBoundedText(file, maximumBytes, label) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maximumBytes) throw new Error(`${label} missing or exceeds ${maximumBytes} bytes`);
  return fs.readFileSync(file, 'utf8');
}
