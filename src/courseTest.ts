import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getContinuousIntervalMs,
  getContinuousMaxIterations,
  getContinuousStopOnFailure,
  getGeneratedAsmLimit,
  getGeneratorArgs,
  getJava,
  getPython
} from './config';
import {
  continuousCounts,
  ContinuousCounts,
  ContinuousRunStatus,
  continuousStatus,
  shouldStopAfterIteration
} from './courseTesting/continuous';
import {
  buildGeneratorInvocation,
  changedAsmFiles,
  GeneratorInvocation,
  isSupportedGeneratorFile,
  snapshotAsmFiles
} from './courseTesting/generator';
import {
  logisimPrepSummary,
  LogisimPrepareCaseResult,
  preparedCircuitFileName
} from './courseTesting/logisimPrep';
import {
  compareTraces,
  firstTraceDiffSnapshot,
  TraceDiffResult,
  TraceDiffSnapshot,
  TraceEventSnapshot
} from './language/mips/traceCompare';
import { parseMarsOutput } from './language/mips/traceParser';
import { parseSimOutput } from './language/verilog/traceParser';
import { findLogisimRomTargets, injectMachineCodeIntoLogisimRom, LogisimRomTarget } from './language/logisim/rom';
import { runMarsFile } from './mips';
import { compareTracePair, defaultTraceCompareMode } from './traceCompare';
import { runIsim } from './verilog';
import { AppServices } from './types';
import { ensureDirectory, readTextFile, workspaceFolderFor, writeTextFile } from './fsUtil';
import { runTool } from './process';
import { pickOneFile } from './workflowInputs';

type CourseTraceStatus = 'passed' | 'failed' | 'error';
type CourseTraceStage = 'dump' | 'mars' | 'isim' | 'compare';

const stdinExtensions = ['.in', '.input', '.stdin', '.dat'];
const stdinSubdirectories = ['input', 'inputs', 'test', 'tests', 'data'];

interface CourseTraceCaseResult {
  asm: string;
  stdin?: string;
  status: CourseTraceStatus;
  stage: CourseTraceStage;
  message: string;
  machineCode?: string;
  marsOut?: string;
  simOut?: string;
  firstDiffIndex?: number;
  firstDiff?: TraceDiffSnapshot;
  marsEvents?: number;
  simEvents?: number;
  matchedEvents?: number;
  diffEvents?: number;
}

interface CourseTraceBatchSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
}

interface CourseTraceBatchReport {
  generatedAt: string;
  source?: CourseTraceBatchSource;
  summary: CourseTraceBatchSummary;
  results: CourseTraceCaseResult[];
}

interface CourseTraceCaseInput {
  asm: vscode.Uri;
  stdin?: vscode.Uri;
}

interface CourseTraceBatchSource {
  kind: 'selected' | 'generator';
  generator?: string;
  commandLine?: string;
  cwd?: string;
  asmFiles?: string[];
}

interface GeneratorRunSetup {
  folder: vscode.WorkspaceFolder;
  generator: vscode.Uri;
  invocation: GeneratorInvocation;
}

interface GeneratedAsmBatch {
  asms: vscode.Uri[];
  source: CourseTraceBatchSource;
}

interface LogisimPrepareReport {
  generatedAt: string;
  source: CourseTraceBatchSource;
  circuitTemplate: string;
  romTarget: {
    index: number;
    label?: string;
    loc?: string;
    addrWidth?: number;
    dataWidth?: number;
  };
  summary: ReturnType<typeof logisimPrepSummary>;
  results: LogisimPrepareCaseResult[];
}

interface ContinuousTraceIteration {
  index: number;
  status: ContinuousRunStatus;
  startedAt: string;
  finishedAt?: string;
  source?: CourseTraceBatchSource;
  summary: ContinuousCounts;
  results: CourseTraceCaseResult[];
  message?: string;
}

interface ContinuousTraceReport {
  generatedAt: string;
  running: boolean;
  stopRequested: boolean;
  generator: string;
  commandLine: string;
  cwd: string;
  options: {
    intervalMs: number;
    maxIterations: number;
    stopOnFailure: boolean;
  };
  iterations: ContinuousTraceIteration[];
}

interface ContinuousTraceSession {
  stopRequested: boolean;
  report: ContinuousTraceReport;
  reportFile: vscode.Uri;
  panel: vscode.WebviewPanel;
}

let activeContinuousTraceSession: ContinuousTraceSession | undefined;

export function registerCourseTest(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.test.runFullTest', () => runFullCourseTraceTest(services)),
    vscode.commands.registerCommand('co.test.runBatchTraceTests', () => runBatchCourseTraceTests(services)),
    vscode.commands.registerCommand('co.test.runGeneratedTraceTests', () => runGeneratedCourseTraceTests(services)),
    vscode.commands.registerCommand('co.test.startContinuousGeneratedTraceTests', () => startContinuousGeneratedTraceTests(services)),
    vscode.commands.registerCommand('co.test.stopContinuousTests', () => stopContinuousTests()),
    vscode.commands.registerCommand('co.test.prepareLogisimCases', () => prepareLogisimCases(services)),
    vscode.commands.registerCommand('co.test.prepareGeneratedLogisimCases', () => prepareGeneratedLogisimCases(services)),
    vscode.commands.registerCommand('co.test.openBatchTraceReport', () => openBatchTraceReport())
  );
}

