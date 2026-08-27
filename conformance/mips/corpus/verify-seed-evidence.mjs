#!/usr/bin/env node
/** Materialize every fixed seed source/image and verify it via the TS JSONL CLI. */
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeedManifest } from './generate-seeds.mjs';
import { renderSeedProgram, seedMnemonicsByProfile, seedRendererRevision } from './seed-program-renderer.mjs';
import {
  createEvidenceFingerprint,
  loadEvidenceGates,
  validateEvidenceFingerprint
} from '../contract/validate-evidence-gates.mjs';
import { referenceRoles, resolveVerifiedReference } from '../reference/referenceAssets.mjs';

const corpusRoot = path.dirname(fileURLToPath(import.meta.url));
const conformanceRoot = path.resolve(corpusRoot, '..');
const extensionRoot = path.resolve(conformanceRoot, '..', '..');
const defaultCli = path.join(extensionRoot, 'out', 'mips', 'cli', 'main.js');
const profiles = Object.freeze(['P3', 'P4', 'P5', 'P6', 'P7']);
const sha256Pattern = /^[0-9a-f]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(`fixed seed evidence: ${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function sha256Value(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseArgs(argv) {
  const options = { gate: undefined, cli: process.env.BUAA_CO_MIPS_ENGINE_CLI || defaultCli, output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--gate') options.gate = argv[++index];
    else if (arg === '--cli') options.cli = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  invariant(options.gate === 'candidate' || options.gate === 'formal', '--gate must be candidate or formal');
  invariant(typeof options.cli === 'string' && options.cli.length > 0, '--cli requires a path');
  return {
    gate: options.gate,
    cli: path.resolve(options.cli),
    output: options.output === undefined ? undefined : path.resolve(options.output)
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runCli(cli, programs) {
  invariant(fs.existsSync(cli) && fs.statSync(cli).isFile(), `compiled CLI is missing: ${cli}; run npm run compile first`);
  const requests = [{ protocolVersion: 1, requestId: 'seed:describe', operation: 'describe' }];
  for (const profile of profiles) {
    const instructions = programs.filter((program) => program.profile === profile).flatMap((program) => program.instructions);
    requests.push({
      protocolVersion: 1,
      requestId: `seed:encode:${profile}`,
      operation: 'isa.encodeBatch',
      entries: instructions.map((instruction) => ({ mnemonic: instruction.mnemonic, operands: instruction.operands }))
    });
    requests.push({
      protocolVersion: 1,
      requestId: `seed:decode:${profile}`,
      operation: 'isa.decodeBatch',
      words: instructions.map((instruction) => instruction.word),
      scope: { profile, enabledLayers: ['required'] }
    });
  }
  const run = spawnSync(process.execPath, [cli], {
    cwd: extensionRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    windowsHide: true
  });
  if (run.error) throw run.error;
  invariant(run.status === 0, `CLI exited ${run.status}: ${run.stderr}`);
  const responses = run.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  invariant(responses.length === requests.length, `CLI returned ${responses.length} responses for ${requests.length} requests`);
  const byId = new Map(responses.map((response) => [response.requestId, response]));
  invariant(byId.size === responses.length, 'CLI returned duplicate request IDs');
  for (const request of requests) invariant(byId.get(request.requestId)?.ok === true, `${request.requestId} failed: ${JSON.stringify(byId.get(request.requestId)?.error)}`);

  const describe = byId.get('seed:describe').result;
  invariant(describe?.catalog?.sha256 && sha256Pattern.test(describe.catalog.sha256), 'describe did not return a catalog SHA-256');
  for (const profile of profiles) {
    const instructions = programs.filter((program) => program.profile === profile).flatMap((program) => program.instructions);
    const encoded = byId.get(`seed:encode:${profile}`).result;
    const decoded = byId.get(`seed:decode:${profile}`).result;
    invariant(Array.isArray(encoded) && encoded.length === instructions.length, `${profile} encode batch length mismatch`);
    invariant(Array.isArray(decoded) && decoded.length === instructions.length, `${profile} decode batch length mismatch`);
    for (const [index, instruction] of instructions.entries()) {
      invariant(encoded[index]?.word === instruction.word, `${profile} image word ${index} ${instruction.mnemonic}: independent=${instruction.word}, CLI=${encoded[index]?.word}`);
      invariant(decoded[index]?.exactMnemonic === instruction.mnemonic, `${profile} image word ${index} exact decode mismatch`);
      invariant(decoded[index]?.canonicalMnemonic === instruction.mnemonic, `${profile} image word ${index} is not canonical`);
    }
  }
  return describe;
}

function normalizeHexText(text, context) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').filter((line) => line.length > 0);
  invariant(lines.length > 0, `${context} is empty`);
  invariant(lines.every((line) => /^[0-9a-f]{8}$/i.test(line)), `${context} contains malformed HexText`);
  return `${lines.map((line) => line.toLowerCase()).join('\n')}\n`;
}

function combinedProfileSource(programs, profile) {
  const selected = programs.filter((program) => program.profile === profile);
  const lines = ['.text 0x00003000', '_fixed_seed_jal_target:'];
  for (const program of selected) {
    const sourceLines = program.source.trimEnd().split('\n');
    invariant(sourceLines[1] === '.text 0x00003000', `${program.caseId} source header is not frozen`);
    invariant(sourceLines[2] === '_fixed_seed_jal_target:', `${program.caseId} fixed JAL target is not frozen`);
    lines.push(sourceLines[0], ...sourceLines.slice(3));
  }
  return `${lines.join('\n')}\n`;
}

function runReferenceAssembly(programs) {
  const reference = resolveVerifiedReference(referenceRoles.stockAssembler);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buaa-co-fixed-seeds-'));
  const profileEvidence = [];
  try {
    for (const profile of profiles) {
      const selected = programs.filter((program) => program.profile === profile);
      const source = combinedProfileSource(programs, profile);
      const expectedImage = selected.map((program) => program.imageText).join('');
      const sourceFile = path.join(temporaryRoot, `${profile}.asm`);
      const outputFile = path.join(temporaryRoot, `${profile}.hex`);
      fs.writeFileSync(sourceFile, source, 'utf8');
      const memoryConfiguration = profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText';
      const args = ['-jar', reference.file, 'nc', 'mc', memoryConfiguration, 'ae1'];
      if (profile === 'P5' || profile === 'P6' || profile === 'P7') args.push('db');
      if (profile === 'P7') args.push('efc');
      args.push('a', 'dump', '.text', 'HexText', outputFile, sourceFile);
      const run = spawnSync(process.env.CONFORMANCE_JAVA || 'java', args, {
        cwd: temporaryRoot,
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      });
      if (run.error) throw run.error;
      invariant(run.status === 0, `${profile} pinned MARS assembly exited ${run.status}: ${run.stderr || run.stdout}`);
      invariant(fs.existsSync(outputFile), `${profile} pinned MARS did not produce HexText: ${run.stderr || run.stdout}`);
      const actualImage = normalizeHexText(fs.readFileSync(outputFile, 'utf8'), `${profile} pinned MARS image`);
      invariant(actualImage === expectedImage, `${profile} pinned MARS image differs from independently rendered image`);
      profileEvidence.push({
        profile,
        combinedSourceSha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
        imageSha256: crypto.createHash('sha256').update(actualImage, 'utf8').digest('hex'),
        imageWords: actualImage.trimEnd().split('\n').length,
        cliOptions: [...args.slice(2, -1), '<SOURCE>'].map((value) => value === outputFile ? '<OUTPUT>' : value)
      });
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return {
    role: reference.role,
    fileName: reference.fileName,
    sha256: reference.verifiedSha256,
    sourceTag: reference.sourceTag,
    sourceCommit: reference.sourceCommit,
    profiles: profileEvidence
  };
}

function observedAssemblyBins(profile) {
  const lower = profile.toLowerCase();
  const counts = {
    [`assembly.${lower}.graph.valid`]: 50,
    [`assembly.${lower}.outcome.accept`]: 50,
    [`assembly.${lower}.syntax.register.numeric-abi-alias`]: 50,
    [`assembly.${lower}.syntax.literal.decimal-hex-signed`]: 50,
    [`assembly.${lower}.syntax.label.forward-backward-self`]: 50,
    [`assembly.${lower}.syntax.section.text-data-ktext`]: 50,
    [`assembly.${lower}.syntax.memory.offset-base-boundaries`]: 50,
    [`assembly.${lower}.syntax.control.branch-jump-delay`]: 50
  };
  if (profile === 'P6' || profile === 'P7') counts[`assembly.${lower}.syntax.mdu.hilo-dependency`] = 50;
  if (profile === 'P7') counts[`assembly.${lower}.syntax.cp0.exception-handler-layout`] = 50;
  return counts;
}

function evidencePayload(evidence) {
  const { integrity: _integrity, ...payload } = evidence;
  return payload;
}

export function buildSeedEvidence(options) {
  const manifest = buildSeedManifest();
  const committed = readJson(path.join(corpusRoot, 'seeds.json'));
  invariant(JSON.stringify(committed) === JSON.stringify(manifest), 'seeds.json differs from the deterministic manifest');
  const programs = manifest.cases.map((seedCase) => {
    const program = renderSeedProgram(seedCase);
    invariant(program.rendererRevision === seedCase.rendererRevision && program.rendererRevision === seedRendererRevision, `${seedCase.id} renderer revision mismatch`);
    invariant(program.sourceSha256 === seedCase.sourceSha256, `${seedCase.id} source hash mismatch`);
    invariant(program.imageSha256 === seedCase.imageSha256, `${seedCase.id} image hash mismatch`);
    invariant(program.words.length === seedCase.imageWordCount, `${seedCase.id} image word count mismatch`);
    invariant(program.evidenceCapabilityId === seedCase.evidenceCapabilityId, `${seedCase.id} capability mismatch`);
    return program;
  });
  invariant(new Set(programs.map((program) => program.sourceSha256)).size === 250, 'rendered sources are not 250 unique graphs');
  invariant(new Set(programs.map((program) => program.imageSha256)).size === 250, 'rendered images are not 250 unique images');
  invariant(programs.reduce((sum, program) => sum + program.words.length, 0) < 1000000, 'L1 rendered word count exceeds the one-million transition envelope');

  const describe = runCli(options.cli, programs);
  const reference = runReferenceAssembly(programs);
  const contracts = readJson(path.join(conformanceRoot, 'contract', 'contracts.json'));
  const distribution = readJson(path.join(corpusRoot, 'handwritten-feature-distribution.json'));
  const gates = loadEvidenceGates({ contracts, featureDistribution: distribution });
  const binIndex = new Map(gates.bins.map((bin) => [bin.id, bin]));
  const fingerprints = [];
  const profileSummaries = [];
  for (const profile of profiles) {
    const selected = programs.filter((program) => program.profile === profile);
    const capabilityId = `assembly.${profile.toLowerCase()}.source-image`;
    const revisions = {
      semanticsRevision: 'course-semantics-v1',
      courseContractRevision: `contracts-schema-${contracts.schemaRevision}-sha256-${sha256File(path.join(conformanceRoot, 'contract', 'contracts.json'))}`,
      corpusSchemaRevision: `fixed-seeds-schema-${manifest.schemaRevision}-sha256-${manifest.integrity.casesSha256}`,
      capabilityScopeRevision: `${capabilityId}-gate-r${gates.document.revision}`,
      assemblerRevision: `seed-renderer-v${seedRendererRevision}+${reference.role}-sha256-${reference.sha256}`,
      catalogRevision: `sha256-${describe.catalog.sha256}`,
      diagnosticSchemaRevision: 'fixed-valid-seed-no-diagnostic-v1'
    };
    const fingerprint = createEvidenceFingerprint(gates, 'assembly', capabilityId, revisions);
    validateEvidenceFingerprint(gates, fingerprint);
    fingerprints.push(fingerprint);
    const observedBins = observedAssemblyBins(profile);
    for (const id of Object.keys(observedBins)) invariant(binIndex.has(id), `${profile} observed unknown frozen bin ${id}`);
    const histogram = Object.fromEntries(seedMnemonicsByProfile[profile].map((mnemonic) => [mnemonic, selected.reduce((count, program) => count + program.instructions.filter((instruction) => instruction.mnemonic === mnemonic).length, 0)]));
    invariant(Object.values(histogram).every((count) => count >= 50), `${profile} did not render every required instruction at least 50 times`);
    profileSummaries.push({
      profile,
      capabilityId,
      cases: selected.length,
      uniqueSourceGraphs: new Set(selected.map((program) => program.sourceSha256)).size,
      uniqueImages: new Set(selected.map((program) => program.imageSha256)).size,
      imageWords: selected.reduce((sum, program) => sum + program.words.length, 0),
      instructionHistogram: histogram,
      observedBins: Object.fromEntries(Object.entries(observedBins).sort(([left], [right]) => left.localeCompare(right)))
    });
  }
  invariant(profileSummaries.every((summary) => summary.cases === 50 && summary.uniqueSourceGraphs === 50 && summary.uniqueImages === 50), 'each profile must contribute 50 unique source graphs and images');

  const cases = programs.map((program) => ({
    id: program.caseId,
    profile: program.profile,
    rendererRevision: program.rendererRevision,
    capabilityId: program.evidenceCapabilityId,
    sourceSha256: program.sourceSha256,
    imageSha256: program.imageSha256,
    source: program.source,
    imageWords: program.words,
    sourceMap: program.sourceMap,
    instructions: program.instructions.map(({ mnemonic, operands, word, role = 'payload' }) => ({ mnemonic, operands, word, role }))
  }));
  const evidence = {
    schemaRevision: 1,
    evidenceKind: 'assembly',
    gate: options.gate,
    required: options.gate === 'formal',
    batchId: manifest.batch.id,
    seedManifestSha256: manifest.integrity.casesSha256,
    verifier: {
      kind: 'pinned-mars-image-plus-versioned-jsonl-isa-process',
      protocolVersion: 1,
      catalogSha256: describe.catalog.sha256,
      operations: ['mars.dump.HexText', 'isa.encodeBatch', 'isa.decodeBatch'],
      reference
    },
    fingerprints,
    profileSummaries,
    cases
  };
  return { ...evidence, integrity: { algorithm: 'sha256-canonical-json-v1', payloadSha256: sha256Value(evidencePayload(evidence)) } };
}

function writeAtomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = buildSeedEvidence(options);
  if (options.output) writeAtomicJson(options.output, evidence);
  const cases = evidence.profileSummaries.reduce((sum, profile) => sum + profile.cases, 0);
  const words = evidence.profileSummaries.reduce((sum, profile) => sum + profile.imageWords, 0);
  process.stdout.write(`fixed seed evidence OK: gate=${evidence.gate}, required=${evidence.required}, cases=${cases}, words=${words}, catalog=${evidence.verifier.catalogSha256}${options.output ? `, output=${options.output}` : ''}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
