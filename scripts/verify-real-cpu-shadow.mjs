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
import {
  classifyBuiltinExecution,
  discoverCaseManifests,
  manifestExecutionExpectations,
  parseStrictArchivedHexText,
  realCpuShadowExitCode,
  resolveArchivedCaseFile,
  resolveLegacyTraceFile
} from './verify-real-cpu-shadow-core.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { executeProgramForService } = require(path.join(root, 'out/mips/core/machine/executeService.js'));
const { createLegacyProgramImage } = require(path.join(root, 'out/mips/replay/programImage.js'));
const { iterMarsDetailedTraceEvents, iterCpuTraceEvents } = require(path.join(root, 'out/language/mips/traceParser.js'));
const { compareTraceIterables } = require(path.join(root, 'out/language/mips/traceCompare.js'));
const { isKnownManifest, v2ReplayBundleIssues } = require(path.join(root, 'out/courseTesting/manifestCodec.js'));

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
  for (const manifestFile of discoverCaseManifests(rootDir)) {
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
if (summary.cases === 0) {
  console.error('phase-4 real-CPU shadow selected zero archived cases');
}
process.exitCode = realCpuShadowExitCode(summary);

async function evaluateCase(caseDir) {
  const manifestFile = path.join(caseDir, 'case.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return { status: 'corrupt', caseDir, message: `manifest: ${error.message}` };
  }
  if (!isKnownManifest(manifest)) {
    return { status: 'corrupt', caseDir, message: 'manifest structure/version is unknown' };
  }
  if (manifest.version === 2) {
    const closureIssues = await v2ReplayBundleIssues(manifest, caseDir);
    if (closureIssues.length) {
      return { status: 'corrupt', caseDir, message: `v2 bundle: ${closureIssues.join('; ')}` };
    }
  }
  const machineCode = manifest.version === 2 ? manifest.program?.machineCode : manifest.machineCode;
  const legacyTracePath = resolveLegacyTraceFile(caseDir, manifest);
  if (!machineCode || !legacyTracePath) {
    return { status: 'inconclusive', caseDir, message: 'no archived machine-code/MARS trace' };
  }
  const expected = manifestExecutionExpectations(manifest);
  if (expected.issues.length) {
    return { status: 'corrupt', caseDir, message: expected.issues.join('; ') };
  }
  if (expected.haltPc === undefined) {
    return { status: 'inconclusive', caseDir, message: 'archived machine code has no validated haltPc' };
  }
  const codeFile = resolveArchivedCaseFile(caseDir, machineCode.path ?? 'code.txt', 'code.txt');
  let legacyRaw;
  try {
    legacyRaw = readBoundedText(legacyTracePath, 4 * 1024 * 1024, 'legacy trace');
  } catch (error) {
    return { status: 'corrupt', caseDir, message: `legacy trace: ${error.message}` };
  }
  let words;
  try {
    const codeBytes = readBoundedBytes(codeFile, 2 * 1024 * 1024, 'machine code');
    if (codeBytes.byteLength !== machineCode.bytes
      || crypto.createHash('sha256').update(codeBytes).digest('hex') !== machineCode.sha256.toLowerCase()) {
      throw new Error('bytes/hash differ from the manifest snapshot');
    }
    const code = codeBytes.toString('utf8');
    if (!Buffer.from(code, 'utf8').equals(codeBytes)) throw new Error('HexText is not lossless UTF-8');
    words = parseStrictArchivedHexText(code);
  } catch (error) {
    return { status: 'corrupt', caseDir, message: `machine code: ${error.message}` };
  }
  if (!words.length) {
    return { status: 'inconclusive', caseDir, message: 'empty archived machine code' };
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
  let builtin;
  try {
    builtin = executeProgramForService({
      profile: manifest.profile ?? 'P7',
      enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
      segments: image.segments.map((segment) => ({
        name: segment.name,
        baseAddress: segment.baseAddress,
        words: segment.words
      })),
      entryPc: image.entryPc,
      maxSteps: maximumSteps,
      haltPc: expected.haltPc,
      ...(schedule.length ? { externalInterrupts: schedule.map((pc) => ({ victimPc: pc >>> 0, occurrence: 1 })) } : {}),
      collectTrace: true,
      collectCoverage: true
    });
  } catch (error) {
    return {
      status: 'inconclusive',
      caseDir,
      message: `builtin execution threw: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const classification = classifyBuiltinExecution(builtin, expected);
  if (classification.status !== 'comparable') {
    return {
      status: classification.status,
      caseDir,
      message: classification.message,
      ...(builtin.diagnostic ? { diagnostic: builtin.diagnostic } : {})
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
      message: `${legacy.length} trace events, ${builtin.instructions} instructions, halt ${builtin.haltPc}`,
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

function parseLegacyTrace(text) {
  return /^@PC(?:0x)?[0-9a-f]{1,8}\s*->/gim.test(text)
    ? [...iterMarsDetailedTraceEvents(text, 64)]
    : [...iterCpuTraceEvents(text)];
}

function readBoundedText(file, maximumBytes, label) {
  return readBoundedBytes(file, maximumBytes, label).toString('utf8');
}

function readBoundedBytes(file, maximumBytes, label) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maximumBytes) throw new Error(`${label} missing or exceeds ${maximumBytes} bytes`);
  return fs.readFileSync(file);
}
