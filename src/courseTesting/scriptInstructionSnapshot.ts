// @index course-testing — Case-local immutable script ISA capture and authenticated replay
import * as path from 'path';
import type { AsmCaseManifestUnion, AsmCaseManifestV2 } from './manifestCodec';
import type { ScriptInstructionBundle } from '../mips/host/scriptInstructionBundle';
import { validateScriptInstructionBundle } from '../mips/host/scriptInstructionBundle';
import { WorkspaceCustomInstructions } from '../mips/host/customInstructionService';
import { scriptInstructionArtifact, assertScriptArtifactMatches } from '../mips/replay/scriptInstructionArtifact';
import { writeFileAtomicReplace } from '../mips/replay/atomicFile';
import { readBoundedRegularFile } from '../mips/replay/boundedFile';
import { sha256Bytes } from '../mips/replay/canonical';
import { ensureContainedDirectoryPath } from '../pathContainment';

const snapshotPath = 'source/custom-instructions.json';
const marker = 'customInstructions.captured';

export async function captureCaseScriptInstructions(caseDir: string, manifest: AsmCaseManifestV2,
  workspaceRoot: string, supplied?: ScriptInstructionBundle | null): Promise<AsmCaseManifestV2> {
  const bundle = supplied === undefined ? await new WorkspaceCustomInstructions(workspaceRoot).captureScripts() : supplied;
  const metadata = { ...manifest.metadata, [marker]: 'true' };
  if (!bundle) return { ...manifest, metadata };
  const artifact = scriptInstructionArtifact(bundle);
  await ensureContainedDirectoryPath(caseDir, path.join(caseDir, 'source'));
  await writeFileAtomicReplace(path.join(caseDir, ...snapshotPath.split('/')), artifact.bytes);
  return { ...manifest,
    metadata: { ...metadata, 'customInstructions.digest': bundle.digest },
    artifacts: { ...manifest.artifacts, source: { ...manifest.artifacts?.source,
      customInstructions: { path: snapshotPath, sha256: artifact.identity.sha256, bytes: artifact.bytes.length }
    } }
  };
}

/** null records an empty registry; historical cases also remain independent of today's workspace scripts. */
export async function loadCaseScriptInstructions(caseDir: string, manifest: AsmCaseManifestUnion): Promise<ScriptInstructionBundle | null> {
  if (manifest.version !== 2) return null;
  const reference = manifest.artifacts?.source?.customInstructions;
  if (!reference) {
    if (manifest.metadata?.['customInstructions.digest']) throw new Error('用例缺少自定义指令快照');
    assertScriptArtifactMatches(manifest.program?.assembler.artifact, undefined);
    assertScriptArtifactMatches(manifest.oracle?.engine.artifact, undefined);
    return null;
  }
  if (typeof reference === 'string' || reference.path !== snapshotPath) throw new Error('自定义指令快照路径或身份无效');
  const bytes = await readBoundedRegularFile(path.join(caseDir, ...snapshotPath.split('/')), {
    maximumBytes: 16 * 1024 * 1024, expectedBytes: reference.bytes, label: '自定义指令快照'
  });
  if (sha256Bytes(bytes) !== reference.sha256) throw new Error('自定义指令快照已偏离保存的指纹');
  const bundle = validateScriptInstructionBundle(JSON.parse(bytes.toString('utf8')));
  if (manifest.metadata?.['customInstructions.digest'] !== bundle.digest) throw new Error('自定义指令快照与用例注册表指纹不一致');
  assertScriptArtifactMatches(manifest.program?.assembler.artifact, bundle);
  assertScriptArtifactMatches(manifest.oracle?.engine.artifact, bundle);
  return bundle;
}
