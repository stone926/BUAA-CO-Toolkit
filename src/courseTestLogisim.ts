import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getJava,
  getLogisimJar,
  getLogisimTraceColumns,
  getLogisimTraceMainCircuit,
  getMemoryConfiguration,
  getRunTimeout,
  showCommandBeforeRun
} from './config';
import {
  analyzeP3LogisimTraceCircuit,
  createLogisimPcProgressState,
  defaultLogisimTraceCircuit,
  formatLogisimTraceEvents,
  formatP3LogisimTraceDiagnostic,
  inspectLogisimPcProgress,
  LogisimTraceColumnMap,
  LogisimTraceSpec,
  p3LogisimMaxWords,
  parseLogisimTraceOutput,
  parseLogisimTraceSpec,
  P3LogisimMachineCode,
  prepareP3LogisimMachineCode,
  setLogisimMainCircuit,
  validateP3LogisimFetchTrace
} from './courseTesting/logisimTrace';
import {
  logisimPrepSummary,
  LogisimPrepareCaseResult,
  preparedCircuitFileName
} from './courseTesting/logisimPrep';
import { ensureDirectory, readTextFile, workspaceFolderFor, writeTextFile } from './fsUtil';
import {
  findLogisimRomTargets,
  injectMachineCodeIntoLogisimRom,
  LogisimRomTarget,
  parseMachineCodeWords
} from './language/logisim/rom';
import { compareTraceIterables, firstTraceDiffSnapshot } from './language/mips/traceCompare';
import { iterCpuTraceEvents } from './language/mips/traceParser';
import { commandLine, revealOutputChannel } from './process';
import { checkToolchain } from './toolchain';
import { LineChunkScanner, TextChunkAccumulator } from './textChunks';
import { AppServices, RunResult } from './types';
import { pickOneFile } from './workflowInputs';
import { courseTraceMemoryConfigurationError, formatToolchainFailure } from './courseTestToolchain';
import {
  asmCaseArtifactUri,
  copyAsmCaseArtifact,
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  updateAsmCaseArtifacts,
  writeAsmCaseArtifact
} from './asmCaseStore';
import {
  CourseTraceBatchSource,
  CourseTraceCaseResult,
  LogisimPrepareReport,
  showLogisimPrepareReport
} from './courseTestReport';
import {
  asmCaseSourceFromBatchSource,
  caseResultFields,
  CourseTraceCaseInput,
  failedCase
} from './courseTestCases';
import { runMarsFile } from './mips';
import { defaultTraceCompareMode } from './traceCompare';
import {
  courseTraceOutputDirectory,
  logisimRawOutputFileNameForCase,
  marsOutputFileNameForCase,
  simOutputFileNameForCase
} from './courseTestTraceFiles';
import { diffMessage, marsStageFailureMessage } from './courseTestMessages';

const batchTraceCompareRetainedEntries = 1;

export interface P3LogisimTraceSetup {
  circuit: vscode.Uri;
  circuitText: string;
  traceCircuit: string;
  traceSpec: LogisimTraceSpec;
  traceDiagnostic: string;
  traceColumns?: LogisimTraceColumnMap;
  romTarget: LogisimRomTarget;
}

export interface LogisimCliTraceRun {
  result: RunResult;
  stdout: string;
  stderr: string;
  rowsSeen: number;
  haltedByPc: boolean;
  pcError?: string;
}

export interface P3LogisimTraceRunOptions {
  revealOutput?: boolean;
  source?: CourseTraceBatchSource;
  logisim?: P3LogisimTraceSetup;
  artifactOutputMode?: 'workspace' | 'case';
}

