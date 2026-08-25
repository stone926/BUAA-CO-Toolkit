#!/usr/bin/env node
/**
 * Validate the machine-readable course contract ledger without external packages.
 *
 * The generic validator implements the draft-07 subset used by
 * contract-schema.json: local $ref, oneOf, type, required, properties,
 * additionalProperties, enum/const, pattern, length/item/property bounds,
 * uniqueItems and numeric bounds.
 *
 * Optional --verify-sources validates every reference instance (including
 * repeated sources), its inclusive line range, and performs a best-effort quote
 * check. Ledger quotes may be concise summaries, so non-verbatim text is counted
 * as a summary rather than rejected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const rawArgs = process.argv.slice(2);
const unknownArgs = rawArgs.filter((arg) => arg !== '--verify-sources');
const verifySources = rawArgs.includes('--verify-sources');
const violations = [];
if (unknownArgs.length > 0) {
  violations.push(`unknown arguments: ${unknownArgs.join(', ')}`);
}

function check(condition, message) {
  if (!condition) violations.push(message);
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, file), 'utf8'));
  } catch (error) {
    violations.push(`${file}: cannot parse JSON: ${error.message}`);
    return undefined;
  }
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function instanceType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value;
}

function matchesType(value, expected) {
  switch (expected) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function resolveLocalRef(rootSchema, reference) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    throw new Error(`unsupported $ref ${JSON.stringify(reference)} (only local JSON pointers are supported)`);
  }
  let current = rootSchema;
  for (const rawPart of reference.slice(2).split('/')) {
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!current || typeof current !== 'object' || !(part in current)) {
      throw new Error(`unresolved $ref ${reference}`);
    }
    current = current[part];
  }
  return current;
}

function validateSchema(value, rule, instancePath, rootSchema, errors) {
  if (typeof rule === 'boolean') {
    if (!rule) errors.push(`${instancePath}: rejected by false schema`);
    return;
  }
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    errors.push(`${instancePath}: invalid schema node`);
    return;
  }

  if (rule.$ref !== undefined) {
    try {
      validateSchema(value, resolveLocalRef(rootSchema, rule.$ref), instancePath, rootSchema, errors);
    } catch (error) {
      errors.push(`${instancePath}: ${error.message}`);
    }
  }
  if (Array.isArray(rule.allOf)) {
    for (const branch of rule.allOf) validateSchema(value, branch, instancePath, rootSchema, errors);
  }
  if (Array.isArray(rule.oneOf)) {
    const matches = rule.oneOf.reduce((count, branch) => {
      const branchErrors = [];
      validateSchema(value, branch, instancePath, rootSchema, branchErrors);
      return count + (branchErrors.length === 0 ? 1 : 0);
    }, 0);
    if (matches !== 1) errors.push(`${instancePath}: must match exactly one oneOf branch (matched ${matches})`);
  }

  if (rule.type !== undefined) {
    const expectedTypes = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (!expectedTypes.some((expected) => matchesType(value, expected))) {
      errors.push(`${instancePath}: expected ${expectedTypes.join('|')}, got ${instanceType(value)}`);
      return;
    }
  }
  if (Array.isArray(rule.enum) && !rule.enum.some((candidate) => jsonEqual(value, candidate))) {
    errors.push(`${instancePath}: value ${JSON.stringify(value)} is not in enum ${JSON.stringify(rule.enum)}`);
  }
  if (Object.hasOwn(rule, 'const') && !jsonEqual(value, rule.const)) {
    errors.push(`${instancePath}: expected constant ${JSON.stringify(rule.const)}`);
  }

  if (typeof value === 'string') {
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      errors.push(`${instancePath}: length ${value.length} is less than minLength ${rule.minLength}`);
    }
    if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      errors.push(`${instancePath}: length ${value.length} exceeds maxLength ${rule.maxLength}`);
    }
    if (rule.pattern !== undefined) {
      try {
        if (!new RegExp(rule.pattern, 'u').test(value)) {
          errors.push(`${instancePath}: value ${JSON.stringify(value)} does not match /${rule.pattern}/`);
        }
      } catch (error) {
        errors.push(`${instancePath}: invalid schema pattern ${JSON.stringify(rule.pattern)}: ${error.message}`);
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (rule.minimum !== undefined && value < rule.minimum) errors.push(`${instancePath}: ${value} is less than minimum ${rule.minimum}`);
    if (rule.maximum !== undefined && value > rule.maximum) errors.push(`${instancePath}: ${value} exceeds maximum ${rule.maximum}`);
    if (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) errors.push(`${instancePath}: ${value} must be greater than ${rule.exclusiveMinimum}`);
    if (rule.exclusiveMaximum !== undefined && value >= rule.exclusiveMaximum) errors.push(`${instancePath}: ${value} must be less than ${rule.exclusiveMaximum}`);
  }

  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) errors.push(`${instancePath}: has ${value.length} items, less than minItems ${rule.minItems}`);
    if (rule.maxItems !== undefined && value.length > rule.maxItems) errors.push(`${instancePath}: has ${value.length} items, more than maxItems ${rule.maxItems}`);
    if (rule.uniqueItems) {
      const seen = new Set();
      for (let index = 0; index < value.length; index += 1) {
        const key = JSON.stringify(value[index]);
        if (seen.has(key)) errors.push(`${instancePath}[${index}]: duplicate item`);
        seen.add(key);
      }
    }
    if (rule.items && !Array.isArray(rule.items)) {
      for (let index = 0; index < value.length; index += 1) {
        validateSchema(value[index], rule.items, `${instancePath}[${index}]`, rootSchema, errors);
      }
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (rule.minProperties !== undefined && keys.length < rule.minProperties) errors.push(`${instancePath}: has ${keys.length} properties, less than minProperties ${rule.minProperties}`);
    if (rule.maxProperties !== undefined && keys.length > rule.maxProperties) errors.push(`${instancePath}: has ${keys.length} properties, more than maxProperties ${rule.maxProperties}`);
    for (const required of rule.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${instancePath}: missing required property ${JSON.stringify(required)}`);
    }
    const properties = rule.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateSchema(child, properties[key], `${instancePath}.${key}`, rootSchema, errors);
      } else if (rule.additionalProperties === false) {
        errors.push(`${instancePath}: additional property ${JSON.stringify(key)} is not allowed`);
      } else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') {
        validateSchema(child, rule.additionalProperties, `${instancePath}.${key}`, rootSchema, errors);
      }
    }
  }
}

function validateDocument(document, definitionName, file, schema) {
  const definition = schema?.definitions?.[definitionName];
  if (!definition) {
    violations.push(`contract-schema.json: missing definition ${definitionName}`);
  } else if (document !== undefined) {
    validateSchema(document, definition, file, schema, violations);
  }
}

const schema = loadJson('contract-schema.json');
const contracts = loadJson('contracts.json');
const decisions = loadJson('decisions.json');
const divergences = loadJson('divergences.json');
const gates = loadJson('evidence-gates.json');

if (schema) {
  validateDocument(contracts, 'contractLedger', 'contracts.json', schema);
  validateDocument(decisions, 'decisionLedger', 'decisions.json', schema);
  validateDocument(divergences, 'divergenceLedger', 'divergences.json', schema);
  validateDocument(gates, 'evidenceGateDocument', 'evidence-gates.json', schema);
}

const contractEntries = Array.isArray(contracts?.entries) ? contracts.entries : [];
const decisionEntries = Array.isArray(decisions?.entries) ? decisions.entries : [];
const divergenceEntries = Array.isArray(divergences?.entries) ? divergences.entries : [];

// Ledger-wide id uniqueness and explicit cross references.
const seenIds = new Map();
for (const [file, entries] of [
  ['contracts.json', contractEntries],
  ['decisions.json', decisionEntries],
  ['divergences.json', divergenceEntries]
]) {
  for (let index = 0; index < entries.length; index += 1) {
    const id = entries[index]?.id;
    if (typeof id !== 'string') continue;
    if (seenIds.has(id)) violations.push(`${file}.entries[${index}].id: duplicate ${id}; first declared at ${seenIds.get(id)}`);
    else seenIds.set(id, `${file}.entries[${index}]`);
  }
}
for (let index = 0; index < contractEntries.length; index += 1) {
  const entry = contractEntries[index];
  if (entry?.status === 'superseded') check(typeof entry.supersededBy === 'string', `contracts.json.entries[${index}]: superseded entry must have supersededBy`);
  if (entry?.supersededBy !== undefined) {
    check(entry.status === 'superseded', `contracts.json.entries[${index}]: supersededBy requires status=superseded`);
    check(seenIds.has(entry.supersededBy), `contracts.json.entries[${index}].supersededBy: unknown id ${entry.supersededBy}`);
  }
}
for (let index = 0; index < decisionEntries.length; index += 1) {
  const entry = decisionEntries[index];
  if (entry?.decision === 'pending') {
    check(Array.isArray(entry.freezeRequires) && entry.freezeRequires.length > 0, `decisions.json.entries[${index}]: pending decision must list at least one freezeRequires item`);
  }
  if (entry?.decision === 'frozen') {
    check(Array.isArray(entry.freezeRequires) && entry.freezeRequires.length === 0, `decisions.json.entries[${index}]: frozen decision must have an empty freezeRequires array`);
  }
}

// Evidence gates: schema validates all fields; these checks freeze revision-1
// semantic structure, positive thresholds, coverage bins and fingerprints.
const evidenceSpecifications = {
  assembly: {
    gate: { graphsPerProfile: 'positiveInteger', syntaxBinsMinHits: 'positiveInteger' },
    includes: ['assembler', 'catalog', 'contract', 'diagnostic-schema'],
    excludes: ['executor'],
    bins: ['per-profile', 'per-advertised-syntax-feature', 'accept', 'reject', 'diagnostic']
  },
  execution: {
    gate: { imagesPerProfile: 'positiveInteger', transitions: 'positiveInteger' },
    includes: ['executor', 'catalog', 'contract', 'event-schema', 'observability-schema'],
    excludes: ['ts-assembler'],
    bins: ['per-profile', 'instruction', 'branch-taken-untaken', 'byte-lane', 'address-boundary', 'exception-irq-timer-scenario']
  },
  device: {
    gate: { directedBins: 'nonEmptyString', fuzzCycles: 'positiveInteger' },
    includes: ['device-build', 'cycle-contract', 'vector-revision'],
    excludes: ['assembler', 'machine-instruction-count'],
    bins: ['timer-state', 'timer-mode', 'write-priority', 'irq-width', 'irq-restart']
  },
  'full-stack': {
    gate: { validGraphsPerProfile: 'positiveInteger', transitions: 'positiveInteger', handwrittenCorpusGate: 'nonEmptyString' },
    includes: ['assembler', 'executor', 'catalog', 'contract', 'event-schema', 'observability-schema', 'diagnostic-schema'],
    excludes: [],
    bins: ['per-profile', 'instruction', 'branch-taken-untaken', 'byte-lane', 'address-boundary', 'exception-irq-timer-scenario', 'handwritten-feature-distribution']
  }
};

const evidenceKinds = Array.isArray(gates?.evidenceKinds) ? gates.evidenceKinds : [];
const kindCounts = new Map();
for (const kind of evidenceKinds) {
  if (typeof kind?.kind === 'string') kindCounts.set(kind.kind, (kindCounts.get(kind.kind) ?? 0) + 1);
}
for (const [kindName, specification] of Object.entries(evidenceSpecifications)) {
  check(kindCounts.get(kindName) === 1, `evidence-gates.json: evidence kind ${kindName} must occur exactly once`);
  const kind = evidenceKinds.find((candidate) => candidate?.kind === kindName);
  if (!kind) continue;
  const actualGateKeys = Object.keys(kind.initialGate ?? {}).sort();
  const expectedGateKeys = Object.keys(specification.gate).sort();
  check(jsonEqual(actualGateKeys, expectedGateKeys), `evidence-gates.json: ${kindName}.initialGate fields must be exactly ${expectedGateKeys.join(', ')}`);
  for (const [field, expectedType] of Object.entries(specification.gate)) {
    const value = kind.initialGate?.[field];
    if (expectedType === 'positiveInteger') check(Number.isInteger(value) && value > 0, `evidence-gates.json: ${kindName}.initialGate.${field} must be a positive integer`);
    else check(typeof value === 'string' && value.trim().length > 0, `evidence-gates.json: ${kindName}.initialGate.${field} must be a non-empty string`);
  }
  const includes = Array.isArray(kind.fingerprintIncludes) ? kind.fingerprintIncludes : [];
  const excludes = Array.isArray(kind.fingerprintExcludes) ? kind.fingerprintExcludes : [];
  for (const token of specification.includes) check(includes.includes(token), `evidence-gates.json: ${kindName}.fingerprintIncludes is missing ${token}`);
  for (const token of specification.excludes) check(excludes.includes(token), `evidence-gates.json: ${kindName}.fingerprintExcludes is missing ${token}`);
  for (const token of includes) check(!excludes.includes(token), `evidence-gates.json: ${kindName} fingerprint token ${token} is both included and excluded`);
  const bins = Array.isArray(kind.coverageBins) ? kind.coverageBins : [];
  for (const bin of specification.bins) check(bins.includes(bin), `evidence-gates.json: ${kindName}.coverageBins is missing ${bin}`);
}

const expectedSeedManifestFields = ['sourceWordLimit', 'meaningfulTransitionLimit', 'stepPolicy', 'haltPolicy', 'jobWallClockMs', 'shard', 'runnerRevision'].sort();
const actualSeedManifestFields = Array.isArray(gates?.seedManifestFields) ? [...gates.seedManifestFields].sort() : [];
check(jsonEqual(actualSeedManifestFields, expectedSeedManifestFields), `evidence-gates.json: seedManifestFields must be exactly ${expectedSeedManifestFields.join(', ')}`);

function collectReferences() {
  const collected = [];
  for (let index = 0; index < contractEntries.length; index += 1) {
    for (let refIndex = 0; refIndex < (contractEntries[index]?.normativeReference ?? []).length; refIndex += 1) {
      collected.push({ ref: contractEntries[index].normativeReference[refIndex], at: `contracts.json.entries[${index}].normativeReference[${refIndex}]` });
    }
  }
  for (let index = 0; index < decisionEntries.length; index += 1) {
    for (let refIndex = 0; refIndex < (decisionEntries[index]?.normativeReference ?? []).length; refIndex += 1) {
      collected.push({ ref: decisionEntries[index].normativeReference[refIndex], at: `decisions.json.entries[${index}].normativeReference[${refIndex}]` });
    }
  }
  for (let index = 0; index < divergenceEntries.length; index += 1) {
    for (let refIndex = 0; refIndex < (divergenceEntries[index]?.sources ?? []).length; refIndex += 1) {
      collected.push({ ref: divergenceEntries[index].sources[refIndex], at: `divergences.json.entries[${index}].sources[${refIndex}]` });
    }
  }
  return collected;
}

function normalizeQuote(value) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN')
    .replace(/[`*_>#|\[\](){}<>“”‘’'"，。；：、！？~—–\-]/gu, '')
    .replace(/\s+/gu, '');
}

function quoteMatchKind(quote, excerpt) {
  const normalizedQuote = normalizeQuote(quote);
  const normalizedExcerpt = normalizeQuote(excerpt);
  if (normalizedQuote.length > 0 && normalizedExcerpt.includes(normalizedQuote)) return 'verbatim';
  const anchors = quote.split(/[；。！？\n]|\.{3}/u).map(normalizeQuote).filter((anchor) => anchor.length >= 12);
  if (anchors.some((anchor) => normalizedExcerpt.includes(anchor))) return 'anchor';
  return 'summary';
}

let sourceReferencesChecked = 0;
let verbatimQuotes = 0;
let anchoredQuotes = 0;
let summaryQuotes = 0;
let skippedBinaryQuotes = 0;

if (verifySources) {
  const buaaCoRoot = path.resolve(here, '..', '..', '..', '..');
  for (const { ref, at } of collectReferences()) {
    sourceReferencesChecked += 1;
    if (!ref || typeof ref.source !== 'string' || ref.source.trim().length === 0) continue;
    const sourcePath = path.resolve(buaaCoRoot, ref.source);
    const relative = path.relative(buaaCoRoot, sourcePath);
    const contained = relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    check(contained, `${at}.source: ${ref.source} escapes BUAA-CO root ${buaaCoRoot}`);
    if (!contained) continue;
    check(fs.existsSync(sourcePath), `${at}.source: ${ref.source} does not exist under ${buaaCoRoot}`);
    if (!fs.existsSync(sourcePath)) continue;
    let stats;
    try {
      stats = fs.statSync(sourcePath);
    } catch (error) {
      violations.push(`${at}.source: cannot stat ${ref.source}: ${error.message}`);
      continue;
    }
    check(stats.isFile(), `${at}.source: ${ref.source} is not a file`);
    if (!stats.isFile()) continue;

    const lines = ref.lines;
    if (Array.isArray(lines)) {
      check(lines.length === 1 || lines.length === 2, `${at}.lines: expected [line] or [start, end]`);
      const start = lines[0];
      const end = lines.length === 2 ? lines[1] : start;
      check(Number.isInteger(start) && start >= 1, `${at}.lines[0]: must be a positive integer`);
      check(Number.isInteger(end) && end >= 1, `${at}.lines[${lines.length - 1}]: must be a positive integer`);
      if (Number.isInteger(start) && Number.isInteger(end)) check(start <= end, `${at}.lines: start ${start} exceeds end ${end}`);
    }

    // Binary sources have no useful line-oriented quote check without adding a
    // document parser dependency to this otherwise dependency-free harness.
    if (path.extname(sourcePath).toLowerCase() === '.pdf') {
      skippedBinaryQuotes += 1;
      continue;
    }
    let sourceText;
    try {
      sourceText = fs.readFileSync(sourcePath, 'utf8');
    } catch (error) {
      violations.push(`${at}.source: cannot read ${ref.source}: ${error.message}`);
      continue;
    }
    const sourceLines = sourceText.split(/\r?\n/u);
    let excerpt = sourceText;
    if (Array.isArray(lines) && lines.length >= 1 && lines.length <= 2) {
      const start = lines[0];
      const end = lines.length === 2 ? lines[1] : start;
      if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && start <= end) {
        check(end <= sourceLines.length, `${at}.lines: end ${end} exceeds ${ref.source} line count ${sourceLines.length}`);
        if (end <= sourceLines.length) excerpt = sourceLines.slice(start - 1, end).join('\n');
      }
    }
    if (typeof ref.quote === 'string' && ref.quote.trim().length > 0) {
      const matchKind = quoteMatchKind(ref.quote, excerpt);
      if (matchKind === 'verbatim') verbatimQuotes += 1;
      else if (matchKind === 'anchor') anchoredQuotes += 1;
      else summaryQuotes += 1;
    }
  }
}

if (violations.length > 0) {
  console.error('Course contract ledger validation FAILED:');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Course contract ledger OK: ${contractEntries.length} contracts, ${decisionEntries.length} decisions, ${divergenceEntries.length} divergences.`);
  if (verifySources) {
    console.log(
      `Source verification OK: ${sourceReferencesChecked} reference instances; `
      + `${verbatimQuotes} verbatim, ${anchoredQuotes} anchored, ${summaryQuotes} accepted summaries, `
      + `${skippedBinaryQuotes} binary quote checks skipped.`
    );
  }
}
