import { CO_CASES_DIR } from './constants';
import * as crypto from 'crypto';
import * as path from 'path';

export const asmCaseManifestVersion = 1;
export const asmCaseProgramFileName = 'program.asm';
export const asmCaseMachineCodeFileName = 'code.txt';
export const asmCaseManifestFileName = 'case.json';

export type AsmCaseSourceKind = 'selected' | 'generator' | 'builtin';
export type AsmCaseArtifactKind = 'verilog' | 'logisim' | 'mars' | 'source';

export interface AsmCaseSource {
  kind: AsmCaseSourceKind;
  generator?: string;
  commandLine?: string;
  cwd?: string;
}

export interface AsmCaseSnapshot {
  path: string;
  sha256: string;
  bytes: number;
}

export interface AsmCaseStdinSnapshot {
  originalPath: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface AsmCaseMachineCode {
  path: string;
  sha256: string;
  bytes: number;
  wordCount: number;
  /** PC of the validated final user-text self-branch (before any P7 kernel merge). */
  haltPc?: number;
}

export interface AsmCaseMarsRun {
  commandLine: string;
  cwd: string;
  memoryConfiguration: string;
}

export interface AsmCaseP7Metadata {
  interruptSchedule?: number[];
  probe?: unknown;
}

export interface AsmCaseArtifacts {
  verilog?: Record<string, string>;
  logisim?: Record<string, string>;
  mars?: Record<string, string>;
  source?: Record<string, string>;
  /** v2-only groups surfaced through the normalized v1 view. */
  program?: Record<string, string>;
  referenceMars?: Record<string, string>;
  /** All groups share one shape; keeps Object.entries on its string overload. */
  [kind: string]: Record<string, string> | undefined;
}

export interface AsmCaseManifest {
  version: typeof asmCaseManifestVersion;
  caseId: string;
  createdAt: string;
  profile: string;
  originalAsmPath: string;
  asmSnapshot: AsmCaseSnapshot;
  source: AsmCaseSource;
  stdin?: AsmCaseStdinSnapshot;
  machineCode?: AsmCaseMachineCode;
  mars?: AsmCaseMarsRun;
  p7?: AsmCaseP7Metadata;
  artifacts?: AsmCaseArtifacts;
}

export interface AsmCasePaths {
  caseDir: string;
  manifest: string;
  asm: string;
  machineCode: string;
  stdinDir: string;
  verilogDir: string;
  logisimDir: string;
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256Bytes(bytes: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function asmCaseId(createdAt: Date, asmSha256: string): string {
  const timestamp = createdAt.toISOString().replace(/[-:.]/g, '');
  return `${timestamp}-${asmSha256.slice(0, 8)}`;
}

export function asmCasePaths(workspaceRoot: string, caseId: string): AsmCasePaths {
  const caseDir = path.join(workspaceRoot, CO_CASES_DIR, caseId);
  return {
    caseDir,
    manifest: path.join(caseDir, asmCaseManifestFileName),
    asm: path.join(caseDir, asmCaseProgramFileName),
    machineCode: path.join(caseDir, asmCaseMachineCodeFileName),
    stdinDir: path.join(caseDir, 'stdin'),
    verilogDir: path.join(caseDir, 'verilog'),
    logisimDir: path.join(caseDir, 'logisim')
  };
}

export function machineCodeWordCount(text: string): number {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

export function mergeAsmCaseArtifacts(
  manifest: AsmCaseManifest,
  kind: AsmCaseArtifactKind,
  artifacts: Record<string, string>
): AsmCaseManifest {
  return {
    ...manifest,
    artifacts: {
      ...(manifest.artifacts ?? {}),
      [kind]: {
        ...(manifest.artifacts?.[kind] ?? {}),
        ...artifacts
      }
    }
  };
}
