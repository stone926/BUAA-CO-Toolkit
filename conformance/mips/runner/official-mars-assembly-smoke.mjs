#!/usr/bin/env node
/** Compare a small stock-MARS assembly image with the builtin assembler. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(runnerRoot, '..', '..', '..');
const defaultCli = path.join(extensionRoot, 'out', 'mips', 'cli', 'main.js');
const source = [
  '.text 0x00003000',
  'main:',
  '    ori $t0, $zero, 42',
  '    addiu $t1, $t0, -1',
  '    beq $t1, $t0, main',
  '    nop',
  '.data 0x00000000',
  'sample:',
  '    .word 0x12345678',
  ''
].join('\n');

function invariant(condition, message) {
  if (!condition) throw new Error(`official MARS assembly smoke: ${message}`);
}

function parseArgs(argv) {
  let jar = process.env.MARS_4_5_JAR;
  let cli = process.env.BUAA_CO_MIPS_ENGINE_CLI || defaultCli;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--jar') jar = argv[++index];
    else if (arg === '--cli') cli = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  invariant(typeof jar === 'string' && jar.length > 0, 'set MARS_4_5_JAR or pass --jar <Mars4_5.jar>');
  invariant(fs.existsSync(jar) && fs.statSync(jar).isFile(), `MARS jar is missing: ${jar}`);
  invariant(fs.existsSync(cli) && fs.statSync(cli).isFile(), `compiled TS CLI is missing: ${cli}; run npm run compile first`);
  return { jar: path.resolve(jar), cli: path.resolve(cli) };
}

function runTsAssembler(cli) {
  const request = {
    protocolVersion: 1,
    requestId: 'official-mars-assembly-smoke',
    operation: 'assembler.assemble',
    profile: 'P3',
    sources: [{ id: 'source-0000', text: source }]
  };
  const run = spawnSync(process.execPath, [cli], {
    cwd: extensionRoot,
    encoding: 'utf8',
    input: `${JSON.stringify(request)}\n`,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  invariant(!run.error, `TS CLI spawn failed: ${run.error?.message}`);
  invariant(run.status === 0, `TS CLI exited ${run.status}: ${run.stderr}`);
  const response = JSON.parse(run.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1));
  invariant(response?.ok && response.result?.ok && response.result?.image, 'builtin assembler rejected the smoke source');
  return response.result.image;
}

function runMars(jar) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buaa-co-official-mars-'));
  try {
    const sourceFile = path.join(temporaryRoot, 'smoke.asm');
    const textFile = path.join(temporaryRoot, 'text.hex');
    const dataFile = path.join(temporaryRoot, 'data.hex');
    fs.writeFileSync(sourceFile, source, 'utf8');
    const args = [
      '-jar', jar,
      'a', 'nc', 'mc', 'CompactDataAtZero',
      'dump', '.text', 'HexText', textFile,
      'dump', '.data', 'HexText', dataFile,
      sourceFile
    ];
    const run = spawnSync(process.env.CONFORMANCE_JAVA || 'java', args, {
      cwd: temporaryRoot,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    });
    invariant(!run.error, `MARS spawn failed: ${run.error?.message}`);
    invariant(run.status === 0, `MARS exited ${run.status}: ${run.stderr || run.stdout}`);
    invariant(fs.existsSync(textFile), `MARS did not create text dump: ${run.stderr || run.stdout}`);
    invariant(fs.existsSync(dataFile), `MARS did not create data dump: ${run.stderr || run.stdout}`);
    return { text: readHexWords(textFile), data: readHexWords(dataFile) };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyMarsVersion(jar) {
  const run = spawnSync(process.env.CONFORMANCE_JAVA || 'java', ['-jar', jar, 'h'], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  });
  invariant(!run.error, `MARS version check failed: ${run.error?.message}`);
  invariant(run.status === 0 && /MARS 4\.5\b/u.test(`${run.stdout}\n${run.stderr}`),
    `jar did not identify itself as MARS 4.5: ${run.stderr || run.stdout}`);
}

function readHexWords(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\s+/u).filter(Boolean)
    .map((word) => word.replace(/^0x/iu, '').padStart(8, '0').toLowerCase());
}

function wordsFor(image, segmentName) {
  const segment = image.segments.find((candidate) => candidate.name === segmentName);
  return (segment?.words ?? []).map((word) => (Number(word) >>> 0).toString(16).padStart(8, '0'));
}

function main() {
  const { jar, cli } = parseArgs(process.argv.slice(2));
  verifyMarsVersion(jar);
  const tsImage = runTsAssembler(cli);
  const marsImage = runMars(jar);
  for (const segmentName of ['text', 'data']) {
    const segment = tsImage.segments.find((candidate) => candidate.name === segmentName);
    const expectedBase = segmentName === 'text' ? 0x3000 : 0;
    invariant(segment && (Number(segment.baseAddress) >>> 0) === expectedBase,
      `builtin assembler did not place ${segmentName} at 0x${expectedBase.toString(16).padStart(8, '0')}`);
    const tsWords = wordsFor(tsImage, segmentName);
    const marsWords = marsImage[segmentName];
    invariant(JSON.stringify(tsWords) === JSON.stringify(marsWords),
      `${segmentName} mismatch; builtin=[${tsWords.join(',')}], official MARS=[${marsWords.join(',')}]`);
  }
  process.stdout.write(`Official MARS 4.5 assembly smoke passed: text=${marsImage.text.length}, data=${marsImage.data.length}, layout=CompactDataAtZero + explicit .text 0x3000.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