async function runFullCourseTraceTest(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const asm = await resolveAsmInput();
  if (!asm) {
    return;
  }

  const stdin = await resolveSingleStdinInput(asm);
  const result = await runCourseTraceCase(services, { asm, stdin });
  if (result.status === 'error') {
    vscode.window.showErrorMessage(result.message);
    return;
  }
  if (!result.marsOut || !result.simOut) {
    vscode.window.showErrorMessage('Full test stopped before trace outputs were generated.');
    return;
  }

  await compareTracePair(
    {
      mars: vscode.Uri.file(result.marsOut),
      sim: vscode.Uri.file(result.simOut)
    },
    services,
    defaultTraceCompareMode
  );
}

async function runBatchCourseTraceTests(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const cases = await resolveBatchTraceCases();
  if (!cases.length) {
    return;
  }

  await runCourseTraceBatch(services, cases, { kind: 'selected' });
}

async function runGeneratedCourseTraceTests(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const generated = await resolveGeneratedAsmBatch(services);
  if (!generated) {
    return;
  }

  await runCourseTraceBatch(services, expandTraceCases(generated.asms), generated.source);
}

async function startContinuousGeneratedTraceTests(services: AppServices): Promise<void> {
  if (activeContinuousTraceSession) {
    vscode.window.showWarningMessage('A continuous course trace test session is already running.');
    return;
  }

  await vscode.workspace.saveAll(false);
  const setup = await resolveGeneratorRunSetup();
  if (!setup) {
    return;
  }

  const intervalMs = getContinuousIntervalMs(setup.generator);
  const maxIterations = getContinuousMaxIterations(setup.generator);
  const stopOnFailure = getContinuousStopOnFailure(setup.generator);
  const outDir = vscode.Uri.file(path.join(setup.folder.uri.fsPath, '.co', 'out'));
  await ensureDirectory(outDir);
  const reportFile = vscode.Uri.file(path.join(outDir.fsPath, 'continuous-trace-report.json'));
  const panel = vscode.window.createWebviewPanel('coContinuousTraceReport', 'CO Continuous Trace Tests', vscode.ViewColumn.Beside, {
    enableScripts: false,
    retainContextWhenHidden: true
  });
  const session: ContinuousTraceSession = {
    stopRequested: false,
    reportFile,
    panel,
    report: {
      generatedAt: new Date().toISOString(),
      running: true,
      stopRequested: false,
      generator: setup.generator.fsPath,
      commandLine: [setup.invocation.command, ...setup.invocation.args].join(' '),
      cwd: setup.invocation.cwd,
      options: {
        intervalMs,
        maxIterations,
        stopOnFailure
      },
      iterations: []
    }
  };
  activeContinuousTraceSession = session;
  panel.onDidDispose(() => {
    session.stopRequested = true;
  });

  services.output.show(true);
  services.output.appendLine('');
  services.output.appendLine('Starting continuous generated course trace tests.');
  services.output.appendLine(`Generator: ${setup.generator.fsPath}`);
  services.output.appendLine(`Interval: ${intervalMs} ms, max iterations: ${maxIterations || 'unlimited'}, stop on failure: ${stopOnFailure}`);

  try {
    await updateContinuousTraceMonitor(session);
    let index = 0;
    while (!session.stopRequested && (maxIterations === 0 || index < maxIterations)) {
      index++;
      services.statusBar.text = `CO: Continuous #${index}`;
      const iteration: ContinuousTraceIteration = {
        index,
        status: 'running',
        startedAt: new Date().toISOString(),
        summary: continuousCounts([]),
        results: []
      };
      session.report.iterations.unshift(iteration);
      await updateContinuousTraceMonitor(session);

      services.output.appendLine('');
      services.output.appendLine(`Continuous iteration #${index}`);
      try {
        const generated = await runGeneratorAndCollectAsms(services, setup);
        if (!generated?.asms.length) {
          iteration.status = 'error';
          iteration.message = 'Generator finished but no new or modified ASM files were detected.';
          services.output.appendLine(iteration.message);
        } else {
          iteration.source = generated.source;
          const cases = expandTraceCases(generated.asms);
          for (let i = 0; i < cases.length; i++) {
            if (session.stopRequested) {
              break;
            }
            const item = cases[i];
            services.output.appendLine(`[iteration ${index}, case ${i + 1}/${cases.length}] ${item.asm.fsPath}`);
            try {
              iteration.results.push(await runCourseTraceCase(services, item));
            } catch (error) {
              iteration.results.push({
                asm: item.asm.fsPath,
                stdin: item.stdin?.fsPath,
                status: 'error',
                stage: 'compare',
                message: error instanceof Error ? error.message : String(error)
              });
            }
            iteration.summary = continuousCounts(iteration.results);
            iteration.status = continuousStatus(iteration.results, true, session.stopRequested);
            await updateContinuousTraceMonitor(session);
          }
          iteration.summary = continuousCounts(iteration.results);
          iteration.status = continuousStatus(iteration.results, false, session.stopRequested);
        }
      } catch (error) {
        iteration.status = 'error';
        iteration.message = error instanceof Error ? error.message : String(error);
      }

      iteration.finishedAt = new Date().toISOString();
      iteration.summary = continuousCounts(iteration.results);
      if (iteration.status === 'running') {
        iteration.status = continuousStatus(iteration.results, false, session.stopRequested);
      }
      await updateContinuousTraceMonitor(session);

      if (session.stopRequested || shouldStopAfterIteration(iteration.results, stopOnFailure) || iteration.status === 'error') {
        break;
      }
      await delay(intervalMs);
    }
  } finally {
    session.report.running = false;
    session.report.stopRequested = session.stopRequested;
    services.statusBar.text = 'CO: Continuous stopped';
    await updateContinuousTraceMonitor(session);
    if (activeContinuousTraceSession === session) {
      activeContinuousTraceSession = undefined;
    }
  }
}

