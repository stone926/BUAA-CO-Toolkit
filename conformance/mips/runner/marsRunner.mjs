/** Independent MARS spawn and strict coL2 parsing for pinned reference roles. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  referenceRoles,
  resolveVerifiedReference
} from '../reference/referenceAssets.mjs';

const detailedHeaderPattern = /^@PC(?:0x)?([0-9a-f]{1,8})\s*->.*\(([0-9a-f]{8})\)\s*$/i;
const coL2EventPattern = /^\s*(\$|\*)\s*(?:0x)?([0-9a-f]+)\s*<=\s*(?:0x)?([0-9a-f]{1,8})$/i;
const courseHaltPattern = /^Program reached course halt loop at\s+(0x[0-9a-f]{1,8})\.\s*$/im;
const supportedProfiles = new Set(['P3', 'P4', 'P5', 'P6', 'P7']);
// Stable MARS resolves bare tokens 1..31 as GPR display selectors before the
// stand-alone maximum-step option. 32 is the first unambiguous positive limit.
const minimumUnambiguousMaxSteps = 32;

export const runnerRevision = 2;
export const normalizerRevision = 1;
export const stockAssemblerRole = referenceRoles.stockAssembler;
export const legacyCourseExecutorRole = referenceRoles.legacyCourseExecutor;

export function effectiveMarsMaxSteps(requested) {
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error(`maxSteps must be a positive safe integer, got ${requested}`);
  }
  return Math.max(requested, minimumUnambiguousMaxSteps);
}

export function courseUsesDelayedBranching(profile) {
  return profile === 'P5' || profile === 'P6' || profile === 'P7';
}

export function referenceJarPath(role = stockAssemblerRole) {
  return resolveVerifiedReference(role).file;
}

function failure(error, startedAt = Date.now(), details = {}) {
  return {
    ok: false,
    exitCode: null,
    wallClockMs: Date.now() - startedAt,
    stdout: '',
    stderr: '',
    error: error instanceof Error ? error.message : String(error),
    ...details
  };
}

export function runMarsReference({ asmFile, profile, maxSteps, stdin, role = stockAssemblerRole, haltPc }) {
  const startedAt = Date.now();
  try {
    if (!supportedProfiles.has(profile)) {
      throw new Error(`unsupported profile: ${profile}`);
    }
    const effectiveMaxSteps = effectiveMarsMaxSteps(maxSteps);
    if (stdin !== undefined) {
      throw new Error('stdin is not supported by the conformance reference runner');
    }
    const sourceStat = fs.statSync(asmFile);
    if (!sourceStat.isFile()) {
      throw new Error(`assembly source is not a regular file: ${asmFile}`);
    }
    if (role !== stockAssemblerRole && role !== legacyCourseExecutorRole) {
      throw new Error(`unsupported executable reference role: ${role}`);
    }

    // This call re-reads the manifest and re-checks bytes/SHA-256 for every JVM invocation.
    const reference = resolveVerifiedReference(role);
    const memoryConfiguration = profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText';
    // MARS otherwise reports assembler/simulator failures in text while often
    // returning process status 0, which would make a broken reference look green.
    const cliOptions = ['nc', 'mc', memoryConfiguration, 'ae1', 'se1'];
    if (courseUsesDelayedBranching(profile)) {
      cliOptions.push('db');
    }
    if (profile === 'P7') {
      cliOptions.push('efc');
    }
    if (role === legacyCourseExecutorRole) {
      if (typeof haltPc !== 'string' || !/^0x[0-9a-f]{8}$/i.test(haltPc)) {
        throw new Error('legacy-course-executor requires a 32-bit haltPc');
      }
      cliOptions.push('coZeroGpr', 'coStrictData', `coHalt=${haltPc.toLowerCase()}`);
    }
    cliOptions.push('coL2', String(effectiveMaxSteps));
    const stableCliOptions = [...cliOptions, '<SOURCE>'];
    const args = ['-jar', reference.file, ...cliOptions, asmFile];
    const javaExecutable = process.env.CONFORMANCE_JAVA || 'java';
    const result = spawnSync(javaExecutable, args, {
      encoding: 'utf8',
      timeout: 600000,
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return {
      ok: !result.error && result.status === 0,
      exitCode: result.status,
      signal: result.signal,
      wallClockMs: Date.now() - startedAt,
      stdout,
      stderr,
      error: result.error?.message,
      role,
      reference,
      javaExecutable,
      effectiveMaxSteps,
      cliOptions: stableCliOptions
    };
  } catch (error) {
    return failure(error, startedAt, { role });
  }
}

/** Parse coL2 output; malformed instruction/commit-looking lines are fatal. */
export function parseCoL2Trace(text) {
  if (typeof text !== 'string') {
    throw new Error('coL2 trace must be a string');
  }
  const blocks = [];
  let current;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const header = detailedHeaderPattern.exec(trimmed);
    if (header) {
      current = { pc: normalizeHex(header[1], 8), word: normalizeHex(header[2], 8), events: [] };
      blocks.push(current);
      continue;
    }
    if (/^@PC/i.test(trimmed)) {
      throw new Error(`malformed coL2 instruction header: ${rawLine}`);
    }
    const commitLooking = /^(?:\$|\*)/.test(trimmed);
    if (!rawLine.startsWith('\t\t')) {
      if (commitLooking) {
        throw new Error(`malformed coL2 commit indentation: ${rawLine}`);
      }
      continue;
    }
    if (!current) {
      throw new Error(`coL2 commit appeared before an instruction header: ${rawLine}`);
    }
    const event = coL2EventPattern.exec(trimmed);
    if (!event) {
      throw new Error(`malformed coL2 commit line: ${rawLine}`);
    }
    let target;
    if (event[1] === '$') {
      if (!/^\d+$/.test(event[2]) || Number(event[2]) > 31) {
        throw new Error(`invalid coL2 GPR target: ${event[2]}`);
      }
      target = String(Number(event[2]));
    } else {
      target = normalizeHex(event[2], 8);
    }
    current.events.push({
      kind: event[1] === '$' ? 'grf' : 'dm',
      target,
      value: normalizeHex(event[3], 8)
    });
  }
  return blocks;
}

