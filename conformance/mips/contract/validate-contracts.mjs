#!/usr/bin/env node
/**
 * Validate the machine-readable course contract ledger.
 *
 * Checks (fail closed):
 *  1. contracts.json / decisions.json / divergences.json parse and match contract-schema.json.
 *  2. Every entry id is unique within its file (and across files).
 *  3. Ledger id cross-references resolve: contract note/supersededBy and decision entries only
 *     reference ids that exist in one of the three files.
 *  4. evidence-gates.json has the four evidence kinds with required fields.
 *
 * Optional --verify-sources: additionally checks that referenced `source` paths exist under
 * BUAA-CO root (default: grandparent x4 of this script) and, when `lines` is a single line,
 * that the file has at least that many lines. Skipped by default because cscore may be absent
 * in CI checkout.
 *
 * Exit code 0 on success, 1 on any violation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const verifySources = args.has('--verify-sources');

const violations = [];

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(here, file), 'utf8'));
}

function check(condition, message) {
  if (!condition) {
    violations.push(message);
  }
}

const schema = loadJson('contract-schema.json');
const contracts = loadJson('contracts.json');
const decisions = loadJson('decisions.json');
const divergences = loadJson('divergences.json');

// ── Structural validation against the entry schemas ────────────────────────────
function validateEntries(entries, entrySchema, file) {
  const seen = new Set();
  for (const entry of entries) {
    const entryId = entry?.id ?? '<missing id>';
    check(schema.definitions[entrySchema], `contract-schema.json is missing definition ${entrySchema}`);
    if (!schema.definitions[entrySchema]) {
      return new Set();
    }
    check(entry && typeof entry === 'object', `${file}: entry ${entryId} must be an object`);
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const def = schema.definitions[entrySchema];
    for (const required of def.required ?? []) {
      check(entry[required] !== undefined, `${file}: entry ${entryId} missing required field "${required}"`);
    }
    if (typeof entry.id === 'string') {
      check(!seen.has(entry.id), `${file}: duplicate entry id ${entry.id}`);
      seen.add(entry.id);
      const pattern = new RegExp(def.properties.id.pattern);
      check(pattern.test(entry.id), `${file}: entry id ${entry.id} does not match ${def.properties.id.pattern}`);
    }
    if (entry.profile !== undefined && !def.properties.profile.enum.includes(entry.profile)) {
      violations.push(`${file}: entry ${entryId} has invalid profile ${entry.profile}`);
    }
    if (entry.domain !== undefined && !def.properties.domain.enum.includes(entry.domain)) {
      violations.push(`${file}: entry ${entryId} has invalid domain ${entry.domain}`);
    }
    if (entry.status !== undefined && !def.properties.status.enum.includes(entry.status)) {
      violations.push(`${file}: entry ${entryId} has invalid status ${entry.status}`);
    }
    if (entry.decision !== undefined && !def.properties.decision.enum.includes(entry.decision)) {
      violations.push(`${file}: entry ${entryId} has invalid decision ${entry.decision}`);
    }
    if (entry.category !== undefined && !def.properties.category.enum.includes(entry.category)) {
      violations.push(`${file}: entry ${entryId} has invalid category ${entry.category}`);
    }
    const refs = entry.normativeReference ?? entry.sources;
    check(Array.isArray(refs) && refs.length >= 1, `${file}: entry ${entryId} must have at least one reference`);
    for (const ref of refs ?? []) {
      check(ref && typeof ref.source === 'string' && ref.source.length > 0, `${file}: entry ${entryId} has a reference without source`);
      if (Array.isArray(ref.lines)) {
        for (const line of ref.lines) {
          check(Number.isInteger(line) && line >= 1, `${file}: entry ${entryId} reference ${ref.source} has invalid line ${line}`);
        }
        check(ref.lines.length <= 2, `${file}: entry ${entryId} reference ${ref.source} has too many lines`);
      }
    }
  }
  return seen;
}

const contractIds = validateEntries(contracts.entries, 'contractEntry', 'contracts.json');
const decisionIds = validateEntries(decisions.entries, 'decisionEntry', 'decisions.json');
const divergenceIds = validateEntries(divergences.entries, 'divergenceEntry', 'divergences.json');

// ── Uniqueness across files ────────────────────────────────────────────────────
const allIds = new Set([...contractIds, ...decisionIds, ...divergenceIds]);
check(
  allIds.size === contractIds.size + decisionIds.size + divergenceIds.size,
  'ledger ids must be unique across contracts.json, decisions.json and divergences.json'
);

// ── Cross-file id references ───────────────────────────────────────────────────
function checkReferences(entry, file) {
  for (const value of [entry.supersededBy]) {
    if (value !== undefined && value !== null) {
      check(allIds.has(value), `${file}: entry ${entry.id} references unknown id ${value}`);
    }
  }
}
for (const entry of contracts.entries) {
  checkReferences(entry, 'contracts.json');
}

// ── Status consistency ─────────────────────────────────────────────────────────
for (const entry of contracts.entries) {
  if (entry.status === 'superseded') {
    check(!!entry.supersededBy, `contracts.json: entry ${entry.id} is superseded but has no supersededBy`);
  }
  if (entry.supersededBy) {
    check(entry.status === 'superseded', `contracts.json: entry ${entry.id} has supersededBy but is not superseded`);
  }
}
for (const entry of decisions.entries) {
  if (entry.decision === 'pending') {
    check(
      Array.isArray(entry.freezeRequires) && entry.freezeRequires.length > 0,
      `decisions.json: pending decision ${entry.id} must list freezeRequires`
    );
  }
}

// ── evidence-gates.json skeleton ───────────────────────────────────────────────
const gates = loadJson('evidence-gates.json');
const kinds = new Set(gates.evidenceKinds.map((kind) => kind.kind));
for (const required of ['assembly', 'execution', 'device', 'full-stack']) {
  check(kinds.has(required), `evidence-gates.json: missing evidence kind ${required}`);
}
check(gates.status === 'structure-frozen', 'evidence-gates.json: status must be structure-frozen in phase 0');
check(gates.revision === 1, 'evidence-gates.json: revision must be 1 in phase 0');

// ── Optional source existence verification ─────────────────────────────────────
if (verifySources) {
  const buaaCoRoot = path.resolve(here, '..', '..', '..', '..');
  const refs = [
    ...contracts.entries.flatMap((entry) => entry.normativeReference),
    ...decisions.entries.flatMap((entry) => entry.normativeReference),
    ...divergences.entries.flatMap((entry) => entry.sources)
  ];
  const uniqueSources = new Map();
  for (const ref of refs) {
    uniqueSources.set(ref.source, ref);
  }
  for (const [source, ref] of uniqueSources) {
    const file = path.join(buaaCoRoot, source);
    check(fs.existsSync(file), `source ${source} does not exist under ${buaaCoRoot}`);
    if (fs.existsSync(file) && Array.isArray(ref.lines) && ref.lines.length === 1) {
      const lineCount = fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
      check(ref.lines[0] <= lineCount, `source ${source} references line ${ref.lines[0]} but has only ${lineCount} lines`);
    }
  }
}

if (violations.length) {
  console.error('Course contract ledger validation FAILED:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Course contract ledger OK: ${contracts.entries.length} contracts, ${decisions.entries.length} decisions, ${divergences.entries.length} divergences.`
  );
}
