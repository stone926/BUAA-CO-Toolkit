#!/usr/bin/env node
/** Current lane: exercise only the production LegacyMarsProvider surface. */
import * as fs from 'fs';
import * as vscode from 'vscode';
import { LegacyMarsProvider } from '../../src/mips/providers/legacyMarsProvider';
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
  assertLane,
  headlessServices,
  prepareEquivalenceCase
} from './legacyEquivalenceRuntime';

async function runProviderCase(
  artifactRoot: string,
  item: PreparedEquivalenceCase
): Promise<LegacyEquivalenceLaneResult> {
  const provider = new LegacyMarsProvider(headlessServices());
  const assembleRequest = {
    sourceUri: item.sourceUri,
    target: { kind: 'userText' as const, outputFile: vscode.Uri.file(item.machineCodeFile) },
    courseTrace: true,
    revealOutput: false
  };
  const assemblePreflight = await provider.preflight(assembleRequest);
  assertLane(assemblePreflight.ok, `${item.caseId}: provider assemble preflight failed`, assemblePreflight);
  const assemble = await provider.assemble(assembleRequest);

  let execute: Awaited<ReturnType<LegacyMarsProvider['execute']>> | undefined;
  if (assemble.ok && assemble.courseHaltPc !== undefined && assemble.image) {
    // The executor contract takes the immutable domain image the assembler
    // produced plus the provider-owned binding; `imageRef`/`traceLevel` were the
    // pre-provider MARS request fields and no longer exist on ExecuteRequest.
    const executeRequest = {
      image: assemble.image,
      ...(assemble.executionBinding ? { executionBinding: assemble.executionBinding } : {}),
      courseTrace: true,
      trace: { kind: 'architectural-writes' as const, courseCorrect: true as const },
      maxSteps: item.maxSteps,
      haltPc: assemble.courseHaltPc,
      runOutputFile: vscode.Uri.file(item.traceFile),
      revealOutput: false
    };
    const executePreflight = await provider.preflight(executeRequest);
    assertLane(executePreflight.ok, `${item.caseId}: provider execute preflight failed`, executePreflight);
    execute = await provider.execute(executeRequest);
  }

  return {
    caseId: item.caseId,
    role: item.role,
    referenceSha256: item.referenceSha256,
    profile: item.profile,
    scenario: item.scenario,
    expectedVerdict: expectedVerdictForScenario(item.scenario),
    verdict: assemble.ok && execute?.ok ? 'passed' : 'failed',
    haltPc: formatHaltPc(assemble.courseHaltPc),
    machineCode: await describeArtifact(artifactRoot, item.machineCodeFile),
    trace: await describeArtifact(artifactRoot, item.traceFile),
    assembleExitCode: assemble.status.exitCode,
    executeExitCode: execute?.status.exitCode ?? null,
    engineSha256: execute?.engineArtifact?.sha256 ?? assemble.engineArtifact?.sha256 ?? null
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
    cases.push(await runProviderCase(args.artifacts, prepared));
  }
  const manifest: LegacyEquivalenceLaneManifest = {
    schemaVersion: LEGACY_EQUIVALENCE_SCHEMA_VERSION,
    implementation: 'current-legacy-provider',
    cases
  };
  await writeLaneManifest(args.manifest, manifest);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`legacy-equivalence-current: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
