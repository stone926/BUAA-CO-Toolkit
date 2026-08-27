#!/usr/bin/env node
/** Validate the frozen capability/bin matrix and revision fingerprints. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const evidenceGateFile = path.join(here, 'evidence-gates.json');
const profiles = Object.freeze(['P3', 'P4', 'P5', 'P6', 'P7']);
const kinds = Object.freeze(['assembly', 'execution', 'device', 'full-stack']);
const idPattern = /^[a-z0-9][a-z0-9.-]+$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const revision2BinMatrixSha256 = 'ee145888faf574dbe830c1bf8988d898255da5d2f4e95765806a555afa83d63d';
const expectedMemberSetIds = Object.freeze([
  'assembler.syntax.advertised', 'isa.p3.required', 'isa.p4.required',
  'isa.p5.required', 'isa.p6.required', 'isa.p7.required', 'control.p3',
  'control.p4', 'control.p5', 'control.p6', 'control.p7',
  'memory.word-boundaries', 'memory.byte-halfword', 'mdu.architectural',
  'cp0.p7', 'exception.p7', 'timer.p7', 'irq.p7', 'device.mdu.p6',
  'handwritten.combinations'
]);

const requiredInstructions = Object.freeze({
  P3: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop'],
  P4: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'jal', 'jr', 'nop'],
  P5: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'jal', 'jr', 'nop'],
  P6: ['add', 'sub', 'and', 'or', 'slt', 'sltu', 'lui', 'addi', 'andi', 'ori', 'lb', 'lh', 'lw', 'sb', 'sh', 'sw', 'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo', 'beq', 'bne', 'jal', 'jr', 'nop'],
  P7: ['add', 'sub', 'and', 'or', 'slt', 'sltu', 'lui', 'addi', 'andi', 'ori', 'lb', 'lh', 'lw', 'sb', 'sh', 'sw', 'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo', 'beq', 'bne', 'jal', 'jr', 'mfc0', 'mtc0', 'eret', 'syscall', 'nop']
});

const expectedCapabilityIds = Object.freeze({
  assembly: profiles.map((profile) => `assembly.${profile.toLowerCase()}.source-image`),
  execution: [
    ...profiles.map((profile) => `execution.${profile.toLowerCase()}.architecture`),
    'execution.p7.cp0-exception', 'execution.p7.timer', 'execution.p7.external-irq'
  ],
  device: ['device.p6.mdu-timing', 'device.p7.timer', 'device.p7.external-irq'],
  'full-stack': [
    ...profiles.map((profile) => `full-stack.${profile.toLowerCase()}.architecture`),
    'full-stack.handwritten-source-graphs'
  ]
});

const expectedInitialGates = Object.freeze({
  assembly: { graphsPerProfile: 100000, validGraphsPerProfile: 50000, invalidGraphsPerProfile: 50000, syntaxBinMinimum: 100 },
  execution: { imagesPerProfile: 100000, meaningfulTransitions: 100000000, coverageBinMinimum: 100 },
  device: { directedBinMinimum: 1, fuzzCycles: 10000000 },
  'full-stack': { validGraphsPerProfile: 100000, meaningfulTransitions: 100000000, handwrittenUniqueGraphs: 500, coverageBinMinimum: 100 }
});

const expectedFingerprintPolicy = Object.freeze({
  commonFields: ['semanticsRevision', 'courseContractRevision', 'corpusSchemaRevision', 'capabilityScopeRevision'],
  fieldsByKind: {
    assembly: ['assemblerRevision', 'catalogRevision', 'diagnosticSchemaRevision'],
    execution: ['executorRevision', 'catalogRevision', 'eventSchemaRevision', 'observabilitySchemaRevision'],
    device: ['deviceBuildRevision', 'cycleContractRevision', 'vectorRevision'],
    'full-stack': ['assemblerRevision', 'executorRevision', 'catalogRevision', 'eventSchemaRevision', 'observabilitySchemaRevision', 'diagnosticSchemaRevision']
  },
  forbiddenFieldsByKind: {
    assembly: ['executorRevision', 'deviceBuildRevision', 'cycleContractRevision', 'vectorRevision', 'eventSchemaRevision', 'observabilitySchemaRevision'],
    execution: ['assemblerRevision', 'diagnosticSchemaRevision', 'deviceBuildRevision', 'cycleContractRevision', 'vectorRevision'],
    device: ['assemblerRevision', 'executorRevision', 'catalogRevision', 'diagnosticSchemaRevision', 'eventSchemaRevision', 'observabilitySchemaRevision'],
    'full-stack': ['deviceBuildRevision', 'cycleContractRevision', 'vectorRevision']
  }
});

const expectedSeedFields = Object.freeze([
  'sourceWordLimit', 'meaningfulTransitionLimit', 'stepPolicy', 'haltPolicy',
  'jobWallClockMs', 'shard', 'runnerRevision', 'rendererRevision', 'sourceSha256',
  'imageSha256', 'imageWordCount', 'evidenceCapabilityId'
]);

export class EvidenceGateValidationError extends Error {
  constructor(violations) {
    super(`evidence gates are invalid:\n${violations.map((item) => `  - ${item}`).join('\n')}`);
    this.name = 'EvidenceGateValidationError';
    this.violations = Object.freeze([...violations]);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

function sameMembers(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function sameObject(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function onlyKeys(value, allowed, context, violations) {
  if (!isObject(value)) {
    violations.push(`${context} must be an object`);
    return false;
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) violations.push(`${context} has unknown fields: ${unknown.join(', ')}`);
  return true;
}

function findGroup(capability, idPrefix) {
  return capability?.binGroups?.find((group) => group.idPrefix === idPrefix);
}

function requireGroup(capability, idPrefix, expectedMinimum, violations) {
  const group = findGroup(capability, idPrefix);
  if (!group) {
    violations.push(`${capability?.id ?? '<missing capability>'} is missing bin group ${idPrefix}`);
    return;
  }
  if (group.minimumEach !== expectedMinimum) {
    violations.push(`${idPrefix}.minimumEach must be ${expectedMinimum}, got ${group.minimumEach}`);
  }
}

export function expandEvidenceBins(document) {
  const memberSets = new Map((document.memberSets ?? []).map((set) => [set.id, set.members]));
  const bins = [];
  for (const kind of document.evidenceKinds ?? []) {
    for (const capability of kind.capabilities ?? []) {
      for (const group of capability.binGroups ?? []) {
        const members = group.memberSet === undefined ? group.members : memberSets.get(group.memberSet);
        if (!Array.isArray(members)) continue;
        for (const member of members) {
          bins.push(Object.freeze({
            id: `${group.idPrefix}.${member}`,
            kind: kind.kind,
            capabilityId: capability.id,
            profiles: Object.freeze([...capability.profiles]),
            contractIds: Object.freeze([...capability.contractIds]),
            metric: group.metric,
            minimum: group.minimumEach
          }));
        }
      }
    }
  }
  return Object.freeze(bins);
}

export function validateEvidenceGateDocument(document, options = {}) {
  const violations = [];
  onlyKeys(document, [
    'schemaRevision', 'description', 'profiles', 'binIdFormat', 'memberSets',
    'fingerprintPolicy', 'evidenceKinds', 'seedManifestFields',
    'invalidTransitionPolicy', 'status', 'revision'
  ], 'root', violations);
  if (document?.schemaRevision !== 2 || document?.revision !== 2) violations.push('schemaRevision and revision must both be 2');
  if (document?.status !== 'capability-bins-frozen') violations.push('status must be capability-bins-frozen');
  if (!sameMembers(document?.profiles, profiles)) violations.push(`profiles must be exactly ${profiles.join(', ')}`);
  if (document?.binIdFormat !== '{idPrefix}.{member}') violations.push('binIdFormat must be {idPrefix}.{member}');

  const memberSets = new Map();
  for (const [index, set] of (document?.memberSets ?? []).entries()) {
    const context = `memberSets[${index}]`;
    onlyKeys(set, ['id', 'members'], context, violations);
    if (typeof set?.id !== 'string' || !idPattern.test(set.id) || memberSets.has(set.id)) {
      violations.push(`${context}.id is invalid or duplicated`);
      continue;
    }
    if (!Array.isArray(set.members) || set.members.length === 0 || new Set(set.members).size !== set.members.length || set.members.some((member) => typeof member !== 'string' || !idPattern.test(member))) {
      violations.push(`${context}.members must be non-empty, unique, stable IDs`);
      continue;
    }
    memberSets.set(set.id, set.members);
  }
  for (const profile of profiles) {
    const id = `isa.${profile.toLowerCase()}.required`;
    if (!sameMembers(memberSets.get(id), requiredInstructions[profile])) violations.push(`${id} must exactly freeze the ${profile} required instruction order`);
  }
  if (!sameMembers([...memberSets.keys()].sort(), [...expectedMemberSetIds].sort())) violations.push('member-set IDs do not match the frozen revision-2 set');

  const distribution = options.featureDistribution;
  if (distribution) {
    const featureIds = distribution.advertisedFeatures?.map((feature) => feature.id) ?? [];
    if (!sameMembers(memberSets.get('assembler.syntax.advertised'), featureIds)) {
      violations.push('assembler.syntax.advertised must exactly match handwritten advertisedFeatures');
    }
    const combinationIds = distribution.criticalCombinations?.map((item) => item.id.replace(/^combo\./, '')) ?? [];
    if (!sameMembers(memberSets.get('handwritten.combinations'), combinationIds)) {
      violations.push('handwritten.combinations must exactly match frozen critical combinations');
    }
  }

  const policy = document?.fingerprintPolicy;
  onlyKeys(policy, ['algorithm', 'commonFields', 'fieldsByKind', 'forbiddenFieldsByKind'], 'fingerprintPolicy', violations);
  if (policy?.algorithm !== 'sha256-canonical-json-v1') violations.push('fingerprintPolicy.algorithm is invalid');
  for (const field of ['commonFields', 'fieldsByKind', 'forbiddenFieldsByKind']) {
    if (!sameObject(policy?.[field], expectedFingerprintPolicy[field])) violations.push(`fingerprintPolicy.${field} is not the frozen revision-2 policy`);
  }

  const contractEntries = options.contracts?.entries ?? [];
  const contracts = new Map(contractEntries.map((entry) => [entry.id, entry]));
  const kindMap = new Map();
  const capabilityMap = new Map();
  for (const [index, kind] of (document?.evidenceKinds ?? []).entries()) {
    const context = `evidenceKinds[${index}]`;
    onlyKeys(kind, ['kind', 'unit', 'initialGate', 'capabilities'], context, violations);
    if (!kinds.includes(kind?.kind) || kindMap.has(kind.kind)) {
      violations.push(`${context}.kind is invalid or duplicated`);
      continue;
    }
    kindMap.set(kind.kind, kind);
    if (!sameObject(kind.initialGate, expectedInitialGates[kind.kind])) violations.push(`${kind.kind}.initialGate is not the frozen revision-2 gate`);
    const ids = [];
    for (const [capIndex, capability] of (kind.capabilities ?? []).entries()) {
      const capContext = `${context}.capabilities[${capIndex}]`;
      onlyKeys(capability, ['id', 'profiles', 'contractIds', 'binGroups'], capContext, violations);
      ids.push(capability?.id);
      if (typeof capability?.id !== 'string' || !capability.id.startsWith(`${kind.kind}.`) || capabilityMap.has(capability.id)) {
        violations.push(`${capContext}.id is invalid, duplicated, or has the wrong kind prefix`);
      } else {
        capabilityMap.set(capability.id, { kind: kind.kind, capability });
      }
      if (!Array.isArray(capability?.profiles) || capability.profiles.length === 0 || new Set(capability.profiles).size !== capability.profiles.length || capability.profiles.some((profile) => !profiles.includes(profile))) {
        violations.push(`${capContext}.profiles is invalid`);
      }
      if (!Array.isArray(capability?.contractIds) || capability.contractIds.length === 0 || new Set(capability.contractIds).size !== capability.contractIds.length) {
        violations.push(`${capContext}.contractIds is invalid`);
      }
      for (const contractId of capability?.contractIds ?? []) {
        const contract = contracts.get(contractId);
        if (options.contracts && (!contract || contract.status !== 'frozen')) violations.push(`${capContext} references missing/non-frozen contract ${contractId}`);
        if (contract?.profile && !capability.profiles.includes(contract.profile)) violations.push(`${capContext} contract ${contractId} is outside capability profiles`);
      }
      const prefixes = new Set();
      for (const [groupIndex, group] of (capability?.binGroups ?? []).entries()) {
        const groupContext = `${capContext}.binGroups[${groupIndex}]`;
        onlyKeys(group, ['idPrefix', 'metric', 'minimumEach', 'memberSet', 'members'], groupContext, violations);
        if (typeof group?.idPrefix !== 'string' || !group.idPrefix.startsWith(`${kind.kind}.`) || prefixes.has(group.idPrefix)) violations.push(`${groupContext}.idPrefix is invalid or duplicated`);
        prefixes.add(group?.idPrefix);
        if (typeof group?.metric !== 'string' || !idPattern.test(group.metric)) violations.push(`${groupContext}.metric is invalid`);
        if (!Number.isSafeInteger(group?.minimumEach) || group.minimumEach <= 0) violations.push(`${groupContext}.minimumEach must be a positive safe integer`);
        const hasSet = typeof group?.memberSet === 'string';
        const hasMembers = Array.isArray(group?.members);
        if (hasSet === hasMembers) violations.push(`${groupContext} must specify exactly one of memberSet or members`);
        if (hasSet && !memberSets.has(group.memberSet)) violations.push(`${groupContext} references unknown memberSet ${group.memberSet}`);
        if (hasMembers && (group.members.length === 0 || new Set(group.members).size !== group.members.length || group.members.some((member) => typeof member !== 'string' || !idPattern.test(member)))) violations.push(`${groupContext}.members is invalid`);
      }
    }
    if (!sameMembers([...ids].sort(), [...expectedCapabilityIds[kind.kind]].sort())) violations.push(`${kind.kind} capability IDs do not match the frozen revision-2 set`);
  }
  if (!sameMembers([...kindMap.keys()].sort(), [...kinds].sort())) violations.push('evidence kinds must be exactly assembly, execution, device, full-stack');

  for (const profile of profiles) {
    const lower = profile.toLowerCase();
    const assembly = capabilityMap.get(`assembly.${lower}.source-image`)?.capability;
    requireGroup(assembly, `assembly.${lower}.graph`, 50000, violations);
    requireGroup(assembly, `assembly.${lower}.outcome`, 100, violations);
    requireGroup(assembly, `assembly.${lower}.syntax`, 100, violations);
    const execution = capabilityMap.get(`execution.${lower}.architecture`)?.capability;
    requireGroup(execution, `execution.${lower}.instruction`, 100, violations);
    requireGroup(execution, `execution.${lower}.control`, 100, violations);
    requireGroup(execution, `execution.${lower}.address`, 100, violations);
    const fullStack = capabilityMap.get(`full-stack.${lower}.architecture`)?.capability;
    requireGroup(fullStack, `full-stack.${lower}.graph`, 100000, violations);
    requireGroup(fullStack, `full-stack.${lower}.instruction`, 100, violations);
    requireGroup(fullStack, `full-stack.${lower}.control`, 100, violations);
    requireGroup(fullStack, `full-stack.${lower}.address`, 100, violations);
  }
  for (const prefix of ['execution.p6.memory', 'execution.p6.mdu', 'execution.p7.memory', 'execution.p7.mdu', 'execution.p7.cp0', 'execution.p7.exception', 'execution.p7.timer', 'execution.p7.irq']) {
    const capabilityId = prefix.startsWith('execution.p7.cp0') || prefix.startsWith('execution.p7.exception')
      ? 'execution.p7.cp0-exception'
      : prefix.startsWith('execution.p7.timer') ? 'execution.p7.timer'
        : prefix.startsWith('execution.p7.irq') ? 'execution.p7.external-irq'
          : `${prefix.split('.').slice(0, 2).join('.')}.architecture`;
    requireGroup(capabilityMap.get(capabilityId)?.capability, prefix, 100, violations);
  }
  const handwritten = capabilityMap.get('full-stack.handwritten-source-graphs')?.capability;
  requireGroup(handwritten, 'full-stack.handwritten.total', 500, violations);
  requireGroup(handwritten, 'full-stack.handwritten.feature', 20, violations);
  requireGroup(handwritten, 'full-stack.handwritten.combination', 5, violations);

  const expanded = expandEvidenceBins(document ?? {});
  const ids = expanded.map((bin) => bin.id);
  if (new Set(ids).size !== ids.length) violations.push('expanded coverage-bin IDs are not globally unique');
  if (ids.some((id) => !idPattern.test(id))) violations.push('an expanded coverage-bin ID is invalid');
  if (canonicalSha256(expanded) !== revision2BinMatrixSha256) violations.push('expanded capability/bin matrix differs from frozen revision-2 IDs, metrics, minima, profiles, or contracts');
  if (!sameMembers(document?.seedManifestFields, expectedSeedFields)) violations.push('seedManifestFields are not the frozen renderer/evidence field list');
  if (typeof document?.invalidTransitionPolicy !== 'string' || !/invalid.*out-of-domain.*inconclusive.*waiv/iu.test(document.invalidTransitionPolicy)) {
    violations.push('invalidTransitionPolicy must exclude invalid, out-of-domain, inconclusive, and waived transitions');
  }
  if (violations.length) throw new EvidenceGateValidationError(violations);
  return Object.freeze({ document, bins: expanded, capabilities: capabilityMap });
}

export function loadEvidenceGates(options = {}) {
  const document = JSON.parse(fs.readFileSync(options.file ?? evidenceGateFile, 'utf8'));
  return validateEvidenceGateDocument(document, options);
}

export function createEvidenceFingerprint(validated, kind, capabilityId, revisions) {
  if (!kinds.includes(kind)) throw new Error(`unknown evidence kind: ${kind}`);
  const capability = validated.capabilities.get(capabilityId);
  if (!capability || capability.kind !== kind) throw new Error(`${capabilityId} is not a ${kind} capability`);
  const required = [...validated.document.fingerprintPolicy.commonFields, ...validated.document.fingerprintPolicy.fieldsByKind[kind]];
  const actual = Object.keys(revisions ?? {}).sort();
  if (!sameMembers(actual, [...required].sort())) throw new Error(`${kind}/${capabilityId} fingerprint revisions must be exactly ${required.join(', ')}`);
  for (const field of required) {
    if (typeof revisions[field] !== 'string' || revisions[field].length === 0 || revisions[field].length > 256) throw new Error(`${kind}/${capabilityId} fingerprint ${field} must be a bounded non-empty string`);
  }
  for (const forbidden of validated.document.fingerprintPolicy.forbiddenFieldsByKind[kind]) {
    if (Object.hasOwn(revisions, forbidden)) throw new Error(`${kind}/${capabilityId} fingerprint must not contain ${forbidden}`);
  }
  const payload = { kind, capabilityId, revisions: canonical(revisions) };
  return Object.freeze({ algorithm: validated.document.fingerprintPolicy.algorithm, ...payload, digest: canonicalSha256(payload) });
}

export function validateEvidenceFingerprint(validated, fingerprint) {
  if (!isObject(fingerprint) || fingerprint.algorithm !== 'sha256-canonical-json-v1' || !sha256Pattern.test(fingerprint.digest ?? '')) throw new Error('evidence fingerprint shape is invalid');
  const rebuilt = createEvidenceFingerprint(validated, fingerprint.kind, fingerprint.capabilityId, fingerprint.revisions);
  if (rebuilt.digest !== fingerprint.digest) throw new Error(`evidence fingerprint digest is stale for ${fingerprint.capabilityId}`);
  return rebuilt;
}

function main() {
  const contracts = JSON.parse(fs.readFileSync(path.join(here, 'contracts.json'), 'utf8'));
  const featureDistribution = JSON.parse(fs.readFileSync(path.join(here, '..', 'corpus', 'handwritten-feature-distribution.json'), 'utf8'));
  const validated = loadEvidenceGates({ contracts, featureDistribution });
  process.stdout.write(`evidence gates OK: capabilities=${validated.capabilities.size}, bins=${validated.bins.length}, revision=${validated.document.revision}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