export async function diagnoseP3LogisimTraceCircuit(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);
  const circuit = await resolveLogisimCircuitInput();
  if (!circuit) {
    return;
  }
  const circuitText = await readTextFile(circuit);
  const traceCircuit = getLogisimTraceMainCircuit(circuit) || defaultLogisimTraceCircuit;
  const traceColumns = getLogisimTraceColumns(circuit) as LogisimTraceColumnMap | undefined;
  const report = analyzeP3LogisimTraceCircuit(circuitText, traceCircuit, { traceColumns });
  const diagnostic = formatP3LogisimTraceDiagnostic(report);
  revealOutputChannel(services.output, circuit);
  services.output.appendLine('');
  services.output.appendLine(diagnostic);
  if (report.spec) {
    vscode.window.showInformationMessage('P3 Logisim Trace 电路诊断通过，详见输出面板');
  } else {
    vscode.window.showErrorMessage(`P3 Logisim Trace 电路诊断失败：${report.errors[0] ?? '无法解析 trace 端口'}`);
  }
}

export async function runLogisimPrepareBatch(
  services: AppServices,
  cases: CourseTraceCaseInput[],
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

  const folder = workspaceFolderFor(circuit) ?? workspaceFolderFor(cases[0]?.asm) ?? vscode.workspace.workspaceFolders?.[0];
  const baseDir = folder?.uri.fsPath ?? path.dirname(circuit.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, '.co', 'logisim'));
  await ensureDirectory(outDir);

  revealOutputChannel(services.output, circuit);
  services.output.appendLine('');
  services.output.appendLine(`准备 Logisim 电路用例: ${cases.length} 个用例`);
  services.output.appendLine(`电路: ${circuit.fsPath}`);
  services.output.appendLine(`ROM: ${target.label ?? 'ROM'}${target.loc ? ` ${target.loc}` : ''}`);

  const results: LogisimPrepareCaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[i];
    const asm = item.asm;
    services.output.appendLine('');
    services.output.appendLine(`[${i + 1}/${cases.length}] ${asm.fsPath}`);

    try {
      const asmCase = item.asmCase ?? await createAsmCaseFromAsm(asm, {
        source: asmCaseSourceFromBatchSource(source),
        resource: circuit
      });
      const dump = await prepareAsmCaseMachineCode(services, asmCase, { showMessages: false });
      if (!dump?.result.ok || !dump.outputFile) {
        results.push({
          asm: asm.fsPath,
          ...caseResultFields(asmCase),
          status: 'error',
          message: 'MARS 导出机器码失败'
        });
        continue;
      }

      const machineCodeText = await readTextFile(asmCase.machineCode);
      const injected = injectMachineCodeIntoLogisimRom(circuitText, machineCodeText, target.index);
      const outFile = vscode.Uri.file(path.join(outDir.fsPath, preparedCircuitFileName(circuit.fsPath, asm.fsPath, baseDir)));
      await writeTextFile(outFile, injected.text);
      await copyAsmCaseArtifact(asmCase, 'logisim', outFile, path.basename(outFile.fsPath), 'preparedCircuit');
      await updateAsmCaseArtifacts(asmCase, 'logisim', { circuitTemplate: circuit.fsPath });
      results.push({
        asm: asm.fsPath,
        ...caseResultFields(asmCase),
        status: 'prepared',
        message: `已注入 ${injected.wordCount} 个机器码`,
        machineCode: asmCase.machineCode.fsPath,
        circuit: outFile.fsPath,
        wordCount: injected.wordCount
      });
      services.output.appendLine(`已准备电路: ${outFile.fsPath}`);
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
  const message = `Logisim 用例准备完成: ${summary.prepared} 已准备, ${summary.errors} 错误`;
  if (summary.errors) {
    vscode.window.showWarningMessage(message);
  } else {
    vscode.window.showInformationMessage(message);
  }
}