function stopContinuousTests(): void {
  if (!activeContinuousTraceSession) {
    vscode.window.showInformationMessage('No continuous course test session is running.');
    return;
  }
  activeContinuousTraceSession.stopRequested = true;
  activeContinuousTraceSession.report.stopRequested = true;
  vscode.window.showInformationMessage('Stopping continuous course tests after the current tool run finishes.');
}

async function runCourseTraceBatch(
  services: AppServices,
  cases: CourseTraceCaseInput[],
  source: CourseTraceBatchSource
): Promise<void> {
  services.output.show(true);
  services.output.appendLine('');
  const sourceLabel = source.kind === 'generator' ? 'Generated course trace test' : 'Batch course trace test';
  services.output.appendLine(`${sourceLabel}: ${cases.length} case(s)`);

  const results: CourseTraceCaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[i];
    const asm = item.asm;
    services.output.appendLine('');
    services.output.appendLine(`[${i + 1}/${cases.length}] ${asm.fsPath}`);
    if (item.stdin) {
      services.output.appendLine(`stdin: ${item.stdin.fsPath}`);
    }
    try {
      results.push(await runCourseTraceCase(services, item));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        asm: asm.fsPath,
        stdin: item.stdin?.fsPath,
        status: 'error',
        stage: 'compare',
        message
      });
    }
  }

  const report = await writeBatchTraceReport(cases[0].asm, results, source);
  showBatchTraceReport(results, report, undefined, source);

  const summary = batchSummary(results);
  const passed = summary.passed;
  const failed = summary.failed;
  const errors = summary.errors;
  const message = `Batch trace test finished: ${passed} passed, ${failed} failed, ${errors} errors.`;
  if (failed || errors) {
    vscode.window.showWarningMessage(message);
  } else {
    vscode.window.showInformationMessage(message);
  }
}

async function prepareLogisimCases(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const asms = await resolveAsmBatchInputs();
  if (!asms.length) {
    return;
  }
  await runLogisimPrepareBatch(services, asms, { kind: 'selected', asmFiles: asms.map((uri) => uri.fsPath) });
}

async function prepareGeneratedLogisimCases(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const generated = await resolveGeneratedAsmBatch(services);
  if (!generated) {
    return;
  }
  await runLogisimPrepareBatch(services, generated.asms, generated.source);
}

