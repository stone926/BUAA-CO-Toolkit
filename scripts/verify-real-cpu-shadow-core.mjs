// @index scripts — phase-4 real-CPU shadow 的路径发现、manifest 期望与结果分类

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Stable `OutOfDomainReason` values emitted by the phase-2/3 core. */
export const stableOutOfDomainReasons = Object.freeze([
  'unloaded-instruction',
  'unrecognized-instruction',
  'unsupported-instruction',
  'address-out-of-region',
  'misaligned-access',
  'undefined-hi-lo-read',
  'divide-by-zero',
  'jalr-same-register',
  'double-delay-slot',
  'timer-mode-undefined',
  'device-schedule-missing'
]);

const stableOutOfDomainReasonSet = new Set(stableOutOfDomainReasons);

/** Accept a repository root, its `.co/cases` directory, one case directory, or `case.json`. */
export function discoverCaseManifests(input) {
  const resolved = path.resolve(input);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) {
    return path.basename(resolved) === 'case.json' ? [resolved] : [];
  }
  if (!stat.isDirectory()) return [];

  const directManifest = path.join(resolved, 'case.json');
  if (fs.statSync(directManifest, { throwIfNoEntry: false })?.isFile()) {
    return [directManifest];
  }

  const caseRoot = path.basename(resolved) === 'cases'
    ? resolved
    : path.join(resolved, '.co', 'cases');
  if (!fs.statSync(caseRoot, { throwIfNoEntry: false })?.isDirectory()) return [];

  const result = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === 'case.json') result.push(full);
    }
  };
  visit(caseRoot);
  return result.sort((left, right) => left.localeCompare(right));
}

/** Extract the archived stop point and, for v2, the recorded architectural step count. */
export function manifestExecutionExpectations(manifest) {
  const machineCode = manifest?.version === 2 ? manifest.program?.machineCode : manifest?.machineCode;
  const issues = [];
  const haltPc = optionalUint32(machineCode?.haltPc);
  if (machineCode?.haltPc !== undefined && haltPc === undefined) {
    issues.push('manifest machine-code haltPc is invalid');
  }

  let steps;
  if (manifest?.version === 2) {
    if (manifest.oracle?.steps === undefined) {
      issues.push('manifest oracle.steps is missing');
    } else if (!Number.isSafeInteger(manifest.oracle.steps) || manifest.oracle.steps < 0) {
      issues.push('manifest oracle.steps is invalid');
    } else {
      steps = manifest.oracle.steps;
    }
    if (manifest.oracle?.runConfiguration?.traceLevel !== 2) {
      issues.push('manifest oracle.steps is not an architectural step count without traceLevel 2');
    }
  }
  return { haltPc, steps, issues };
}

/**
 * Decide whether a completed core call can enter trace comparison. Only an
 * explicit, stable out-of-domain reason is evidence of a non-comparable input;
 * resource exhaustion and engine failures are unclassified regressions.
 */
export function classifyBuiltinExecution(result, expected = {}) {
  if (result?.status === 'out-of-domain') {
    const reason = result.diagnostic?.reason;
    if (typeof reason === 'string' && stableOutOfDomainReasonSet.has(reason)) {
      return {
        status: 'notComparable',
        message: `out-of-domain: ${result.diagnostic?.code ?? 'unknown-diagnostic'} (${reason})`
      };
    }
    return {
      status: 'inconclusive',
      message: `out-of-domain without an allowlisted reason${reason ? `: ${reason}` : ''}`
    };
  }

  if (result?.status !== 'halted') {
    const diagnostic = result?.diagnostic?.code
      ? `: ${result.diagnostic.code}`
      : ' without a diagnostic';
    return {
      status: 'inconclusive',
      message: `builtin execution stopped with ${result?.status ?? 'unknown status'}${diagnostic}`
    };
  }

  if (expected.haltPc !== undefined) {
    const actualHaltPc = optionalUint32(result.haltPc);
    if (actualHaltPc !== expected.haltPc) {
      return {
        status: 'inconclusive',
        message: `haltPc differs: archived ${fixedHex(expected.haltPc)}, builtin ${
          actualHaltPc === undefined ? 'missing' : fixedHex(actualHaltPc)
        }`
      };
    }
  }
  if (expected.steps !== undefined && result.instructions !== expected.steps) {
    return {
      status: 'inconclusive',
      message: `architectural step count differs: archived ${expected.steps}, builtin ${result.instructions ?? 'missing'}`
    };
  }
  return { status: 'comparable', message: 'halt and step evidence match' };
}

export function realCpuShadowExitCode(summary) {
  return summary.cases === 0 || summary.matched === 0
    || summary.inconclusive > 0 || summary.corrupt > 0 ? 1 : 0;
}

/** Resolve the manifest-declared legacy trace, including moved v1 absolute archives. */
export function resolveLegacyTraceFile(caseDir, manifest) {
  const reference = manifest?.version === 2
    ? manifest.artifacts?.oracle?.traceOut
    : manifest?.artifacts?.mars?.traceOut;
  const archivePath = typeof reference === 'string' ? reference : reference?.path;
  if (typeof archivePath === 'string' && archivePath.length > 0) {
    if (path.isAbsolute(archivePath)) {
      if (fs.statSync(archivePath, { throwIfNoEntry: false })?.isFile()) return archivePath;
    } else {
      const direct = path.resolve(caseDir, ...archivePath.replace(/\\/g, '/').split('/'));
      if (fs.statSync(direct, { throwIfNoEntry: false })?.isFile()) return direct;
    }
    const baseName = path.basename(archivePath);
    for (const candidate of [path.join(caseDir, 'mars', baseName), path.join(caseDir, baseName)]) {
      if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    }
  }
  return [
    path.join(caseDir, 'mars', 'program.mars.out'),
    path.join(caseDir, 'program.mars.out')
  ].find((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
}

/** Parse one exact 32-bit word per non-empty line; partial parseInt matches are forbidden. */
export function parseStrictArchivedHexText(text) {
  const words = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/^(?:0x)?[0-9a-f]{8}$/i.test(line)) {
      throw new Error(`malformed HexText word: ${line}`);
    }
    words.push(Number.parseInt(line.replace(/^0x/i, ''), 16) >>> 0);
  }
  return words;
}

/** Prefer a still-valid v1 absolute snapshot, but fall back to the copied case-local file. */
export function resolveArchivedCaseFile(caseDir, archivePath, fallbackName) {
  if (typeof archivePath === 'string' && path.isAbsolute(archivePath)) {
    if (fs.statSync(archivePath, { throwIfNoEntry: false })?.isFile()) return archivePath;
    return path.join(caseDir, fallbackName);
  }
  const direct = path.resolve(
    caseDir,
    ...String(archivePath ?? fallbackName).replace(/\\/g, '/').split('/')
  );
  return fs.statSync(direct, { throwIfNoEntry: false })?.isFile()
    ? direct
    : path.join(caseDir, fallbackName);
}

function optionalUint32(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff) return value >>> 0;
  if (typeof value === 'string' && /^(?:0x)?[0-9a-f]{1,8}$/i.test(value)) {
    return Number.parseInt(value.replace(/^0x/i, ''), 16) >>> 0;
  }
  return undefined;
}

function fixedHex(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}
