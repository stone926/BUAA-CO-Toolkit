import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AppServices } from '../../src/types';
import {
  LEGACY_EQUIVALENCE_PROFILES,
  LEGACY_EQUIVALENCE_SCENARIOS,
  LegacyEquivalenceInput,
  LegacyEquivalenceProfile,
  LegacyEquivalenceScenario,
  LegacyReferenceInput,
  equivalenceCaseId,
  sha256,
  sourceForEquivalenceCase
} from './legacyEquivalenceContract';
import { configureHeadlessWorkspace } from './vscodeShim';

export interface PreparedEquivalenceCase {
  caseId: string;
  role: string;
  referenceJar: string;
  referenceSha256: string;
  profile: LegacyEquivalenceProfile;
  scenario: LegacyEquivalenceScenario;
  sourceUri: vscode.Uri;
  machineCodeFile: string;
  traceFile: string;
  maxSteps: number;
}

export class QuietOutput {
  append(_value: string): void {}
  appendLine(_value: string): void {}
  show(): void {}
  hide(): void {}
  clear(): void {}
  replace(_value: string): void {}
  dispose(): void {}
}

export function headlessServices(): AppServices {
  return {
    output: new QuietOutput() as unknown as AppServices['output'],
    statusBar: {
      text: '',
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined
    } as unknown as AppServices['statusBar']
  };
}

export async function prepareEquivalenceCase(
  artifactRoot: string,
  input: LegacyEquivalenceInput,
  reference: LegacyReferenceInput,
  profile: LegacyEquivalenceProfile,
  scenario: LegacyEquivalenceScenario
): Promise<PreparedEquivalenceCase> {
  const caseId = equivalenceCaseId(reference.role, profile, scenario);
  const workspace = path.join(artifactRoot, 'cases', caseId);
  const sourceFile = path.join(workspace, 'program.asm');
  const machineCodeFile = path.join(workspace, 'machine.txt');
  const traceFile = path.join(workspace, 'trace.txt');
  await fs.promises.mkdir(workspace, { recursive: true });
  await fs.promises.writeFile(sourceFile, sourceForEquivalenceCase(profile, scenario), { encoding: 'utf8', flag: 'wx' });

  configureHeadlessWorkspace({
    workspaceRoot: workspace,
    config: {
      'project.profile': profile,
      'project.machineCode': 'code.txt',
      'toolchain.java': input.java,
      'toolchain.mars': reference.jar,
      'toolchain.marsP7': reference.jar,
      'mips.memoryConfiguration': profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText',
      'mips.extraArgs': [],
      'run.timeoutMs': 120000,
      'run.showCommandBeforeRun': false
    }
  });

  return {
    caseId,
    role: reference.role,
    referenceJar: reference.jar,
    referenceSha256: reference.sha256,
    profile,
    scenario,
    sourceUri: vscode.Uri.file(sourceFile),
    machineCodeFile,
    traceFile,
    maxSteps: profile === 'P7' ? 512 : 256
  };
}

export async function assertPreparedReferenceIdentity(
  item: PreparedEquivalenceCase,
  phase: 'before' | 'after'
): Promise<void> {
  const bytes = await fs.promises.readFile(item.referenceJar);
  assertLane(
    sha256(bytes) === item.referenceSha256,
    `${item.caseId}: reference JAR identity drifted ${phase} historical execution`
  );
}

export function allEquivalenceCases(input: LegacyEquivalenceInput): Array<{
  reference: LegacyReferenceInput;
  profile: LegacyEquivalenceProfile;
  scenario: LegacyEquivalenceScenario;
}> {
  return input.references.flatMap((reference) =>
    LEGACY_EQUIVALENCE_PROFILES.flatMap((profile) =>
      LEGACY_EQUIVALENCE_SCENARIOS.map((scenario) => ({ reference, profile, scenario }))
    )
  );
}

export function assertLane(condition: unknown, message: string, detail?: unknown): asserts condition {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  }
}