async function runLogisimPrepareBatch(
  services: AppServices,
  asms: vscode.Uri[],
  source: CourseTraceBatchSource
): Promise<void> {
  const circuit = await resolveLogisimCircuitInput();
  if (!circuit) {
    return;
  }

  const circuitText = await readTextFile(circuit);
  const target = await resolveLogisimRomTarget(circuitText);
  if (!target) {
    return;
  }

  const folder = workspaceFolderFor(circuit) ?? workspaceFolderFor(asms[0]) ?? vscode.workspace.workspaceFolders?.[0];
  const baseDir = folder?.uri.fsPath ?? path.dirname(circuit.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, '.co', 'logisim'));
  await ensureDirectory(outDir);

  services.output.show(true);
  services.output.appendLine('');
  services.output.appendLine(`Prepare Logisim circuit cases: ${asms.length} case(s)`);
  services.output.appendLine(`Circuit: ${circuit.fsPath}`);
  services.output.appendLine(`ROM: ${target.label ?? 'ROM'}${target.loc ? ` ${target.loc}` : ''}`);

  const results: LogisimPrepareCaseResult[] = [];
  for (let i = 0; i < asms.length; i++) {
    const asm = asms[i];
    services.output.appendLine('');
    services.output.appendLine(`[${i + 1}/${asms.length}] ${asm.fsPath}`);

    try {
      const dump = await runMarsFile(services, asm, 'dumpText', { showMessages: false });
      if (!dump?.result.ok || !dump.outputFile) {
        results.push({
          asm: asm.fsPath,
          status: 'error',
          message: 'MARS failed to dump machine code.'
        });
        continue;
      }

      const machineCodeText = await readTextFile(dump.outputFile);
      const injected = injectMachineCodeIntoLogisimRom(circuitText, machineCodeText, target.index);
      const outFile = vscode.Uri.file(path.join(
        outDir.fsPath,
        preparedCircuitFileName(circuit.fsPath, asm.fsPath, baseDir)
      ));
      await writeTextFile(outFile, injected.text);
      results.push({
        asm: asm.fsPath,
        status: 'prepared',
        message: `${injected.wordCount} machine-code word(s) injected.`,
        machineCode: dump.outputFile.fsPath,
        circuit: outFile.fsPath,
        wordCount: injected.wordCount
      });
      services.output.appendLine(`Prepared circuit: ${outFile.fsPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        asm: asm.fsPath,
        status: 'error',
        message
      });
    }
  }

  const report = await writeLogisimPrepareReport(circuit, target, results, source, outDir);
  showLogisimPrepareReport(report, results, source, circuit, target);
  const summary = logisimPrepSummary(results);
  const message = `Logisim case preparation finished: ${summary.prepared} prepared, ${summary.errors} errors.`;
  if (summary.errors) {
    vscode.window.showWarningMessage(message);
  } else {
    vscode.window.showInformationMessage(message);
  }
}

async function openBatchTraceReport(): Promise<void> {
  const report = await resolveBatchTraceReport();
  if (!report) {
    return;
  }
  const text = await readTextFile(report);
  let parsed: CourseTraceBatchReport;
  try {
    parsed = JSON.parse(text) as CourseTraceBatchReport;
  } catch {
    vscode.window.showErrorMessage('Selected batch trace report is not valid JSON.');
    return;
  }
  if (!Array.isArray(parsed.results)) {
    vscode.window.showErrorMessage('Selected batch trace report does not contain a results array.');
    return;
  }
  showBatchTraceReport(parsed.results, report, parsed.generatedAt, parsed.source);
}

async function runCourseTraceCase(services: AppServices, item: CourseTraceCaseInput): Promise<CourseTraceCaseResult> {
  const asm = item.asm;
  services.output.appendLine('Full course trace test');
  services.output.appendLine(`ASM: ${asm.fsPath}`);
  if (item.stdin) {
    services.output.appendLine(`stdin: ${item.stdin.fsPath}`);
  }

  const dump = await runMarsFile(services, asm, 'dumpText', { showMessages: false });
  if (!dump?.result.ok || !dump.outputFile) {
    return failedCase(item, 'dump', 'Full test stopped because MARS failed to dump machine code.');
  }
  services.output.appendLine(`Machine code: ${dump.outputFile.fsPath}`);

  const stdinText = item.stdin ? await readTextFile(item.stdin) : undefined;
  const mars = await runMarsFile(services, asm, 'run', {
    showMessages: false,
    stdin: stdinText,
    stdinSource: item.stdin
  });
  if (!mars?.result.ok || !mars.outputFile) {
    return failedCase(item, 'mars', 'Full test stopped because MARS golden-model run failed.', dump.outputFile);
  }

  const isim = await runIsim(services, {
    resource: asm,
    showMessages: false,
    machineCodeSource: dump.outputFile
  });
  if (!isim?.simResult.ok || !isim.simOut) {
    return failedCase(item, 'isim', 'Full test stopped because ISim failed.', dump.outputFile, mars.outputFile);
  }

  const marsText = await readTextFile(mars.outputFile);
  const simText = await readTextFile(isim.simOut);
  const marsEvents = parseMarsOutput(marsText);
  const simEvents = parseSimOutput(simText);
  const diff = compareTraces(marsEvents, simEvents, { compareCycles: defaultTraceCompareMode.compareCycles });

  if (!marsEvents.length || !simEvents.length) {
    return {
      asm: asm.fsPath,
      stdin: item.stdin?.fsPath,
      status: 'error',
      stage: 'compare',
      message: 'One side had no parseable trace events.',
      machineCode: dump.outputFile.fsPath,
      marsOut: mars.outputFile.fsPath,
      simOut: isim.simOut.fsPath,
      marsEvents: marsEvents.length,
      simEvents: simEvents.length,
      matchedEvents: diff.summary.matchedEvents,
      diffEvents: diff.summary.diffEvents
    };
  }

  return {
    asm: asm.fsPath,
    stdin: item.stdin?.fsPath,
    status: diff.matched ? 'passed' : 'failed',
    stage: 'compare',
    message: diffMessage(diff),
    machineCode: dump.outputFile.fsPath,
    marsOut: mars.outputFile.fsPath,
    simOut: isim.simOut.fsPath,
    firstDiffIndex: diff.firstDiffIndex >= 0 ? diff.firstDiffIndex : undefined,
    firstDiff: firstTraceDiffSnapshot(diff),
    marsEvents: diff.summary.marsEvents,
    simEvents: diff.summary.simEvents,
    matchedEvents: diff.summary.matchedEvents,
    diffEvents: diff.summary.diffEvents
  };
}

async function resolveAsmInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file' && isAsmFile(editor.document.uri)) {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }

  const files = await vscode.workspace.findFiles('**/*.{asm,s,mips}', '**/{node_modules,out,.git}/**', 200);
  if (files.length === 1) {
    return files[0];
  }
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: 'Select MIPS ASM file for the course trace test',
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return await pickOneFile('Select MIPS ASM file for the course trace test', {
    ASM: ['asm', 's', 'mips'],
    All: ['*']
  });
}

async function resolveAsmBatchInputs(): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles('**/*.{asm,s,mips}', '**/{node_modules,out,.git,.co}/**', 500);
  if (files.length) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: 'Select MIPS ASM files for batch trace testing',
        matchOnDescription: true,
        canPickMany: true
      }
    );
    return picked?.map((item) => item.uri) ?? [];
  }

  const picked = await vscode.window.showOpenDialog({
    title: 'Select MIPS ASM files for batch trace testing',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    filters: {
      ASM: ['asm', 's', 'mips'],
      All: ['*']
    }
  });
  return picked ?? [];
}

async function resolveSingleStdinInput(asm: vscode.Uri): Promise<vscode.Uri | undefined> {
  const candidates = findStdinCandidatesForAsm(asm);
  if (!candidates.length) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: 'No stdin',
        description: 'Run without stdin',
        uri: undefined
      },
      ...candidates.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      }))
    ],
    {
      title: 'Select stdin file for this ASM case',
      matchOnDescription: true
    }
  );
  return picked?.uri;
}

async function resolveBatchTraceCases(): Promise<CourseTraceCaseInput[]> {
  const asms = await resolveAsmBatchInputs();
  return expandTraceCases(asms);
}

async function resolveGeneratedAsmBatch(services: AppServices): Promise<GeneratedAsmBatch | undefined> {
  const setup = await resolveGeneratorRunSetup();
  if (!setup) {
    return undefined;
  }
  const generated = await runGeneratorAndCollectAsms(services, setup);
  if (generated) {
    return generated;
  }

  const choice = await vscode.window.showWarningMessage(
    'The generator finished, but no new or modified ASM files were detected.',
    'Pick ASM Files'
  );
  if (choice !== 'Pick ASM Files') {
    return undefined;
  }
  const picked = await resolveAsmBatchInputs();
  if (!picked.length) {
    return undefined;
  }
  return {
    asms: picked,
    source: {
      kind: 'generator',
      generator: setup.generator.fsPath,
      commandLine: [setup.invocation.command, ...setup.invocation.args].join(' '),
      cwd: setup.invocation.cwd,
      asmFiles: picked.map((uri) => uri.fsPath)
    }
  };
}

async function resolveGeneratorRunSetup(): Promise<GeneratorRunSetup | undefined> {
  const folder = workspaceFolderFor(vscode.window.activeTextEditor?.document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('Open a workspace folder before running a test generator.');
    return undefined;
  }

  const generator = await resolveGeneratorInput(folder);
  if (!generator) {
    return undefined;
  }

  const invocation = buildGeneratorInvocation(generator.fsPath, {
    python: getPython(generator),
    java: getJava(generator),
    cwd: path.dirname(generator.fsPath),
    extraArgs: getGeneratorArgs(generator)
  });
  if (!invocation) {
    vscode.window.showErrorMessage(`Unsupported test generator type: ${path.extname(generator.fsPath) || '(no extension)'}.`);
    return undefined;
  }

  return { folder, generator, invocation };
}

async function runGeneratorAndCollectAsms(
  services: AppServices,
  setup: GeneratorRunSetup
): Promise<GeneratedAsmBatch | undefined> {
  const before = snapshotAsmFiles(setup.folder.uri.fsPath);
  services.output.show(true);
  services.output.appendLine('');
  services.output.appendLine(`Running test generator: ${setup.generator.fsPath}`);
  const result = await runTool(setup.invocation.command, setup.invocation.args, {
    cwd: setup.invocation.cwd,
    output: services.output,
    resource: setup.generator
  });
  if (!result.ok) {
    vscode.window.showErrorMessage('Test generator failed. Check the BUAA CO output panel.');
    return undefined;
  }

  const after = snapshotAsmFiles(setup.folder.uri.fsPath);
  const generated = changedAsmFiles(before, after, getGeneratedAsmLimit(setup.generator)).map((file) => vscode.Uri.file(file));
  const source: CourseTraceBatchSource = {
    kind: 'generator',
    generator: setup.generator.fsPath,
    commandLine: result.commandLine,
    cwd: result.cwd,
    asmFiles: generated.map((uri) => uri.fsPath)
  };
  if (generated.length) {
    return { asms: generated, source };
  }
  return undefined;
}

function expandTraceCases(asms: vscode.Uri[]): CourseTraceCaseInput[] {
  const cases: CourseTraceCaseInput[] = [];
  for (const asm of asms) {
    const stdinFiles = findStdinCandidatesForAsm(asm);
    if (!stdinFiles.length) {
      cases.push({ asm });
      continue;
    }
    for (const stdin of stdinFiles) {
      cases.push({ asm, stdin });
    }
  }
  return cases;
}

async function resolveGeneratorInput(folder: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file' && isSupportedGeneratorFile(editor.document.uri.fsPath)) {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*.{py,js,mjs,cjs,jar,bat,cmd,exe,ps1}'),
    '**/{node_modules,out,.git,.co}/**',
    200
  );
  if (files.length === 1) {
    return files[0];
  }
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: 'Select random test generator',
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return await pickOneFile('Select random test generator', {
    Generator: ['py', 'js', 'mjs', 'cjs', 'jar', 'bat', 'cmd', 'exe', 'ps1'],
    All: ['*']
  });
}

async function resolveLogisimCircuitInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && isLogisimCircuitFile(editor.document.uri)) {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }

  const files = await vscode.workspace.findFiles('**/*.circ', '**/{node_modules,out,.git,.co}/**', 200);
  if (files.length === 1) {
    return files[0];
  }
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: 'Select Logisim circuit template',
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return await pickOneFile('Select Logisim circuit template', {
    Logisim: ['circ'],
    All: ['*']
  });
}

function isLogisimCircuitFile(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.circ';
}

async function resolveLogisimRomTarget(circuitText: string): Promise<LogisimRomTarget | undefined> {
  const candidates = findLogisimRomTargets(circuitText)
    .filter((target) => target.dataWidth === undefined || target.dataWidth === 32);
  if (!candidates.length) {
    vscode.window.showErrorMessage('No 32-bit ROM component was found in the selected Logisim circuit.');
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((target) => ({
      label: target.label ? `${target.index}: ${target.label}` : `${target.index}: ROM`,
      description: [
        target.loc ? `loc ${target.loc}` : undefined,
        target.addrWidth ? `addr ${target.addrWidth}` : undefined,
        target.dataWidth ? `data ${target.dataWidth}` : undefined,
        target.hasContents ? 'has contents' : 'empty'
      ].filter(Boolean).join(' | '),
      target
    })),
    {
      title: 'Select Logisim ROM to inject machine code'
    }
  );
  return picked?.target;
}

function findStdinCandidatesForAsm(asm: vscode.Uri): vscode.Uri[] {
  const asmDir = path.dirname(asm.fsPath);
  const asmStem = path.basename(asm.fsPath, path.extname(asm.fsPath)).toLowerCase();
  const candidates: { file: string; rank: number }[] = [];

  for (const directory of stdinSearchDirectories(asmDir)) {
    for (const entry of safeReadDirectory(directory.path)) {
      if (!entry.isFile()) {
        continue;
      }
      const rank = stdinNameRank(entry.name, asmStem);
      if (rank < 0) {
        continue;
      }
      candidates.push({
        file: path.join(directory.path, entry.name),
        rank: directory.rank + rank
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((left, right) => left.rank - right.rank || left.file.localeCompare(right.file))
    .filter((item) => {
      const normalized = path.normalize(item.file).toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    })
    .map((item) => vscode.Uri.file(item.file));
}

function stdinSearchDirectories(asmDir: string): Array<{ path: string; rank: number }> {
  const directories = [{ path: asmDir, rank: 0 }];
  for (let i = 0; i < stdinSubdirectories.length; i++) {
    const candidate = path.join(asmDir, stdinSubdirectories[i]);
    if (safeIsDirectory(candidate)) {
      directories.push({ path: candidate, rank: (i + 1) * 100 });
    }
  }
  return directories;
}

function stdinNameRank(fileName: string, asmStem: string): number {
  const extension = path.extname(fileName).toLowerCase();
  const extensionRank = stdinExtensions.indexOf(extension);
  if (extensionRank < 0) {
    return -1;
  }

  const stem = path.basename(fileName, path.extname(fileName)).toLowerCase();
  if (stem === asmStem) {
    return extensionRank;
  }
  if (stem.startsWith(`${asmStem}.`)) {
    return 10 + extensionRank;
  }
  if (stem.startsWith(`${asmStem}-`)) {
    return 20 + extensionRank;
  }
  if (stem.startsWith(`${asmStem}_`)) {
    return 30 + extensionRank;
  }
  return -1;
}

function safeReadDirectory(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeIsDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function failedCase(
  item: CourseTraceCaseInput,
  stage: CourseTraceStage,
  message: string,
  machineCode?: vscode.Uri,
  marsOut?: vscode.Uri
): CourseTraceCaseResult {
  return {
    asm: item.asm.fsPath,
    stdin: item.stdin?.fsPath,
    status: 'error',
    stage,
    message,
    machineCode: machineCode?.fsPath,
    marsOut: marsOut?.fsPath
  };
}

function diffMessage(diff: TraceDiffResult): string {
  if (diff.matched) {
    return `${diff.summary.matchedEvents} events matched.`;
  }
  const first = diff.entries[diff.firstDiffIndex];
  return `First difference at event #${diff.firstDiffIndex + 1}: ${first.reason ?? first.status}.`;
}

async function writeBatchTraceReport(
  firstAsm: vscode.Uri,
  results: CourseTraceCaseResult[],
  source: CourseTraceBatchSource
): Promise<vscode.Uri> {
  const folder = workspaceFolderFor(firstAsm) ?? vscode.workspace.workspaceFolders?.[0];
  const baseDir = folder?.uri.fsPath ?? path.dirname(firstAsm.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, '.co', 'out'));
  await ensureDirectory(outDir);
  const report = vscode.Uri.file(path.join(outDir.fsPath, 'trace-batch-report.json'));
  await writeTextFile(report, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source,
    summary: batchSummary(results),
    results
  }, null, 2) + '\n');
  return report;
}

