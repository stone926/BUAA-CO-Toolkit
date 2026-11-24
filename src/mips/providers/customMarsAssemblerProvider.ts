// @index mips-providers — 魔改 Mars 汇编器：冻结指令类、真实段映像与 source-bound 执行凭据
import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import type { CourseProfile } from '../core/generated/isaCatalog';
import { courseProfileIds } from '../core/profiles/profileIds';
import { courseExecutionProfiles } from '../core/profiles/courseProfiles';
import { courseInstructionImageWords, findCourseHaltPc, imageSegmentWords, wordsToHexText } from '../core/assembler/artifacts';
import { writeFileAtomicReplace } from '../replay/atomicFile';
import { withCapturedAssemblySource } from '../host/sourceInput';
import type { SourceUnit } from '../core/api';
import { customInstructionsForResource } from '../host/customInstructionResource';
import type { BoundMarsInstructions } from '../host/customInstructionService';
import type { AssembleRequest, AssembleResult, MipsAssemblerProvider, ProviderExecutionBinding, ProviderRunContext, ResolvedEngineRun } from './contracts';
import { failedPreflight, okPreflight } from './contracts';
import { CUSTOM_MARS_CAPABILITIES, CUSTOM_MARS_DESCRIPTOR, customMarsFailureStatus, customMarsImage } from './customMarsCommon';
import { resolveCourseEnginePlan } from './courseEnginePolicy';

export interface CustomMarsAssemblySession {
  instructions: BoundMarsInstructions; profile: CourseProfile; source: string;
  resolvedRun: ResolvedEngineRun;
}
export type CustomMarsSessions = WeakMap<ProviderExecutionBinding, CustomMarsAssemblySession>;

export class CustomMarsAssemblerProvider implements MipsAssemblerProvider {
  readonly descriptor = CUSTOM_MARS_DESCRIPTOR;
  readonly capabilities = CUSTOM_MARS_CAPABILITIES;
  constructor(private readonly sessions: CustomMarsSessions) {}
  async preflight(request: AssembleRequest) {
    const profile = request.requirements?.profile;
    const diagnostics = [];
    if (request.sourceUri.scheme !== 'file' || (profile !== 'P2' && !courseProfileIds.includes(profile as CourseProfile))) {
      diagnostics.push({ code: 'custom-mars.profile', message: '自定义 Mars 需要本地 ASM 文件和 P2–P7 Profile' });
    }
    try { if (!(await fs.stat(request.sourceUri.fsPath)).isFile()) throw new Error(); }
    catch { diagnostics.push({ code: 'custom-mars.source', message: '自定义 Mars 的 ASM 快照不可读' }); }
    return diagnostics.length ? failedPreflight(this.descriptor, diagnostics) : okPreflight(this.descriptor);
  }
  async assemble(request: AssembleRequest, context?: ProviderRunContext): Promise<AssembleResult> {
    const profile = request.requirements?.profile as CourseProfile | 'P2';
    const preflight = await this.preflight(request);
    if (!preflight.ok) return { ok: false, descriptor: this.descriptor, status: customMarsFailureStatus(preflight.diagnostics.map((d) => d.message).join('\n')) };
    try {
      if (context?.signal?.aborted) throw new Error('自定义 Mars 汇编已取消');
      const resource = request.resourceUri ?? request.sourceUri;
      const workspace = customInstructionsForResource(resource);
      const selection = request.workspaceInstructions ?? await workspace.select({ policy: 'mars', signal: context?.signal });
      if (selection.kind !== 'mars') throw new Error('未选择魔改 Mars 指令引擎');
      const instructions = await selection.bind(context?.signal);
      if (request.expectedEngineArtifact && identityKey(instructions.identity) !== identityKey(request.expectedEngineArtifact)) {
        throw new Error('自定义 Mars 或 .class 与原测试点记录的版本不同；请恢复 co.toolchain.mars 和 .co/custom-instructions 中的原版本后重跑');
      }
      const assemble = async (input: { sourcePath: string; sources: readonly SourceUnit[]; sourcePaths?: AssembleRequest['sourcePaths'] }): Promise<AssembleResult> => {
        const { result, payload } = await instructions.run({ mode: 'assemble', source: input.sourcePath,
          profile: profile === 'P2' ? 'ordinary' : profile, layout: profile === 'P2' ? 'Default' : 'CompactLargeText',
          delayed: profile !== 'P2' && courseExecutionProfiles[profile].delaySlot, signal: context?.signal });
        if (!result.ok || !payload) return { ok: false, status: result, descriptor: this.descriptor };
        const image = customMarsImage(payload, input.sources, { ...request, sourceUri: vscode.Uri.file(input.sourcePath),
          sourcePaths: input.sourcePaths ?? request.sourcePaths });
        const haltPc = profile !== 'P2' && request.courseTrace ? findCourseHaltPc(image, profile) : undefined;
        if (request.courseTrace && haltPc === undefined) throw new Error('自定义 ASM 缺少标准停机尾：请在用户 .text 末尾添加自分支和 nop');
        const words = request.target.kind === 'kernelText' ? imageSegmentWords(image, 'ktext')
          : profile === 'P2' ? imageSegmentWords(image, 'text') : courseInstructionImageWords(image);
        const outputFile = request.target.outputFile ?? vscode.Uri.file(path.join(path.dirname(request.sourceUri.fsPath), 'code.txt'));
        if (request.writeOutput !== false) await writeFileAtomicReplace(outputFile.fsPath, Buffer.from(wordsToHexText(words)));
        const resolvedRun: ResolvedEngineRun = { profile, memoryConfiguration: profile === 'P2' ? 'Default' : 'course-contract-v1',
          runtime: { kind: 'java', command: instructions.java }, wallClockMs: instructions.timeoutMs, p7RiInstruction: false,
          javaVersion: payload.javaVersion };
        const binding = Object.freeze({ kind: 'source-reassembly' as const, providerId: this.descriptor.id,
          sourceUri: request.sourceUri, imageFingerprint: image.fingerprint });
        if (profile !== 'P2' && request.sourceGraphInput) this.sessions.set(binding, { instructions, profile, source: input.sourcePath, resolvedRun });
        return { ok: true, status: result, descriptor: this.descriptor, image, outputFile, courseHaltPc: haltPc,
          customInstructionEncodings: payload.customInstructions, executionBinding: binding,
          engineArtifact: instructions.identity, enginePlan: resolveCourseEnginePlan('mars', profile), resolvedRun };
      };
      return request.sourceGraphInput ? await assemble({ ...request.sourceGraphInput, sourcePath: request.sourceUri.fsPath })
        : await withCapturedAssemblySource(request.sourceUri.fsPath, workspace.root, assemble);
    } catch (error) {
      return { ok: false, status: { ...customMarsFailureStatus(error), ...(context?.signal?.aborted ? { stopped: true, stopReason: 'cancelled' } : {}) }, descriptor: this.descriptor };
    }
  }
}

function identityKey(identity: import('./contracts').EngineArtifactIdentity): string {
  return JSON.stringify([identity.sha256, identity.role, identity.fileName,
    identity.dependencies?.map((dependency) => [dependency.sha256, dependency.role, dependency.fileName]) ?? []]);
}
