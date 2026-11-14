// @index mips-replay — Bind script source/JavaScript closure to the compiled reference engine
import type { EngineArtifactIdentity } from '../providers/contracts';
import type { ScriptInstructionBundle } from '../host/scriptInstructionBundle';
import { validateScriptInstructionBundle } from '../host/scriptInstructionBundle';
import { canonicalJson, sha256Bytes, type CanonicalJson } from './canonical';

export const scriptInstructionArtifactRole = 'custom-script-instructions';
export const scriptInstructionArtifactName = 'custom-instructions.json';

export function scriptInstructionArtifact(bundle: ScriptInstructionBundle): { bytes: Buffer; identity: EngineArtifactIdentity } {
  validateScriptInstructionBundle(bundle);
  const bytes = Buffer.from(canonicalJson(bundle as unknown as CanonicalJson), 'utf8');
  return { bytes, identity: { role: scriptInstructionArtifactRole, fileName: scriptInstructionArtifactName, sha256: sha256Bytes(bytes) } };
}

export function withScriptInstructionArtifact(base: EngineArtifactIdentity | undefined, bundle: ScriptInstructionBundle): EngineArtifactIdentity {
  if (!base) throw new Error('自定义指令参考未绑定内置引擎版本');
  return { ...base, dependencies: [...(base.dependencies ?? []), scriptInstructionArtifact(bundle).identity] };
}

export function assertScriptArtifactMatches(expected: EngineArtifactIdentity | undefined, bundle: ScriptInstructionBundle | undefined): void {
  if (!expected) return;
  const dependencies = expected.dependencies?.filter(item => item.role === scriptInstructionArtifactRole) ?? [];
  if (dependencies.length !== (bundle ? 1 : 0)
    || (bundle && dependencies[0]?.sha256 !== scriptInstructionArtifact(bundle).identity.sha256)) {
    throw new Error('自定义指令快照与原用例参考引擎指纹不一致');
  }
}