export async function runP3LogisimTraceCase(
  services: AppServices,
  item: CourseTraceCaseInput,
  options: P3LogisimTraceRunOptions = {}
): Promise<CourseTraceCaseResult> {
  const asm = item.asm;
  services.output.appendLine('P3 Logisim Trace 测试');
  services.output.appendLine(`ASM: ${asm.fsPath}`);
  if (item.stdin) {
    return {
      asm: asm.fsPath,
      stdin: item.stdin.fsPath,
      status: 'error',
      stage: 'logisim',
      message: 'P3 Logisim Trace 对拍不支持标准输入用例'
    };
  }

  const setup = options.logisim ?? await resolveP3LogisimTraceSetup(services, asm);
  if (!setup) {
    return {
      asm: asm.fsPath,
      status: 'error',
      stage: 'logisim',
      message: '测试中止：未准备 Logisim Trace 电路'
    };
  }

  const asmCase = item.asmCase ?? await createAsmCaseFromAsm(asm, {
    source: asmCaseSourceFromBatchSource(options.source ?? { kind: 'selected', asmFiles: [asm.fsPath] }),
    resource: setup.circuit
  });
  const caseOutputMode = options.artifactOutputMode === 'case';
  services.output.appendLine(`ASM case: ${asmCase.manifestUri.fsPath}`);
  services.output.appendLine(`Logisim 电路: ${setup.circuit.fsPath}`);
  services.output.appendLine(`Trace 顶层: ${setup.traceCircuit}`);
  await writeAsmCaseArtifact(asmCase, 'logisim', 'logisim-trace-diagnostic.txt', setup.traceDiagnostic, 'traceDiagnostic');

  const dump = await prepareAsmCaseMachineCode(services, asmCase, {
    showMessages: false,
    revealOutput: options.revealOutput,
    courseTrace: true
  });
  if (!dump?.result.ok || !dump.outputFile) {
    return failedCase(item, 'dump', marsStageFailureMessage('测试中止：MARS 导出机器码失败', dump?.result), undefined, undefined, asmCase);
  }
  services.output.appendLine(`机器码: ${asmCase.machineCode.fsPath}`);

  let logisimCode: P3LogisimMachineCode;
  try {
    logisimCode = prepareP3LogisimMachineCode(await readTextFile(asmCase.machineCode));
    const capacityError = p3LogisimRomCapacityError(setup.romTarget, logisimCode.terminatedWordCount);
    if (capacityError) {
      return failedCase(item, 'logisim', capacityError, asmCase.machineCode, undefined, asmCase);
    }
  } catch (error) {
    return failedCase(
      item,
      'logisim',
      error instanceof Error ? error.message : String(error),
      asmCase.machineCode,
      undefined,
      asmCase
    );
  }
  services.output.appendLine(`Logisim 停机 PC: 0x${logisimCode.haltPcHex}`);

  let preparedCircuit: vscode.Uri;
  try {
    const injected = injectMachineCodeIntoLogisimRom(setup.circuitText, logisimCode.text, setup.romTarget.index);
    const derivedText = setLogisimMainCircuit(injected.text, setup.traceCircuit);
    const folder = workspaceFolderFor(setup.circuit) ?? workspaceFolderFor(asm);
    const baseDir = folder?.uri.fsPath ?? path.dirname(setup.circuit.fsPath);
    const circuitName = preparedCircuitFileName(setup.circuit.fsPath, asm.fsPath, baseDir);
    preparedCircuit = await writeAsmCaseArtifact(asmCase, 'logisim', circuitName, derivedText, 'preparedCircuit');
    await writeAsmCaseArtifact(asmCase, 'logisim', 'logisim-code.txt', logisimCode.text, 'machineCodeWithHalt');
    await updateAsmCaseArtifacts(asmCase, 'logisim', {
      circuitTemplate: setup.circuit.fsPath,
      traceCircuit: setup.traceCircuit,
      haltPc: logisimCode.haltPcHex
    });
  } catch (error) {
    return {
      asm: asm.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      stage: 'logisim',
      message: error instanceof Error ? error.message : String(error),
      machineCode: asmCase.machineCode.fsPath
    };
  }

  const mars = await runMarsFile(services, asmCase.sourceAsm, 'run', {
    showMessages: false,
    revealOutput: options.revealOutput,
    traceOutput: true,
    runOutputFile: caseOutputMode ? asmCaseArtifactUri(asmCase, 'mars', marsOutputFileNameForCase(item)) : undefined
  });
  if (!mars?.result.ok || !mars.outputFile) {
    return failedCase(item, 'mars', marsStageFailureMessage('测试中止：MARS 黄金模型运行失败', mars?.result), asmCase.machineCode, undefined, asmCase);
  }
  if (caseOutputMode) {
    await updateAsmCaseArtifacts(asmCase, 'mars', { traceOut: mars.outputFile.fsPath });
  } else {
    await copyAsmCaseArtifact(asmCase, 'mars', mars.outputFile, path.basename(mars.outputFile.fsPath), 'traceOut');
  }

  const logisimRun = await runLogisimTraceCli(
    services,
    setup,
    preparedCircuit,
    logisimCode.haltPcHex,
    asm,
    options.revealOutput !== false
  );
  const outDir = caseOutputMode ? undefined : courseTraceOutputDirectory(asm);
  if (outDir) {
    await ensureDirectory(outDir);
  }
  const rawOut = caseOutputMode
    ? asmCaseArtifactUri(asmCase, 'logisim', logisimRawOutputFileNameForCase(item))
    : vscode.Uri.file(path.join(outDir!.fsPath, logisimRawOutputFileNameForCase(item)));
  await writeTextFile(rawOut, logisimRun.stdout);
  if (caseOutputMode) {
    await updateAsmCaseArtifacts(asmCase, 'logisim', { logisimOut: rawOut.fsPath });
  } else {
    await copyAsmCaseArtifact(asmCase, 'logisim', rawOut, path.basename(rawOut.fsPath), 'logisimOut');
  }

  if (!logisimRun.result.ok) {
    return {
      asm: asm.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      stage: 'logisim',
      message: marsStageFailureMessage('测试中止：Logisim 命令行运行失败', logisimRun.result),
      machineCode: asmCase.machineCode.fsPath,
      marsOut: mars.outputFile.fsPath,
      logisimOut: rawOut.fsPath,
      logisimCircuit: preparedCircuit.fsPath,
      logisimRows: logisimRun.rowsSeen
    };
  }

  let parsedLogisim: ReturnType<typeof parseLogisimTraceOutput>;
  try {
    parsedLogisim = parseLogisimTraceOutput(logisimRun.stdout, setup.traceSpec);
    const fetchValidation = validateP3LogisimFetchTrace(
      parsedLogisim.rows,
      setup.traceSpec,
      parseMachineCodeWords(logisimCode.text),
      logisimCode.haltPcHex
    );
    for (const warning of fetchValidation.warnings) {
      services.output.appendLine(`Logisim fetch check: ${warning}`);
    }
  } catch (error) {
    return {
      asm: asm.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      stage: 'logisim',
      message: error instanceof Error ? error.message : String(error),
      machineCode: asmCase.machineCode.fsPath,
      marsOut: mars.outputFile.fsPath,
      logisimOut: rawOut.fsPath,
      logisimCircuit: preparedCircuit.fsPath,
      logisimRows: logisimRun.rowsSeen
    };
  }

  const simTrace = caseOutputMode
    ? asmCaseArtifactUri(asmCase, 'logisim', simOutputFileNameForCase(item))
    : vscode.Uri.file(path.join(outDir!.fsPath, simOutputFileNameForCase(item)));
  await writeTextFile(simTrace, formatLogisimTraceEvents(parsedLogisim.events));
  if (caseOutputMode) {
    await updateAsmCaseArtifacts(asmCase, 'logisim', { traceOut: simTrace.fsPath });
  } else {
    await copyAsmCaseArtifact(asmCase, 'logisim', simTrace, path.basename(simTrace.fsPath), 'traceOut');
  }

  const marsText = await readTextFile(mars.outputFile);
  const diff = compareTraceIterables(iterCpuTraceEvents(marsText), parsedLogisim.events, {
    compareCycles: defaultTraceCompareMode.compareCycles,
    retainedEntryLimit: batchTraceCompareRetainedEntries
  });

  if (!diff.summary.marsEvents && !parsedLogisim.events.length) {
    return {
      asm: asm.fsPath,
      ...caseResultFields(asmCase),
      status: 'passed',
      stage: 'compare',
      message: 'PC/Instr 校验通过，双方没有可见 GRF/DM 写事件',
      machineCode: asmCase.machineCode.fsPath,
      marsOut: mars.outputFile.fsPath,
      simOut: simTrace.fsPath,
      logisimOut: rawOut.fsPath,
      logisimCircuit: preparedCircuit.fsPath,
      logisimRows: parsedLogisim.rows.length,
      marsEvents: 0,
      simEvents: 0,
      matchedEvents: 0,
      diffEvents: 0
    };
  }

  if (!diff.summary.marsEvents || !parsedLogisim.events.length) {
    return {
      asm: asm.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      stage: 'compare',
      message: '某一端没有可解析的 Trace 事件',
      machineCode: asmCase.machineCode.fsPath,
      marsOut: mars.outputFile.fsPath,
      simOut: simTrace.fsPath,
      logisimOut: rawOut.fsPath,
      logisimCircuit: preparedCircuit.fsPath,
      logisimRows: parsedLogisim.rows.length,
      marsEvents: diff.summary.marsEvents,
      simEvents: parsedLogisim.events.length,
      matchedEvents: diff.summary.matchedEvents,
      diffEvents: diff.summary.diffEvents
    };
  }

  return {
    asm: asm.fsPath,
    ...caseResultFields(asmCase),
    status: diff.matched ? 'passed' : 'failed',
    stage: 'compare',
    message: diffMessage(diff),
    machineCode: asmCase.machineCode.fsPath,
    marsOut: mars.outputFile.fsPath,
    simOut: simTrace.fsPath,
    logisimOut: rawOut.fsPath,
    logisimCircuit: preparedCircuit.fsPath,
    logisimRows: parsedLogisim.rows.length,
    firstDiffIndex: diff.firstDiffIndex >= 0 ? diff.firstDiffIndex : undefined,
    firstDiff: firstTraceDiffSnapshot(diff),
    marsEvents: diff.summary.marsEvents,
    simEvents: diff.summary.simEvents,
    matchedEvents: diff.summary.matchedEvents,
    diffEvents: diff.summary.diffEvents
  };
}

