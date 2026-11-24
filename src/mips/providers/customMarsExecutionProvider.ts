// @index mips-providers — 自定义 Mars 课程 oracle：复用同一依赖快照和权威映像，返回规范写回 Trace
import * as vscode from 'vscode';
import * as path from 'path';
import { writeFileAtomicReplace } from '../replay/atomicFile';
import { iterCpuTraceEvents } from '../../language/mips/traceParser';
import { courseProgramImagePolicyIssues } from '../../courseTesting/pipeline/courseImagePolicy';
import { courseExecutionProfiles } from '../core/profiles/courseProfiles';
import { CUSTOM_MARS_CAPABILITIES, CUSTOM_MARS_DESCRIPTOR, customMarsFailureStatus } from './customMarsCommon';
import type { ExecuteRequest, ExecuteResult, MipsExecutionProvider, ProviderRunContext } from './contracts';
import { failedPreflight, okPreflight } from './contracts';
import type { CustomMarsSessions } from './customMarsAssemblerProvider';

export class CustomMarsExecutionProvider implements MipsExecutionProvider {
  readonly descriptor = CUSTOM_MARS_DESCRIPTOR;
  readonly capabilities = CUSTOM_MARS_CAPABILITIES;
  constructor(private readonly sessions: CustomMarsSessions) {}
  preflight(request: ExecuteRequest) {
    const binding = request.executionBinding;
    const session = binding && this.sessions.get(binding);
    const diagnostics = [];
    if (!session || binding?.providerId !== this.descriptor.id || binding.imageFingerprint !== request.image.fingerprint
      || (request.profile ?? request.requirements?.profile ?? session.profile) !== session.profile) {
      diagnostics.push({ code: 'custom-mars.binding', message: '自定义 Mars 执行必须复用当前汇编返回的引擎、源码和机器码绑定' });
    } else {
      diagnostics.push(...courseProgramImagePolicyIssues(session.profile, request.image, request.haltPc));
    }
    if (!Number.isSafeInteger(request.haltPc) || !request.courseTrace) diagnostics.push({ code: 'custom-mars.halt', message: '课程 Mars oracle 必须绑定标准停机 PC' });
    return diagnostics.length ? failedPreflight(this.descriptor, diagnostics) : okPreflight(this.descriptor);
  }
  async execute(request: ExecuteRequest, context?: ProviderRunContext): Promise<ExecuteResult> {
    const preflight = this.preflight(request);
    if (!preflight.ok) return { ok: false, descriptor: this.descriptor, status: customMarsFailureStatus(preflight.diagnostics.map((d) => d.message).join('\n')) };
    const session = this.sessions.get(request.executionBinding!)!;
    try {
      const { result, payload } = await session.instructions.run({ mode: 'execute', source: session.source,
        profile: session.profile, layout: 'CompactLargeText', delayed: courseExecutionProfiles[session.profile].delaySlot,
        maxSteps: request.maxSteps, haltPc: request.haltPc, stdin: request.stdin, signal: context?.signal,
        interruptSchedule: request.interruptSchedule, expectedSegments: request.image.segments });
      if (!result.ok || !payload || payload.stopReason !== 'halt-loop') {
        return { ok: false, descriptor: this.descriptor, status: { ...result, ok: false,
          stderr: result.stderr || '自定义 Mars 未到达已验证的课程停机尾' } };
      }
      const outputFile = request.runOutputFile ?? vscode.Uri.file(path.join(path.dirname(session.source), 'oracle.out'));
      await writeFileAtomicReplace(outputFile.fsPath, Buffer.from(result.stdout));
      return { ok: true, status: result, descriptor: this.descriptor, engineArtifact: session.instructions.identity, instructions: payload.instructions,
        ...(session.profile === 'P7' && (payload.timerTimingObserved ?? payload.timerActivated) ? { referenceTiming: 'p7-timer-observed' as const } : {}),
        outputFile, resolvedRun: session.resolvedRun,
        stop: { kind: 'halt-loop', haltPc: request.haltPc },
        trace: { schemaRevision: 1, eventSchema: 'buaa-co-architectural-write-v1',
          events: [...iterCpuTraceEvents(result.stdout)], rawText: result.stdout, rawTraceRevision: 1 } };
    } catch (error) { return { ok: false, descriptor: this.descriptor, status: customMarsFailureStatus(error) }; }
  }
}
