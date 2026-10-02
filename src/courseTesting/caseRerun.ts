// @index course-case-rerun — 从保存的 ASM/stdin 闭包创建独立用例，用当前 CPU 与自动测试私有 TB 重跑
import * as path from 'path';
import * as vscode from 'vscode';
import {
  asmCaseArtifactUri,
  asmCaseSourceSnapshotIssue,
  createAsmCaseFromAsm,
  readAsmCaseStdinSnapshot,
  updateAsmCaseArtifacts,
  updateAsmCaseMetadata,
  type AsmCase
} from '../asmCaseStore';
import { getProfile } from '../config';
import { failedCase, type CourseTraceCaseInput } from '../courseTestCases';
import { resolveP3LogisimTraceSetup } from '../courseTestLogisim';
import type { CourseTraceCaseResult } from '../courseTestReport';
import { simOutputFileNameForCase } from '../courseTestTraceFiles';
import { resolveCourseEnginePlan } from '../mips/providers/courseEnginePolicy';
import { readBoundedRegularFile, maximumReplayManifestBytes } from '../mips/replay/boundedFile';
import { sha256Bytes } from '../asmCaseStoreCore';
import type { AppServices } from '../types';
import { automaticTestEngineMode } from './automaticTestPolicy';
import { courseRerunWaveformCapture } from './caseRerunWaveform';
import { manifestP7Of, manifestSourceOf } from './manifestCodec';
import { defaultCourseTracePipeline, runCourseTraceCase } from './traceRunner';

export interface CourseTestCaseRerunOptions {
  waveform?: boolean;
  signal?: AbortSignal;
}