export async function resolveLogisimCircuitInput(): Promise<vscode.Uri | undefined> {
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
        title: '选择 Logisim 电路模板',
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return await pickOneFile('选择 Logisim 电路模板', {
    Logisim: ['circ'],
    All: ['*']
  });
}

export async function resolveLogisimRomTarget(circuitText: string): Promise<LogisimRomTarget | undefined> {
  const candidates = findLogisimRomTargets(circuitText)
    .filter((target) => target.dataWidth === undefined || target.dataWidth === 32);
  if (!candidates.length) {
    vscode.window.showErrorMessage('所选 Logisim 电路中未找到 32 位 ROM 组件');
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((target) => ({
      label: target.label ? `${target.index}: ${target.label}` : `${target.index}: ROM`,
      description: [
        target.loc ? `位置 ${target.loc}` : undefined,
        target.addrWidth ? `地址 ${target.addrWidth}` : undefined,
        target.dataWidth ? `数据 ${target.dataWidth}` : undefined,
        target.hasContents ? '有内容' : '空'
      ].filter(Boolean).join(' | '),
      target
    })),
    {
      title: '选择要注入机器码的 Logisim ROM'
    }
  );
  return picked?.target;
}

export function resolveSingleP3LogisimRomTarget(
  services: AppServices,
  circuitText: string
): LogisimRomTarget | undefined {
  const candidates = findLogisimRomTargets(circuitText)
    .filter((target) => target.dataWidth === undefined || target.dataWidth === 32);
  if (candidates.length === 1) {
    return candidates[0];
  }

  const message = candidates.length === 0
    ? 'P3 Logisim Trace 电路中未找到唯一的 32 位 ROM 组件'
    : `P3 Logisim Trace 电路应当只有一个 32 位 ROM 组件，当前找到 ${candidates.length} 个`;
  services.output.appendLine(message);
  vscode.window.showErrorMessage(message);
  return undefined;
}

