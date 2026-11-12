// @index hazard-case-input — Verify one selected saved case and bind its image to the original IRQ schedule.
import * as fs from 'fs/promises';
import * as path from 'path';
import { CO_CASES_DIR } from '../constants';
import { sha256Bytes, type AsmCaseSnapshot } from '../asmCaseStoreCore';
import { isKnownManifest, isManifestV2, isSafeCaseRelativePath, manifestRunConfigurationHash } from '../courseTesting/manifestCodec';
import { p7InterruptAnchorPairIssue } from '../courseTesting/p7InterruptAnchor';
import { courseInstructionImageWords, findCourseHaltPc } from '../mips/core/assembler/artifacts';
import type { ProgramImage } from '../mips/core/api';
import type { ExternalInterruptRequest } from '../mips/core/devices/interruptController';
import { deserializeProgramImage, parseStrictHexTextWords } from '../mips/replay/programImage';
import { loadVerifiedSourceGraphInput } from '../mips/replay/sourceBundle';
import {
  maximumReplayManifestBytes, maximumReplaySourceBytes, maximumReplayProgramImageBytes,
  maximumReplayMachineCodeBytes, readBoundedRegularFile
} from '../mips/replay/boundedFile';
import { assertContainedDirectoryPath } from '../pathContainment';
import type { HazardProfile } from '../hazardAnalysis/reportTypes';

export interface HazardCaseInput {
  readonly image: ProgramImage;
  readonly caseId: string;
  readonly externalInterrupts: readonly ExternalInterruptRequest[];
}