export function finalState(blocks, options = {}) {
  const gpr = new Map();
  const dm = new Map();
  const writtenGpr = new Set();
  const writtenDm = new Set();
  if (options.seedCompactGpr) {
    gpr.set('28', '00001800');
    gpr.set('29', '00002FFC');
  }
  for (const block of blocks) {
    for (const event of block.events) {
      if (event.kind === 'grf') {
        gpr.set(event.target, event.value);
        writtenGpr.add(event.target);
      } else {
        dm.set(event.target, event.value);
        writtenDm.add(event.target);
      }
    }
  }
  return { gpr, dm, writtenGpr, writtenDm };
}

export function haltReached(blocks, expectedHaltPc, expectedHaltWord, minimumOccurrences = 1) {
  const expected = normalizeHex(expectedHaltPc.replace(/^0x/i, ''), 8);
  const word = normalizeHex(expectedHaltWord.replace(/^0x/i, ''), 8);
  return blocks.filter((block) => block.pc === expected && block.word === word).length >= minimumOccurrences;
}

export function nativeCourseHaltReached(stdout, expectedHaltPc) {
  const match = courseHaltPattern.exec(stdout);
  return match !== null && normalizeHex(match[1].replace(/^0x/i, ''), 8) === normalizeHex(expectedHaltPc.replace(/^0x/i, ''), 8);
}

function normalizeHex(token, width) {
  const stripped = token.replace(/^0x/i, '').toUpperCase();
  if (!/^[0-9A-F]+$/.test(stripped) || stripped.length > width) {
    throw new Error(`invalid ${width * 4}-bit hex token: ${token}`);
  }
  return stripped.padStart(width, '0');
}