export async function resolveP3LogisimTraceSetup(
  services: AppServices,
  resource: vscode.Uri
): Promise<P3LogisimTraceSetup | undefined> {
  if (!await ensureP3LogisimTraceToolchainReady(services, resource)) {
    return undefined;
  }

  const circuit = await resolveLogisimCircuitInput();
  if (!circuit) {
    return undefined;
  }
  const circuitText = await readTextFile(circuit);
  const traceCircuit = getLogisimTraceMainCircuit(circuit) || defaultLogisimTraceCircuit;
  const traceColumns = getLogisimTraceColumns(circuit) as LogisimTraceColumnMap | undefined;
  const traceReport = analyzeP3LogisimTraceCircuit(circuitText, traceCircuit, { traceColumns });
  const traceDiagnostic = formatP3LogisimTraceDiagnostic(traceReport);
  let traceSpec: LogisimTraceSpec;
  try {
    traceSpec = traceReport.spec ?? parseLogisimTraceSpec(circuitText, traceCircuit, { traceColumns });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`P3 Logisim Trace 顶层不可用：${traceReport.errors[0] ?? message}`);
    services.output.appendLine(traceDiagnostic);
    return undefined;
  }
  if (!traceReport.spec) {
    vscode.window.showErrorMessage(`P3 Logisim Trace 顶层不可用：${traceReport.errors[0] ?? '无法解析 trace 端口'}`);
    services.output.appendLine(traceDiagnostic);
    return undefined;
  }

  const romTarget = resolveSingleP3LogisimRomTarget(services, circuitText);
  if (!romTarget) {
    return undefined;
  }

  revealOutputChannel(services.output, circuit);
  services.output.appendLine('');
  services.output.appendLine('P3 Logisim Trace 设置');
  services.output.appendLine(`电路: ${circuit.fsPath}`);
  services.output.appendLine(`Trace 顶层: ${traceCircuit}`);
  services.output.appendLine(`Trace 输出列: ${traceSpec.columns.map((column) => column.logisimLabel || `(col ${column.index})`).join(', ')}`);
  services.output.appendLine(traceDiagnostic);
  services.output.appendLine(`ROM: ${romTarget.label ?? 'ROM'}${romTarget.loc ? ` ${romTarget.loc}` : ''}`);

  return {
    circuit,
    circuitText,
    traceCircuit,
    traceSpec,
    traceDiagnostic,
    traceColumns,
    romTarget
  };
}

