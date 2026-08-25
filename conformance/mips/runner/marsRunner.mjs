/**
 * Independent spawn + coL2 parsing for the pinned MARS reference.
 *
 * This module intentionally re-implements the minimal MARS invocation and the
 * course trace contract (COURSE-COMMON-HALT-001) instead of importing the
 * production implementation, so conformance expected values can never depend
 * on the code under test. The production equivalents are
 * `src/language/mips/marsArgs.ts`, `src/language/mips/traceParser.ts` and
 * `src/courseTesting/marsStepLimit.ts`; keep the two implementations aligned
 * by contract, not by import.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const detailedHeaderPattern = /^@PC(?:0x)?([0-9a-f]{1,8})\s*->.*\(([0-9a-f]{8})\)\s*$/i;
const coL2EventPattern = /^\s*(\$|\*)\s*(?:0x)?([0-9a-fxz]+)\s*<=\s*(?:0x)?([0-9a-fxz]{1,8})$/i;

export function referenceJarPath() {
  return path.resolve(import.meta.dirname, '..', '..', '.cache', 'Mars_CO_v0.6.3.jar');
}

export function runMarsReference({ asmFile, profile, maxSteps, stdin }) {
  const jar = referenceJarPath();
  if (!fs.existsSync(jar)) {
    return { ok: false, error: `reference JAR missing: ${jar}. Run "node reference/download-references.mjs" first.` };
  }
  const memoryConfiguration = profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText';
  const args = ['-jar', jar, 'nc', 'mc', memoryConfiguration];
  if (profile === 'P7') {
    args.push('efc');
  }
  args.push('coL2', String(maxSteps));
  if (stdin !== undefined) {
    // Course automation does not use stdin in phase 0; keep the parameter for
    // the later console host work.
    throw new Error('stdin is not supported by the phase-0 conformance runner');
  }
  args.push(asmFile);
  const startedAt = Date.now();
  const result = spawnSync('java', args, { encoding: 'utf8', timeout: 600000, maxBuffer: 128 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    exitCode: result.status,
    wallClockMs: Date.now() - startedAt,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

/**
 * Parse coL2 output into per-instruction commit blocks. Returns an array of
 * { pc, word, events: [{kind:'grf'|'dm', target, value}] } in dynamic order.
 */
export function parseCoL2Trace(text) {
  const blocks = [];
  let current = undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const header = detailedHeaderPattern.exec(rawLine.trim());
    if (header) {
      current = {
        pc: normalizeHex(header[1], 8),
        word: normalizeHex(header[2], 8),
        events: []
      };
      blocks.push(current);
      continue;
    }
    if (current === undefined || !rawLine.startsWith('\t\t')) {
      continue;
    }
    // coL2 commit lines carry no @PC prefix; they belong to the current header.
    const event = coL2EventPattern.exec(rawLine.trim());
    if (!event) {
      continue;
    }
    current.events.push({
      kind: event[1] === '$' ? 'grf' : 'dm',
      target: event[1] === '$' ? event[2] : normalizeHex(event[2], 8),
      value: normalizeHex(event[3], 8)
    });
  }
  return blocks;
}

/**
 * Reconstruct final GPR/DM state from the dynamic trace (stable MARS $gp/$sp
 * seed included, matching the Compact* oracle reset; the divergence from the
 * course reset is MARS-DIV-GPSP-001).
 */
export function finalState(blocks) {
  const gpr = new Map();
  const dm = new Map();
  for (let i = 28; i <= 29; i++) {
    gpr.set(String(i), i === 28 ? '00001800' : '00002ffc');
  }
  for (const block of blocks) {
    for (const event of block.events) {
      if (event.kind === 'grf') {
        gpr.set(event.target, event.value);
      } else {
        dm.set(event.target, event.value);
      }
    }
  }
  return { gpr, dm };
}

export function haltReached(blocks, expectedHaltPc, expectedHaltWord) {
  const expected = normalizeHex(expectedHaltPc.replace(/^0x/i, ''), 8);
  const word = normalizeHex(expectedHaltWord.replace(/^0x/i, ''), 8);
  return blocks.some((block) => block.pc === expected && block.word === word);
}

function normalizeHex(token, width) {
  const stripped = token.replace(/^0x/i, '').toUpperCase();
  if (/^[0-9A-F]+$/.test(stripped)) {
    return stripped.padStart(width, '0').slice(-width);
  }
  return stripped;
}