async function writeLogisimPrepareReport(
  circuit: vscode.Uri,
  target: LogisimRomTarget,
  results: LogisimPrepareCaseResult[],
  source: CourseTraceBatchSource,
  outDir: vscode.Uri
): Promise<vscode.Uri> {
  const report = vscode.Uri.file(path.join(outDir.fsPath, 'logisim-prep-report.json'));
  const data: LogisimPrepareReport = {
    generatedAt: new Date().toISOString(),
    source,
    circuitTemplate: circuit.fsPath,
    romTarget: {
      index: target.index,
      label: target.label,
      loc: target.loc,
      addrWidth: target.addrWidth,
      dataWidth: target.dataWidth
    },
    summary: logisimPrepSummary(results),
    results
  };
  await writeTextFile(report, JSON.stringify(data, null, 2) + '\n');
  return report;
}

async function updateContinuousTraceMonitor(session: ContinuousTraceSession): Promise<void> {
  session.report.stopRequested = session.stopRequested;
  session.report.generatedAt = new Date().toISOString();
  await writeTextFile(session.reportFile, JSON.stringify(session.report, null, 2) + '\n');
  try {
    session.panel.webview.html = renderContinuousTraceMonitor(session.report, session.reportFile);
  } catch {
    session.stopRequested = true;
  }
}