/** Only the selected .co/cases/<id> is inspected; no workspace scan or historical trace reads. */
export async function loadHazardCaseInput(
  sourcePath: string, workspaceRoot: string, profile: HazardProfile
): Promise<HazardCaseInput | undefined> {
  const casesRoot = path.resolve(workspaceRoot, CO_CASES_DIR);
  const relative = path.relative(casesRoot, path.resolve(sourcePath));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  const parts = relative.split(path.sep);
  if (parts.length < 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parts[0])) return undefined;
  const caseDir = path.join(casesRoot, parts[0]);
  await assertContainedDirectoryPath(workspaceRoot, caseDir);
  const manifestBytes = await readBoundedRegularFile(await containedFile(caseDir, 'case.json'), {
    maximumBytes: maximumReplayManifestBytes, label: '冲突分析用例清单'
  });
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (!isKnownManifest(manifest) || !isManifestV2(manifest) || manifest.caseId !== parts[0]) {
    throw new Error('用例清单无效，或旧版用例缺少可验证的源码闭包；请重新生成用例后分析。');
  }
  if (manifest.profile !== profile) throw new Error(`用例阶段 ${manifest.profile} 与当前 ${profile} 不一致。`);
  if (manifest.p7?.probe) {
    throw new Error('此用例依赖 DUT 的 P7 探针/设备时序，不能用顺序 hazard 分析代替；请使用原自动测试报告。');
  }
  const graphRef = manifest.program.sourceGraph;
  const imageRef = manifest.program.image;
  if (!graphRef || !imageRef || !manifest.program.imageFingerprint) {
    throw new Error('用例尚未保存完整源码闭包和程序映像，无法可靠复现原执行上下文。');
  }
  await readSnapshot(caseDir, graphRef, maximumReplayManifestBytes, '用例源码闭包');
  const [{ graph }, asmBytes, imageBytes] = await Promise.all([
    loadVerifiedSourceGraphInput(caseDir, graphRef.path),
    readSnapshot(caseDir, manifest.asmSnapshot, maximumReplaySourceBytes, '用例 ASM'),
    readSnapshot(caseDir, imageRef, maximumReplayProgramImageBytes, '用例程序映像')
  ]);
  const rootUnit = graph.units.find((unit) => unit.id === graph.rootId);
  if (!rootUnit || rootUnit.contentHash !== sha256Bytes(asmBytes)) throw new Error('用例 ASM 与源码闭包不一致。');
  const image = deserializeProgramImage(imageBytes);
  const hashes = new Map(graph.units.map((unit) => [unit.id, unit.contentHash]));
  if (image.fingerprint !== manifest.program.imageFingerprint || image.inputGraph.length !== hashes.size
    || image.inputGraph.some((unit) => hashes.get(unit.id) !== unit.contentHash)) {
    throw new Error('用例程序映像与源码闭包不一致，已拒绝套用旧中断调度。');
  }
  const selected = parts.slice(1).join('/');
  const sourceSelected = samePath(selected, manifest.asmSnapshot.path) || samePath(selected, rootUnit.materializedPath);
  if (!sourceSelected) {
    const codeRef = [manifest.program.machineCode, manifest.program.dutInput]
      .find((reference) => reference && samePath(reference.path, selected));
    if (!codeRef) throw new Error('请选择用例的主 ASM、物化主 ASM 或清单绑定的完整机器码文件。');
    const code = parseStrictHexTextWords((await readSnapshot(caseDir, codeRef, maximumReplayMachineCodeBytes, '用例机器码')).toString('utf8'));
    const expected = courseInstructionImageWords(image);
    if (code.length !== expected.length || code.some((word, index) => word !== expected[index])) {
      throw new Error('所选机器码与用例程序映像不一致，已拒绝套用旧中断调度。');
    }
  }
  // The source graph verifier checks all materialized includes. Also reject selected-file links.
  await containedFile(caseDir, selected);
  const schedule = manifest.p7?.interruptSchedule ?? [];
  const recorded = manifest.oracle.runConfiguration;
  // Fresh prepared cases have only profile/memoryConfiguration, before an oracle run binds
  // its IRQ inputs. That placeholder is not evidence of an explicitly empty IRQ schedule.
  const unexecuted = manifest.oracle.stopReason === 'unknown' && manifest.oracle.steps === undefined
    && manifest.oracle.eventCount === undefined && !manifest.oracle.rawOutputDigest
    && !manifest.oracle.eventDigest && !manifest.oracle.finalStateDigest;
  const initialConfiguration = unexecuted && Object.keys(recorded ?? {})
    .every((key) => key === 'profile' || key === 'memoryConfiguration');
  if (schedule.length > 4096 || (profile !== 'P7' && schedule.length)
    || (!recorded && !unexecuted)
    || (recorded && (recorded.profile !== profile
      || (!initialConfiguration && JSON.stringify(recorded.interruptSchedule ?? []) !== JSON.stringify(schedule))
      || (recorded.deviceTimeline && JSON.stringify(recorded.deviceTimeline.events.map((event) => event.value)) !== JSON.stringify(schedule))
      || manifestRunConfigurationHash(recorded, manifest.oracle.engine) !== manifest.oracle.configurationHash))) {
    throw new Error('用例中断调度与原 oracle 执行配置不一致。');
  }
  const words = courseInstructionImageWords(image);
  const haltPc = findCourseHaltPc(image, profile);
  for (const pc of schedule) {
    if (haltPc === undefined || pc > haltPc) throw new Error('用例中断目标位于主程序有效执行范围之外。');
    const issue = p7InterruptAnchorPairIssue(words, pc);
    if (issue) throw new Error(`用例中断调度无法应用于当前映像：${issue}`);
  }
  return { image, caseId: manifest.caseId, externalInterrupts: schedule.map((victimPc) => ({ victimPc, occurrence: 1 })) };
}

async function readSnapshot(caseDir: string, reference: AsmCaseSnapshot, maximumBytes: number, label: string): Promise<Buffer> {
  const bytes = await readBoundedRegularFile(await containedFile(caseDir, reference.path), {
    maximumBytes, expectedBytes: reference.bytes, label
  });
  if (sha256Bytes(bytes) !== reference.sha256.toLowerCase()) throw new Error(`${label} 已被修改，无法复现原用例。`);
  return bytes;
}

async function containedFile(caseDir: string, relative: string): Promise<string> {
  if (!isSafeCaseRelativePath(relative)) throw new Error('用例文件路径无效。');
  const file = path.join(caseDir, ...relative.split('/'));
  await assertContainedDirectoryPath(caseDir, path.dirname(file), { allowRoot: true });
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('用例文件必须是目录内的普通文件。');
  return file;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
