#!/usr/bin/env node
/**
 * Real assembler -> shared production Worker oracle -> bundled Icarus benchmark.
 * Build first: npm run compile
 * Usage: node scripts/benchmark-course-test-concurrency.mjs --cpu-root <RTL directory>
 *   [--profile P6] [--cases 12] [--repeats 3] [--instructions "ori,add,..."]
 *   [--output <evidence.json>] [--exclude-file <relative RTL path>] (repeatable)
 * Each trial starts a fresh Node process/Worker and copies RTL into a fresh workspace.
 * The same deterministic, maximum-size payloads run at concurrency 1, 2 and 4.
 * No artificial delays or oracle/DUT substitutes are used. Only the VS Code shell
 * is replaced with a small real-filesystem adapter, so this excludes UI costs.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const extensionRoot = path.resolve(path.dirname(scriptPath), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const options = parseArguments(args);
if (options.child) {
  await runTrial(options);
} else {
  await runBenchmark(options);
}

function parseArguments(values) {
  const result = {
    profile: 'P6', cases: 12, repeats: 3, excludedFiles: []
  };
  for (let index = 0; index < values.length; index++) {
    const key = values[index];
    if (key === '--child') { result.child = true; continue; }
    const value = values[++index];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === '--cpu-root') result.cpuRoot = path.resolve(value);
    else if (key === '--profile') result.profile = value.toUpperCase();
    else if (key === '--cases') result.cases = Number(value);
    else if (key === '--repeats') result.repeats = Number(value);
    else if (key === '--instructions') result.instructions = value;
    else if (key === '--output') result.output = path.resolve(value);
    else if (key === '--exclude-file') result.excludedFiles.push(value.replaceAll('\\', '/'));
    else if (key === '--concurrency') result.concurrency = Number(value);
    else if (key === '--trial-root') result.trialRoot = path.resolve(value);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!result.cpuRoot) throw new Error('Required: --cpu-root <real RTL directory>');
  if (!['P4', 'P5', 'P6'].includes(result.profile)) throw new Error('Benchmark supports P4/P5/P6 exact-trace lanes; P7 probes need a separate workload.');
  result.instructions ??= result.profile === 'P6'
    ? 'add,sub,and,or,slt,sltu,lui,addi,andi,ori,lb,lh,lw,sb,sh,sw,mult,multu,div,divu,mfhi,mflo,mthi,mtlo,beq,bne,jal,jr'
    : 'add,sub,ori,lui,lw,sw,beq,jal,jr';
  if (!Number.isInteger(result.cases) || result.cases < 4 || result.cases > 128) throw new Error('--cases must be an integer in 4..128');
  if (!Number.isInteger(result.repeats) || result.repeats < 1 || result.repeats > 12) throw new Error('--repeats must be an integer in 1..12');
  return result;
}

async function runBenchmark(config) {
  await fs.access(path.join(extensionRoot, 'out/courseTesting/traceRunner.js'));
  if (!(await fs.readFile(path.join(extensionRoot, 'out/courseTesting/traceRunner.js'), 'utf8')).includes('automaticRunSlot')) {
    throw new Error('Compiled runner lacks isolated automatic slots. Rebuild with npm run compile.');
  }
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'co-concurrency-中文 path-'));
  const trials = [];
  console.log(`Evidence workspace: ${evidenceRoot}`);
  // Rotate order to reduce systematic thermal/cache bias. No warm-up or cache state
  // crosses a trial; all configurations include their first compile/Worker startup.
  for (let repeat = 0; repeat < config.repeats; repeat++) {
    const order = [1, 2, 4];
    for (const concurrency of [...order.slice(repeat % 3), ...order.slice(0, repeat % 3)]) {
      const trialRoot = path.join(evidenceRoot, `repeat-${repeat + 1}-concurrency-${concurrency}`);
      const childArgs = [scriptPath, '--child', '--cpu-root', config.cpuRoot,
        '--profile', config.profile, '--cases', String(config.cases),
        '--instructions', config.instructions, '--concurrency', String(concurrency),
        '--trial-root', trialRoot, ...config.excludedFiles.flatMap((file) => ['--exclude-file', file])];
      const trial = await launchTrial(childArgs);
      trials.push({ repeat: repeat + 1, ...trial });
      console.log(`concurrency=${concurrency} repeat=${repeat + 1}: ${trial.wallMs.toFixed(1)} ms, ${trial.casesPerSecond.toFixed(2)} cases/s, ${trial.passed}/${config.cases} passed`);
    }
  }
  const baseline = trials[0].results;
  const consistency = trials.every((trial) => JSON.stringify(trial.results) === JSON.stringify(baseline));
  const allPassed = trials.every((trial) => trial.passed === config.cases);
  const summary = [1, 2, 4].map((concurrency) => {
    const samples = trials.filter((trial) => trial.concurrency === concurrency);
    return {
      concurrency, medianWallMs: median(samples.map((sample) => sample.wallMs)),
      medianCasesPerSecond: median(samples.map((sample) => sample.casesPerSecond)),
      minWallMs: Math.min(...samples.map((sample) => sample.wallMs)),
      maxWallMs: Math.max(...samples.map((sample) => sample.wallMs)),
      maxHostRssBytes: Math.max(...samples.map((sample) => sample.peakHostRssBytes)),
      compilerInvocations: samples.map((sample) => sample.subprocesses.compiles),
      simulatorInvocations: samples.map((sample) => sample.subprocesses.simulations),
      peakSimulators: Math.max(...samples.map((sample) => sample.subprocesses.peakSimulations)),
      medianHostCpuMs: median(samples.map((sample) => sample.hostCpuUserMs + sample.hostCpuSystemMs)),
      medianAdapterWriteBytes: median(samples.map((sample) => sample.fileOperations.writeBytes))
    };
  });
  for (const row of summary) row.speedup = summary[0].medianWallMs / row.medianWallMs;
  const compiledArtifacts = {};
  for (const file of ['out/courseTesting/concurrentCases.js', 'out/courseTesting/traceRunner.js',
    'out/verilog/iverilogRunner.js', 'out/verilog/iverilogCompileCache.js', 'out/verilog/automaticCompilePool.js',
    'out/mips/host/workerMain.js']) {
    compiledArtifacts[file] = createHash('sha256').update(await fs.readFile(path.join(extensionRoot, file))).digest('hex');
  }
  const evidence = {
    schemaVersion: 1, kind: 'real-course-test-concurrency', generatedAt: new Date().toISOString(),
    environment: { platform: process.platform, release: os.release(), arch: process.arch,
      node: process.version, baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extensionRoot, encoding: 'utf8' }).trim(),
      workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: extensionRoot, encoding: 'utf8' }).trim()),
      buildProvenance: 'Compiled working-tree build, identified by compiledArtifacts hashes; baseCommit alone does not identify the benchmarked implementation.',
      compiledArtifacts, icarusVersion: trials[0].subprocesses.icarusVersion, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
      availableParallelism: os.availableParallelism(), totalMemoryBytes: os.totalmem() },
    workload: { cpuRoot: config.cpuRoot, profile: config.profile, cases: config.cases,
      repeats: config.repeats, instructions: config.instructions, excludedFiles: config.excludedFiles,
      payloadInstructions: 4094, sharedOracleWorkers: 1, rtlFiles: trials[0].rtlFiles,
      rtlSha256: trials[0].rtlSha256, seeds: baseline.map((item) => item.seed) },
    measurement: { includes: ['case capture and manifests', 'real Worker assembly and oracle',
      'bundled Icarus compile/cache lookup and VVP', 'trace/DM comparison and evidence writes'],
      excludes: ['extension activation and VS Code UI', 'RTL copy and payload generation', 'passing-case retention pruning', 'benchmark digest verification'],
      hostCpuScope: 'Node process and its Worker threads; excludes Icarus/VVP child CPU',
      memoryScope: 'sampled Node/Worker RSS; excludes Icarus/VVP child RSS',
      boundary: 'Fixed successful batch throughput; does not measure first-failure stopping latency or P3/P7 workloads.' },
    consistency, allPassed, summary, trials, evidenceRoot
  };
  const output = config.output ?? path.join(evidenceRoot, 'benchmark.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ consistency, allPassed, summary, output }, null, 2));
  if (!consistency || !allPassed) process.exitCode = 1;
}

async function launchTrial(childArgs) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, { cwd: extensionRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Trial exited ${code}: ${stderr}\n${stdout}`));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid trial output: ${stdout}\n${stderr}`)); } }
    });
  });
}

async function runTrial(config) {
  const rtl = await discoverRtl(config.cpuRoot, config.excludedFiles);
  if (!rtl.length) throw new Error(`No Verilog files in ${config.cpuRoot}`);
  await fs.mkdir(config.trialRoot, { recursive: true });
  const rtlHash = createHash('sha256');
  for (const relative of rtl) {
    const bytes = await fs.readFile(path.join(config.cpuRoot, relative));
    rtlHash.update(relative).update('\0').update(bytes);
    const target = path.join(config.trialRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  const fileOperations = installVscodeAdapter(config.trialRoot, config.profile);
  const { generateBuiltinAsmTestCase } = require(path.join(extensionRoot, 'out/courseTesting/builtinAsmGenerator.js'));
  const { createAsmCaseFromText } = require(path.join(extensionRoot, 'out/asmCaseStore.js'));
  const { runCourseTraceCase } = require(path.join(extensionRoot, 'out/courseTesting/traceRunner.js'));
  const { runConcurrentCases } = require(path.join(extensionRoot, 'out/courseTesting/concurrentCases.js'));
  const { MipsRuntimeManager } = require(path.join(extensionRoot, 'out/mips/host/runtimeManager.js'));
  const { iterCpuTraceEvents } = require(path.join(extensionRoot, 'out/language/mips/traceParser.js'));
  const processCore = require(path.join(extensionRoot, 'out/processCore.js'));
  const originalRunProcess = processCore.runProcessCore;
  const subprocesses = { compiles: 0, simulations: 0, preflights: 0, peakSimulations: 0, simulationDirectories: [], icarusVersion: null };
  let activeSimulations = 0;
  processCore.runProcessCore = async function (command, argv, ...rest) {
    const executable = path.basename(command).toLowerCase();
    const simulation = executable === 'vvp' || executable === 'vvp.exe';
    if (simulation) {
      subprocesses.simulations++; activeSimulations++; subprocesses.peakSimulations = Math.max(subprocesses.peakSimulations, activeSimulations);
      const relativeCwd = path.relative(config.trialRoot, rest[0].cwd).replaceAll('\\', '/');
      if (!subprocesses.simulationDirectories.includes(relativeCwd)) subprocesses.simulationDirectories.push(relativeCwd);
    }
    else if (executable === 'iverilog' || executable === 'iverilog.exe') {
      if (argv.includes('-V')) subprocesses.preflights++; else subprocesses.compiles++;
    }
    try {
      const result = await originalRunProcess.call(this, command, argv, ...rest);
      if (argv.includes('-V')) subprocesses.icarusVersion ??= `${result.stdout}\n${result.stderr}`.match(/Icarus Verilog version ([^\r\n]+)/)?.[1] ?? null;
      return result;
    }
    finally { if (simulation) activeSimulations--; }
  };
  const { URI } = require('vscode-uri');
  const manager = new MipsRuntimeManager();
  const messages = [];
  const services = { extensionRoot, mipsRuntime: manager,
    output: { append() {}, appendLine(message) { messages.push(message); }, show() {} }, statusBar: {} };
  const generationStarted = performance.now();
  const programs = Array.from({ length: config.cases }, (_, index) => {
    const seed = `course-concurrency-v1-${index}`;
    return generateBuiltinAsmTestCase({ profile: config.profile, instructionText: config.instructions,
      instructionCount: 4094, seed, generatedAt: new Date('2026-01-01T00:00:00Z'), p7StressMode: 'off' });
  });
  const payloadGenerationMs = performance.now() - generationStarted;
  const rawResults = new Array(config.cases);
  let peakHostRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakHostRssBytes = Math.max(peakHostRssBytes, process.memoryUsage().rss); }, 25);
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  try {
    // Match runGeneratorAndCollectAsms: immutable cases are captured sequentially
    // before the execution scheduler starts; capture cost stays in the measured batch.
    const cases = [];
    for (let index = 0; index < programs.length; index++) {
      cases.push(await createAsmCaseFromText(`benchmark-${index}.asm`, programs[index].text,
        { resource: URI.file(config.trialRoot), source: { kind: 'builtin', generator: 'builtin:random-asm' } }));
    }
    await runConcurrentCases(programs, {
      concurrency: config.concurrency, phase: () => 0, key: (program) => program.seed,
      shouldStop: (result) => result.status !== 'passed',
      completed: async (result, _program, index) => { rawResults[index] = result; },
      run: async (_program, index, slot, signal) => {
        const asmCase = cases[index];
        return await runCourseTraceCase(services, { asm: asmCase.asm, asmCase },
          { source: { kind: 'generator', generator: 'builtin:random-asm' }, artifactOutputMode: 'case', automaticRunSlot: slot, signal });
      }
    });
  } finally {
    clearInterval(sampler);
    manager.dispose();
  }
  const wallMs = performance.now() - started, cpu = process.cpuUsage(cpuStart);
  const traceDigest = async (file) => {
    if (!file) return null;
    const events = [...iterCpuTraceEvents(await fs.readFile(file, 'utf8'))]
      .map(({ pc, kind, target, value }) => ({ pc, kind, target, value }));
    return createHash('sha256').update(JSON.stringify(events)).digest('hex');
  };
  const results = [];
  for (let index = 0; index < programs.length; index++) {
    const result = rawResults[index];
    if (!result) { results.push({ seed: programs[index].seed, status: 'not-started' }); continue; }
    results.push({ seed: programs[index].seed, status: result.status, stage: result.stage,
      machineCodeSha256: result.machineCode ? createHash('sha256').update(await fs.readFile(result.machineCode)).digest('hex') : null,
      oracleTraceSha256: await traceDigest(result.oracleOut), dutTraceSha256: await traceDigest(result.dutOut),
      oracleEvents: result.oracleEvents ?? null, dutEvents: result.dutEvents ?? null,
      ...(result.status !== 'passed' ? { message: result.message, firstDiff: result.firstDiff, dutFailure: result.dutFailure } : {}) });
  }
  process.stdout.write(JSON.stringify({ concurrency: config.concurrency, wallMs,
    casesPerSecond: config.cases * 1000 / wallMs, hostCpuUserMs: cpu.user / 1000, hostCpuSystemMs: cpu.system / 1000,
    peakHostRssBytes, payloadGenerationMs, subprocesses, fileOperations,
    passed: results.filter((item) => item.status === 'passed').length,
    rtlFiles: rtl, rtlSha256: rtlHash.digest('hex'), results,
    ...(results.some((item) => item.status !== 'passed') ? { diagnosticMessages: messages.slice(-15) } : {}) }));
}

async function discoverRtl(root, excludedFiles, relative = '') {
  const files = [];
  const excludedDirectories = new Set(['.co', '.git', '.vscode', 'node_modules', 'out', 'isim', 'xst', 'iseconfig', '_xmsgs']);
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name.toLowerCase())) files.push(...await discoverRtl(root, excludedFiles, next));
    else if (entry.isFile() && /\.(v|vh)$/i.test(entry.name) && !excludedFiles.includes(next)) files.push(next);
  }
  return files.sort();
}

function installVscodeAdapter(workspaceRoot, profile) {
  const { URI, Utils } = require('vscode-uri');
  const folder = { uri: URI.file(workspaceRoot), name: 'benchmark', index: 0 };
  const settings = { 'project.profile': profile, 'project.topModule': 'mips', 'mips.engine': 'builtin' };
  const fileType = (stat) => stat.isSymbolicLink() ? 64 : stat.isDirectory() ? 2 : 1;
  const fileOperations = { scope: 'VS Code workspace.fs adapter only; Node-direct manifest/source/cache operations excluded',
    writes: 0, writeBytes: 0, copies: 0, copyBytes: 0, reads: 0, readBytes: 0 };
  const adapter = {
    Uri: { file: URI.file, parse: URI.parse, joinPath: Utils.joinPath },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    RelativePattern: class { constructor(base, pattern) { this.baseUri = base.uri ?? base; this.pattern = pattern; } },
    workspace: {
      workspaceFolders: [folder], isTrusted: true, textDocuments: [],
      getWorkspaceFolder: () => folder,
      asRelativePath: (uri) => path.relative(workspaceRoot, uri.fsPath ?? uri),
      getConfiguration: () => ({ get: (key) => settings[key], inspect: (key) => ({ workspaceFolderValue: settings[key] }) }),
      saveAll: async () => true,
      findFiles: async (pattern) => {
        const root = pattern.baseUri?.fsPath ?? workspaceRoot;
        return (await discoverRtl(root, [])).filter((file) => file.endsWith('.v')).map((file) => URI.file(path.join(root, file)));
      },
      fs: {
        readFile: async (uri) => { const bytes = await fs.readFile(uri.fsPath); fileOperations.reads++; fileOperations.readBytes += bytes.length; return bytes; },
        writeFile: async (uri, bytes) => { fileOperations.writes++; fileOperations.writeBytes += bytes.length; await fs.writeFile(uri.fsPath, bytes); },
        createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
        stat: async (uri) => { const stat = await fs.lstat(uri.fsPath); return { type: fileType(stat), ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }; },
        readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true })).map((entry) => [entry.name, fileType(entry)]),
        copy: async (from, to) => { fileOperations.copies++; fileOperations.copyBytes += (await fs.stat(from.fsPath)).size; await fs.copyFile(from.fsPath, to.fsPath); }
      }
    },
    window: { activeTextEditor: undefined, showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
    commands: { executeCommand: async () => undefined }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? adapter : originalLoad.call(this, request, parent, isMain);
  };
  return fileOperations;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