async function resolveBatchTraceReport(): Promise<vscode.Uri | undefined> {
  const folder = workspaceFolderFor(vscode.window.activeTextEditor?.document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const matches = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/.co/out/trace-batch-report.json'),
      undefined,
      20
    );
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      const picked = await vscode.window.showQuickPick(
        matches.map((uri) => ({
          label: vscode.workspace.asRelativePath(uri),
          description: path.dirname(uri.fsPath),
          uri
        })),
        {
          title: 'Select batch trace report',
          matchOnDescription: true
        }
      );
      return picked?.uri;
    }
  }
  return await pickOneFile('Select batch trace report JSON', {
    JSON: ['json'],
    All: ['*']
  });
}

function renderContinuousTraceMonitor(report: ContinuousTraceReport, reportFile: vscode.Uri): string {
  const latest = report.iterations[0];
  const latestSummary = latest?.summary ?? continuousCounts([]);
  const rows = report.iterations.map((iteration) => {
    const firstProblem = iteration.results.find((item) => item.status !== 'passed');
    return `<tr class="${iteration.status}">
      <td>${iteration.index}</td>
      <td>${iteration.status.toUpperCase()}</td>
      <td>${escapeHtml(iteration.startedAt)}</td>
      <td>${iteration.finishedAt ? escapeHtml(iteration.finishedAt) : ''}</td>
      <td>${iteration.summary.total}</td>
      <td>${iteration.summary.passed}</td>
      <td>${iteration.summary.failed}</td>
      <td>${iteration.summary.errors}</td>
      <td>${firstProblem ? escapeHtml(path.basename(firstProblem.asm)) : ''}</td>
      <td>${firstProblem ? escapeHtml(firstProblem.message) : escapeHtml(iteration.message ?? '')}</td>
    </tr>`;
  }).join('\n');
  const state = report.running ? (report.stopRequested ? 'Stopping' : 'Running') : 'Stopped';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 7px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
    }
    .passed td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .failed td:nth-child(2), .error td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    .running td:nth-child(2), .stopped td:nth-child(2) {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>CO Continuous Trace Tests</h1>
  <div class="summary">
    <div class="metric"><span>State</span><strong>${escapeHtml(state)}</strong></div>
    <div class="metric"><span>Iterations</span><strong>${report.iterations.length}</strong></div>
    <div class="metric"><span>Latest passed</span><strong>${latestSummary.passed}</strong></div>
    <div class="metric"><span>Latest failed</span><strong>${latestSummary.failed}</strong></div>
    <div class="metric"><span>Latest errors</span><strong>${latestSummary.errors}</strong></div>
  </div>
  <div class="paths">
    <div>Generator: <code>${escapeHtml(report.generator)}</code></div>
    <div>Command: <code>${escapeHtml(report.commandLine)}</code></div>
    <div>CWD: <code>${escapeHtml(report.cwd)}</code></div>
    <div>Options: interval ${report.options.intervalMs} ms, max ${report.options.maxIterations || 'unlimited'}, stop on failure ${report.options.stopOnFailure}</div>
    <div>JSON report: <code>${escapeHtml(reportFile.fsPath)}</code></div>
  </div>
  <table>
    <thead>
      <tr><th>#</th><th>Status</th><th>Started</th><th>Finished</th><th>Total</th><th>Passed</th><th>Failed</th><th>Errors</th><th>First Problem</th><th>Message</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function showLogisimPrepareReport(
  report: vscode.Uri,
  results: LogisimPrepareCaseResult[],
  source: CourseTraceBatchSource,
  circuit: vscode.Uri,
  target: LogisimRomTarget
): void {
  const panel = vscode.window.createWebviewPanel('coLogisimPrepareReport', 'CO Logisim Case Preparation', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderLogisimPrepareReport(report, results, source, circuit, target);
}

function showBatchTraceReport(
  results: CourseTraceCaseResult[],
  report: vscode.Uri,
  generatedAt?: string,
  source?: CourseTraceBatchSource
): void {
  const panel = vscode.window.createWebviewPanel('coBatchTraceReport', 'CO Batch Trace Test', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderBatchTraceReport(results, report, generatedAt, source);
}

function renderBatchTraceReport(
  results: CourseTraceCaseResult[],
  report: vscode.Uri,
  generatedAt?: string,
  source?: CourseTraceBatchSource
): string {
  const summary = batchSummary(results);
  const rows = results.map((item, index) => `<tr class="${item.status}">
    <td>${index + 1}</td>
    <td>${item.status.toUpperCase()}</td>
    <td>${escapeHtml(path.basename(item.asm))}</td>
    <td>${item.stdin ? escapeHtml(path.basename(item.stdin)) : ''}</td>
    <td>${escapeHtml(item.stage)}</td>
    <td>${item.firstDiffIndex === undefined ? '' : item.firstDiffIndex + 1}</td>
    <td>${renderFirstDiffSummary(item)}</td>
    <td>${escapeHtml(summaryText(item))}</td>
    <td>${escapeHtml(item.message)}</td>
  </tr>`).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 7px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
    }
    .passed td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .failed td:nth-child(2), .error td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>CO Batch Trace Test</h1>
  <div class="summary">
    <div class="metric"><span>Total</span><strong>${summary.total}</strong></div>
    <div class="metric"><span>Passed</span><strong>${summary.passed}</strong></div>
    <div class="metric"><span>Failed</span><strong>${summary.failed}</strong></div>
    <div class="metric"><span>Errors</span><strong>${summary.errors}</strong></div>
  </div>
  ${generatedAt ? `<div class="paths">Generated: <code>${escapeHtml(generatedAt)}</code></div>` : ''}
  ${renderBatchSource(source)}
  <div class="paths">JSON report: <code>${escapeHtml(report.fsPath)}</code></div>
  <table>
    <thead>
      <tr><th>#</th><th>Status</th><th>ASM</th><th>Input</th><th>Stage</th><th>First Diff</th><th>First Diff Detail</th><th>Events</th><th>Message</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function renderLogisimPrepareReport(
  report: vscode.Uri,
  results: LogisimPrepareCaseResult[],
  source: CourseTraceBatchSource,
  circuit: vscode.Uri,
  target: LogisimRomTarget
): string {
  const summary = logisimPrepSummary(results);
  const rows = results.map((item, index) => `<tr class="${item.status}">
    <td>${index + 1}</td>
    <td>${item.status.toUpperCase()}</td>
    <td>${escapeHtml(path.basename(item.asm))}</td>
    <td>${item.wordCount ?? ''}</td>
    <td>${item.circuit ? `<code>${escapeHtml(item.circuit)}</code>` : ''}</td>
    <td>${escapeHtml(item.message)}</td>
  </tr>`).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 7px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
    }
    .prepared td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .error td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>CO Logisim Case Preparation</h1>
  <div class="summary">
    <div class="metric"><span>Total</span><strong>${summary.total}</strong></div>
    <div class="metric"><span>Prepared</span><strong>${summary.prepared}</strong></div>
    <div class="metric"><span>Errors</span><strong>${summary.errors}</strong></div>
  </div>
  ${renderBatchSource(source)}
  <div class="paths">
    <div>Circuit template: <code>${escapeHtml(circuit.fsPath)}</code></div>
    <div>ROM target: <code>${escapeHtml(target.label ?? 'ROM')} #${target.index}${target.loc ? ` ${target.loc}` : ''}</code></div>
    <div>JSON report: <code>${escapeHtml(report.fsPath)}</code></div>
  </div>
  <table>
    <thead>
      <tr><th>#</th><th>Status</th><th>ASM</th><th>Words</th><th>Prepared Circuit</th><th>Message</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function renderBatchSource(source: CourseTraceBatchSource | undefined): string {
  if (!source) {
    return '';
  }
  if (source.kind !== 'generator') {
    return '<div class="paths">Source: selected ASM files</div>';
  }
  const asmCount = source.asmFiles?.length ?? 0;
  return `<div class="paths">
    <div>Source: generated ASM files${asmCount ? ` (${asmCount})` : ''}</div>
    ${source.generator ? `<div>Generator: <code>${escapeHtml(source.generator)}</code></div>` : ''}
    ${source.commandLine ? `<div>Command: <code>${escapeHtml(source.commandLine)}</code></div>` : ''}
    ${source.cwd ? `<div>CWD: <code>${escapeHtml(source.cwd)}</code></div>` : ''}
  </div>`;
}

