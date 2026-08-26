#!/usr/bin/env node
/**
 * Baseline lane template. The verifier copies this file and its two shared
 * helpers into a detached checkout of the fixed historical commit, compiles
 * them there, and therefore resolves this import to that commit's direct
 * runMarsFile implementation.
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import { runMarsFile } from '../../src/mips';
import {
  LEGACY_EQUIVALENCE_SCHEMA_VERSION,
  LegacyEquivalenceLaneManifest,
  LegacyEquivalenceLaneResult,
  describeArtifact,
  expectedVerdictForScenario,
  formatHaltPc,
  parseLaneArguments,
  readLaneInput,
  writeLaneManifest
} from './legacyEquivalenceContract';
import {
  PreparedEquivalenceCase,
  allEquivalenceCases,
  assertPreparedReferenceIdentity,
  headlessServices,
  prepareEquivalenceCase
} from './legacyEquivalenceRuntime';

async function runDirectCase(
  artifactRoot: string,
  item: PreparedEquivalenceCase
): Promise<LegacyEquivalenceLaneResult> {
  await assertPreparedReferenceIdentity(item, 'before');
  const services = headlessServices();
  const assemble = await runMarsFile(services, item.sourceUri, 'dumpText', {
    showMessages: false,
    revealOutput: false,
    courseTrace: true,
    dumpOutputFile: vscode.Uri.file(item.machineCodeFile)
  });

  let execute: Awaited<ReturnType<typeof runMarsFile>> | undefined;
  if (assemble?.result.ok && assemble.courseHaltPc !== undefined) {
    execute = await runMarsFile(services, item.sourceUri, 'run', {
      showMessages: false,
      revealOutput: false,
      courseTrace: true,
      traceOutput: true,
      traceLevel: 2,
      maxSteps: item.maxSteps,
      haltPc: assemble.courseHaltPc,
      runOutputFile: vscode.Uri.file(item.traceFile)
    });
  }
  await assertPreparedReferenceIdentity(item, 'after');

  return {
    caseId: item.caseId,
    role: item.role,
    referenceSha256: item.referenceSha256,
    profile: item.profile,
    scenario: item.scenario,
    expectedVerdict: expectedVerdictForScenario(item.scenario),
    verdict: assemble?.result.ok && execute?.result.ok ? 'passed' : 'failed',
    haltPc: formatHaltPc(assemble?.courseHaltPc),
    machineCode: await describeArtifact(artifactRoot, item.machineCodeFile),
    trace: await describeArtifact(artifactRoot, item.traceFile),
    assembleExitCode: assemble?.result.exitCode ?? null,
    executeExitCode: execute?.result.exitCode ?? null,
    // Pre-migration runMarsFile did not return an artifact identity. The lane
    // verifies the configured JAR immediately before and after execution.
    engineSha256: item.referenceSha256
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseLaneArguments(argv);
  const input = await readLaneInput(args.input);
  await fs.promises.mkdir(args.artifacts, { recursive: false });
  const cases: LegacyEquivalenceLaneResult[] = [];
  for (const item of allEquivalenceCases(input)) {
    const prepared = await prepareEquivalenceCase(
      args.artifacts,
      input,
      item.reference,
      item.profile,
      item.scenario
    );
    cases.push(await runDirectCase(args.artifacts, prepared));
  }
  const manifest: LegacyEquivalenceLaneManifest = {
    schemaVersion: LEGACY_EQUIVALENCE_SCHEMA_VERSION,
    implementation: 'baseline-direct-runMarsFile',
    cases
  };
  await writeLaneManifest(args.manifest, manifest);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`legacy-baseline: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
