// @index course-trace-runner — 单个课程 Trace case 的 MARS/ISim/Logisim 执行与比较
import * as path from 'path';
import * as vscode from 'vscode';
import { getProfile } from '../config';
import { P7ProbeMetadata } from './builtinAsmGenerator';
import { checkP7Probe } from './p7ProbeCheck';
import {
  compareTraceIterables,
  firstTraceDiffSnapshot
} from '../language/mips/traceCompare';
import { iterCpuTraceEvents } from '../language/mips/traceParser';
import { parseSimOutput } from '../language/verilog/traceParser';
import { runMarsFile } from '../mips';
import { defaultTraceCompareMode } from '../traceCompare';
import { runIsim } from '../verilog';
import { IsimCompileCache } from '../verilogIsimCache';
import { AppServices } from '../types';
import { readTextFile } from '../fsUtil';
import {
  AsmCase,
  asmCaseArtifactUri,
  copyAsmCaseArtifact,
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  readAsmCaseManifestForAsm,
  updateAsmCaseArtifacts
} from '../asmCaseStore';
import {
  asmCaseSourceFromBatchSource,
  caseResultFields,
  failedCase
} from '../courseTestCases';
import type { CourseTraceCaseInput } from '../courseTestCases';
import type {
  CourseTraceBatchSource,
  CourseTraceCaseResult
} from '../courseTestReport';
import {
  marsOutputFileNameForCase,
  simOutputFileNameForCase
} from '../courseTestTraceFiles';
import { diffMessage, marsStageFailureMessage } from '../courseTestMessages';
import { runP3LogisimTraceCase } from '../courseTestLogisim';
import type { P3LogisimTraceSetup } from '../courseTestLogisim';

const batchTraceCompareRetainedEntries = 1;

export interface CourseTraceRunOptions {
  revealOutput?: boolean;
  source?: CourseTraceBatchSource;
  logisim?: P3LogisimTraceSetup;
  isimCompileCache?: IsimCompileCache;
  artifactOutputMode?: 'workspace' | 'case';
}