function batchSummary(results: CourseTraceCaseResult[]): CourseTraceBatchSummary {
  return {
    total: results.length,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    errors: results.filter((item) => item.status === 'error').length
  };
}

function summaryText(item: CourseTraceCaseResult): string {
  if (item.marsEvents === undefined || item.simEvents === undefined) {
    return '';
  }
  return `MARS ${item.marsEvents}, SIM ${item.simEvents}, matched ${item.matchedEvents ?? 0}, diff ${item.diffEvents ?? 0}`;
}

function renderFirstDiffSummary(item: CourseTraceCaseResult): string {
  if (!item.firstDiff) {
    return '';
  }
  const reason = item.firstDiff.reason ?? item.firstDiff.status;
  return [
    `<div>${escapeHtml(reason)}</div>`,
    `<div><code>MARS ${escapeHtml(traceEventSummary(item.firstDiff.mars))}</code></div>`,
    `<div><code>SIM ${escapeHtml(traceEventSummary(item.firstDiff.sim))}</code></div>`
  ].join('');
}

function traceEventSummary(event: TraceEventSnapshot | undefined): string {
  if (!event) {
    return '(missing)';
  }
  const cycle = event.cycle === undefined ? '' : `${event.cycle}@`;
  const target = event.kind === 'grf' ? `$${event.target}` : `*${event.target}`;
  return `${cycle}${event.pc}: ${target} <= ${event.value} (line ${event.lineNumber})`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isAsmFile(uri: vscode.Uri): boolean {
  const ext = path.extname(uri.fsPath).toLowerCase();
  return ext === '.asm' || ext === '.s' || ext === '.mips';
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