export async function runLogisimTraceCli(
  services: AppServices,
  setup: P3LogisimTraceSetup,
  circuit: vscode.Uri,
  haltPcHex: string,
  resource: vscode.Uri,
  streamOutput = true
): Promise<LogisimCliTraceRun> {
  const java = getJava(resource);
  const logisim = getLogisimJar(resource);
  const args = ['-jar', logisim, circuit.fsPath, '-tty', 'table,halt,speed'];
  const cwd = path.dirname(circuit.fsPath);
  const display = commandLine(java, args);
  const timeoutMs = getRunTimeout(resource);
  services.output.appendLine(`$ ${display}`);
  services.output.appendLine(`cwd: ${cwd}`);

  if (showCommandBeforeRun(resource)) {
    const choice = await vscode.window.showInformationMessage(`运行外部工具？\n${display}`, '运行');
    if (choice !== '运行') {
      return {
        result: {
          ok: false,
          exitCode: null,
          commandLine: display,
          cwd,
          stdout: '',
          stderr: '用户取消',
          timedOut: false
        },
        stdout: '',
        stderr: '用户取消',
        rowsSeen: 0,
        haltedByPc: false
      };
    }
  }

  return await new Promise<LogisimCliTraceRun>((resolve) => {
    const stdout = new TextChunkAccumulator();
    const stderr = new TextChunkAccumulator();
    let rowsSeen = 0;
    let settled = false;
    let timedOut = false;
    let haltedByPc = false;
    let pcError: string | undefined;
    const pcProgress = createLogisimPcProgressState();

    const child = spawn(java, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true
    });

    const inspectLine = (line: string): void => {
      try {
        const progress = inspectLogisimPcProgress(line, setup.traceSpec, pcProgress, haltPcHex);
        rowsSeen = pcProgress.rowsSeen;
        if (!progress.rowSeen) {
          return;
        }
        if (progress.error) {
          pcError = progress.error;
          child.kill();
          return;
        }
        if (!haltedByPc && progress.halted) {
          haltedByPc = true;
          child.kill();
        }
      } catch {
        // Full parser will report malformed table rows after the process exits.
      }
    };
    const stdoutLines = new LineChunkScanner(inspectLine);

    const timer = setTimeout(() => {
      stdoutLines.flush();
      if (!haltedByPc && !pcError) {
        timedOut = true;
        child.kill();
      }
    }, timeoutMs);

    const appendStdout = (text: string): void => {
      stdout.append(text);
      if (streamOutput) {
        services.output.append(text);
      }
      stdoutLines.append(text);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      appendStdout(chunk.toString());
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr.append(text);
      services.output.append(text);
    });

    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stderr.append(error.message);
      services.output.appendLine(error.message);
      const finalStdout = stdout.toString();
      const finalStderr = stderr.toString();
      resolve({
        result: {
          ok: false,
          exitCode: null,
          commandLine: display,
          cwd,
          stdout: finalStdout,
          stderr: finalStderr,
          timedOut
        },
        stdout: finalStdout,
        stderr: finalStderr,
        rowsSeen,
        haltedByPc
      });
    });

    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdoutLines.flush();
      if (timedOut) {
        services.output.appendLine(`运行超时（${timeoutMs} 毫秒）`);
      }
      if (haltedByPc) {
        services.output.appendLine(`Logisim 已到达停机 PC 0x${haltPcHex}，结束命令行仿真`);
      }
      if (pcError) {
        services.output.appendLine(pcError);
      }
      const finalStdout = stdout.toString();
      const rawStderr = stderr.toString();
      const finalStderr = pcError
        ? [rawStderr.trimEnd(), pcError].filter(Boolean).join('\n')
        : rawStderr;
      resolve({
        result: {
          ok: haltedByPc || (!timedOut && !pcError && code === 0),
          exitCode: code,
          commandLine: display,
          cwd,
          stdout: finalStdout,
          stderr: finalStderr,
          timedOut: timedOut && !haltedByPc
        },
        stdout: finalStdout,
        stderr: finalStderr,
        rowsSeen,
        haltedByPc,
        pcError
      });
    });
  });
}