/** The caller owns session/save/progress UI; this operation never mutates the archived case. */
export async function rerunCourseTestCase(
  services: AppServices,
  original: AsmCase,
  options: CourseTestCaseRerunOptions = {}
): Promise<{ result: CourseTraceCaseResult; waveform?: vscode.Uri; waveformIssue?: string }> {
  let rerun: AsmCase | undefined;
  let item: CourseTraceCaseInput = { asm: original.asm };
  try {
    throwIfCancelled(options.signal);
    const profile = getProfile(original.asm);
    if (!/^P[3-7]$/.test(profile) || profile !== original.manifest.profile) {
      throw new Error(`当前课程阶段 ${profile} 与原用例 ${original.manifest.profile} 不一致，请恢复原阶段后重跑`);
    }
    if (options.waveform && profile === 'P3') {
      throw new Error('P3 Logisim 用例支持重跑；VCD 波形仅适用于 P4–P7');
    }
    if (original.manifest.version !== 2) {
      throw new Error('旧版用例没有可验证的完整 ASM 闭包，无法使用自动测试链重跑');
    }
    if (!original.manifest.program.sourceGraph) {
      throw new Error('原用例没有保存完整的 ASM/include 闭包，无法使用自动测试链重跑');
    }
    await assertRerunInputSnapshots(original);
    throwIfCancelled(options.signal);
    const stdin = original.manifest.stdin
      ? vscode.Uri.file(path.join(original.dir.fsPath, ...original.manifest.stdin.path.split('/')))
      : undefined;
    const metadata: Record<string, string> = { 'rerun.originalCaseId': original.id };
    // Source facts determine private budgets and reproduce seeded probe programs.
    // Session ownership and old execution outcomes must not leak into the new case.
    for (const [key, value] of Object.entries(original.manifest.metadata ?? {})) {
      if (key.startsWith('source.') && key !== 'source.sessionId') metadata[key] = value;
    }
    rerun = await createAsmCaseFromAsm(original.sourceAsm, {
      resource: original.asm,
      stdin,
      source: manifestSourceOf(original.manifest),
      p7: manifestP7Of(original.manifest),
      metadata,
      enginePlan: resolveCourseEnginePlan(automaticTestEngineMode, profile, { deterministicConsole: stdin !== undefined })
    });
    // The new manifest records the old case-local stdin as its originalPath.
    item = { asm: rerun.asm, stdin, asmCase: rerun };
    await assertRerunInputSnapshots(original);
    throwIfCancelled(options.signal);

    const logisim = profile === 'P3'
      ? await resolveP3LogisimTraceSetup(services, rerun.asm, { nonInteractive: true })
      : undefined;
    if (profile === 'P3' && !logisim) throw new Error('无法准备 P3 Logisim 电路与写回记录设置');
    throwIfCancelled(options.signal);
    const dump = options.waveform
      ? asmCaseArtifactUri(rerun, 'verilog', `${path.parse(simOutputFileNameForCase(item)).name.replace(/\.sim$/, '')}.vcd`)
      : undefined;
    const capture = dump ? courseRerunWaveformCapture(dump) : undefined;
    const result: CourseTraceCaseResult = await runCourseTraceCase(services, item, {
      source: { kind: 'generator', generator: manifestSourceOf(original.manifest).generator },
      artifactOutputMode: 'case',
      revealOutput: false,
      signal: options.signal,
      logisim,
      ...(capture ? { pipeline: defaultCourseTracePipeline({ runDut: capture.runDut }) } : {})
    });
    if (result.cancelled) await recordRerunCancellation(services, rerun);
    let waveform = capture?.waveform;
    let waveformIssue = capture?.issue;
    if (waveform) {
      try {
        await updateAsmCaseArtifacts(rerun, 'verilog', { waveform: waveform.fsPath });
      } catch (error) {
        waveformIssue = `无法保存重跑波形证据：${error instanceof Error ? error.message : String(error)}`;
        waveform = undefined;
      }
    }
    if (waveformIssue && !result.cancelled) {
      services.output.appendLine(waveformIssue);
    }
    return {
      result,
      ...(waveform ? { waveform } : {}),
      ...(waveformIssue && !result.cancelled ? { waveformIssue } : {})
    };
  } catch (error) {
    const cancelled = options.signal?.aborted === true;
    const detail = error instanceof Error ? error.message : String(error);
    const message = cancelled ? '用例重跑已取消' : `用例重跑中止：${detail}`;
    services.output.appendLine(message);
    if (cancelled && rerun) await recordRerunCancellation(services, rerun);
    return { result: failedCase(item, 'internal', message, undefined, undefined, rerun, cancelled) };
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('用例重跑已取消');
}

async function recordRerunCancellation(services: AppServices, asmCase: AsmCase): Promise<void> {
  try {
    await updateAsmCaseMetadata(asmCase, { 'rerun.state': 'cancelled' });
  } catch (error) {
    services.output.appendLine(`无法保存重跑取消状态：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertRerunInputSnapshots(asmCase: AsmCase): Promise<void> {
  const sourceIssue = await asmCaseSourceSnapshotIssue(asmCase);
  if (sourceIssue) throw new Error(sourceIssue);
  if (asmCase.manifest.version !== 2 || !asmCase.manifest.program.sourceGraph) {
    throw new Error('原用例没有保存完整的 ASM/include 闭包');
  }
  // Verifying the graph's internal edges/blobs alone does not bind it to the
  // archived manifest. Also authenticate the graph snapshot itself.
  const snapshot = asmCase.manifest.program.sourceGraph;
  const bytes = await readBoundedRegularFile(path.join(asmCase.dir.fsPath, ...snapshot.path.split('/')), {
    maximumBytes: maximumReplayManifestBytes,
    expectedBytes: snapshot.bytes,
    label: '原用例 ASM/include 闭包'
  });
  if (sha256Bytes(bytes) !== snapshot.sha256.toLowerCase()) {
    throw new Error('原用例 ASM/include 闭包已偏离 manifest 指纹，已拒绝重跑');
  }
  await readAsmCaseStdinSnapshot(asmCase);
}