export async function runCourseTraceCase(
  services: AppServices,
  item: CourseTraceCaseInput,
  options: CourseTraceRunOptions = {}
): Promise<CourseTraceCaseResult> {
  const asm = item.asm;
  if (getProfile(asm) === 'P3') {
    return await runP3LogisimTraceCase(services, item, options);
  }

  services.output.appendLine('完整课程 Trace 测试');
  services.output.appendLine(`ASM: ${asm.fsPath}`);
  if (item.stdin) {
    services.output.appendLine(`标准输入: ${item.stdin.fsPath}`);
  }

  const asmCase = item.asmCase ?? await createAsmCaseFromAsm(asm, {
    source: asmCaseSourceFromBatchSource(options.source ?? { kind: 'selected', asmFiles: [asm.fsPath] }),
    stdin: item.stdin,
    resource: asm,
    p7: await p7MetadataFromManifest(asm)
  });
  const caseOutputMode = options.artifactOutputMode === 'case';
  services.output.appendLine(`ASM case: ${asmCase.manifestUri.fsPath}`);

  const dump = await prepareAsmCaseMachineCode(services, asmCase, {
    showMessages: false,
    revealOutput: options.revealOutput,
    courseTrace: true
  });
  if (!dump?.result.ok || !dump.outputFile) {
    return failedCase(item, 'dump', marsStageFailureMessage('测试中止：MARS 导出机器码失败', dump?.result), undefined, undefined, asmCase);
  }
  services.output.appendLine(`机器码: ${asmCase.machineCode.fsPath}`);

  const interruptSchedule = resolveCaseInterruptScheduleFromCase(asmCase);
  if (interruptSchedule) {
    services.output.appendLine(`外部中断目标 PC: ${interruptSchedule.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}`);
  }
  const probe = resolveCaseProbeMetadataFromCase(asmCase);
  if (probe) {
    services.output.appendLine(`P7 Probe 场景: ${probe.scenarios.map((scenario) => `${scenario.id}:${scenario.kind}`).join(', ')}`);
    const isim = await runIsim(services, {
      resource: asm,
      showMessages: false,
      revealOutput: options.revealOutput,
      asmCase,
      simOutputFileName: simOutputFileNameForCase(item),
      simOutputUri: caseOutputMode ? asmCaseArtifactUri(asmCase, 'verilog', simOutputFileNameForCase(item)) : undefined,
      p7Probe: probe,
      compileCache: options.isimCompileCache
    });
    if (!isim?.simResult.ok || !isim.simOut) {
      return failedCase(item, 'isim', '测试中止：ISim 运行失败', asmCase.machineCode, undefined, asmCase);
    }
    const simText = await readTextFile(isim.simOut);
    const simEvents = parseSimOutput(simText);
    const probeResult = checkP7Probe(simText, simEvents, probe);
    return {
      asm: asm.fsPath,
      stdin: item.stdin?.fsPath,
      ...caseResultFields(asmCase),
      status: probeResult.passed ? 'passed' : 'failed',
      stage: 'probe',
      message: probeResult.passed ? 'P7 Probe 检查通过' : probeResult.failures[0]?.message ?? 'P7 Probe 检查失败',
      machineCode: asmCase.machineCode.fsPath,
      simOut: isim.simOut.fsPath,
      simEvents: simEvents.length,
      probe: probeResult
    };
  }

  const stdinText = item.stdin ? await readTextFile(item.stdin) : undefined;
  const mars = await runMarsFile(services, asmCase.sourceAsm, 'run', {
    showMessages: false,
    revealOutput: options.revealOutput,
    stdin: stdinText,
    stdinSource: item.stdin,
    traceOutput: true,
    runOutputFile: caseOutputMode ? asmCaseArtifactUri(asmCase, 'mars', marsOutputFileNameForCase(item)) : undefined,
    interruptSchedule
  });
  if (!mars?.result.ok || !mars.outputFile) {
    return failedCase(item, 'mars', marsStageFailureMessage('测试中止：MARS 黄金模型运行失败', mars?.result), asmCase.machineCode, undefined, asmCase);
  }
  if (caseOutputMode) {
    await updateAsmCaseArtifacts(asmCase, 'mars', { traceOut: mars.outputFile.fsPath });
  } else {
    await copyAsmCaseArtifact(asmCase, 'mars', mars.outputFile, path.basename(mars.outputFile.fsPath), 'traceOut');
  }

  const isim = await runIsim(services, {
    resource: asm,
    showMessages: false,
    revealOutput: options.revealOutput,
    asmCase,
    simOutputFileName: simOutputFileNameForCase(item),
    simOutputUri: caseOutputMode ? asmCaseArtifactUri(asmCase, 'verilog', simOutputFileNameForCase(item)) : undefined,
    interruptSchedule,
    compileCache: options.isimCompileCache
  });
  if (!isim?.simResult.ok || !isim.simOut) {
    return failedCase(item, 'isim', '测试中止：ISim 运行失败', asmCase.machineCode, mars.outputFile, asmCase);
  }

  const marsText = await readTextFile(mars.outputFile);
  const simText = await readTextFile(isim.simOut);
  const diff = compareTraceIterables(iterCpuTraceEvents(marsText), iterCpuTraceEvents(simText), {
    compareCycles: defaultTraceCompareMode.compareCycles,
    retainedEntryLimit: batchTraceCompareRetainedEntries
  });

  if (!diff.summary.marsEvents || !diff.summary.simEvents) {
    return {
      asm: asm.fsPath,
      stdin: item.stdin?.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      stage: 'compare',
      message: '某一端没有可解析的 Trace 事件',
      machineCode: asmCase.machineCode.fsPath,
      marsOut: mars.outputFile.fsPath,
      simOut: isim.simOut.fsPath,
      marsEvents: diff.summary.marsEvents,
      simEvents: diff.summary.simEvents,
      matchedEvents: diff.summary.matchedEvents,
      diffEvents: diff.summary.diffEvents
    };
  }

  return {
    asm: asm.fsPath,
    stdin: item.stdin?.fsPath,
    ...caseResultFields(asmCase),
    status: diff.matched ? 'passed' : 'failed',
    stage: 'compare',
    message: diffMessage(diff),
    machineCode: asmCase.machineCode.fsPath,
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

export async function p7MetadataFromManifest(asm: vscode.Uri): Promise<{ interruptSchedule?: number[]; probe?: P7ProbeMetadata } | undefined> {
  const manifest = await readAsmCaseManifestForAsm(asm);
  if (!manifest?.p7) {
    return undefined;
  }
  const interruptSchedule = Array.isArray(manifest.p7.interruptSchedule)
    ? manifest.p7.interruptSchedule.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : undefined;
  const probe = isProbeMetadata(manifest.p7.probe) ? manifest.p7.probe : undefined;
  return interruptSchedule?.length || probe ? { interruptSchedule, probe } : undefined;
}

function resolveCaseInterruptScheduleFromCase(asmCase: AsmCase): number[] | undefined {
  const schedule = asmCase.manifest.p7?.interruptSchedule;
  return Array.isArray(schedule) && schedule.length ? schedule : undefined;
}

function resolveCaseProbeMetadataFromCase(asmCase: AsmCase): P7ProbeMetadata | undefined {
  const probe = asmCase.manifest.p7?.probe;
  return isProbeMetadata(probe) ? probe : undefined;
}

function isProbeMetadata(value: unknown): value is P7ProbeMetadata {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const probe = value as P7ProbeMetadata;
  return probe.version === 1
    && Number.isFinite(probe.logBase)
    && Number.isFinite(probe.recordWords)
    && Array.isArray(probe.scenarios);
}