export function p3LogisimRomCapacityError(target: LogisimRomTarget, wordCount: number): string | undefined {
  if (wordCount > p3LogisimMaxWords) {
    return `P3 Logisim 机器码共有 ${wordCount} words，超过教程 IFU ${p3LogisimMaxWords} words 容量`;
  }
  if (target.addrWidth === undefined) {
    return undefined;
  }
  const capacity = target.addrWidth >= 31 ? Number.MAX_SAFE_INTEGER : 2 ** target.addrWidth;
  if (wordCount > capacity) {
    return `所选 Logisim ROM 地址宽度为 ${target.addrWidth}，容量 ${capacity} words，小于本用例 ${wordCount} words`;
  }
  return undefined;
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

function isLogisimCircuitFile(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.circ';
}

async function ensureP3LogisimTraceToolchainReady(services: AppServices, resource: vscode.Uri): Promise<boolean> {
  revealOutputChannel(services.output, resource);
  services.output.appendLine('');
  services.output.appendLine('正在检查 P3 Logisim Trace 对拍工具链');

  const memoryConfiguration = getMemoryConfiguration(resource);
  const configurationError = courseTraceMemoryConfigurationError('P3', memoryConfiguration);
  if (configurationError) {
    services.output.appendLine(configurationError);
    vscode.window.showErrorMessage(configurationError);
    return false;
  }

  const checks = await checkToolchain(services.output, resource, { tools: ['java', 'mars', 'logisim'] });
  const required = new Set(['Java', 'MARS', 'MARS coL1', 'Logisim', `MARS ${memoryConfiguration}`]);
  const failed = checks.filter((check) => required.has(check.name) && !check.ok);
  if (!failed.length) {
    return true;
  }

  const message = `P3 Logisim Trace 工具链检查失败：${failed.map(formatToolchainFailure).join('；')}`;
  services.output.appendLine(message);
  vscode.window.showErrorMessage(message);
  return false;
}
