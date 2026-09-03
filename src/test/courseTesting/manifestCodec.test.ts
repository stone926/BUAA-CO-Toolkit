import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  AsmCaseManifestV2,
  type ManifestRunConfiguration,
  asmCaseManifestVersion2,
  isSafeCaseRelativePath,
  isKnownManifest,
  isManifestV2,
  manifestArtifactsOf,
  manifestMachineCodeOf,
  manifestRunConfigurationHash,
  v2ArtifactGroup,
  v2ReplayBundleIssues,
  v2ReplayClosureIssues,
  writeManifestAtomic
} from '../../courseTesting/manifestCodec';
import { AsmCaseManifest } from '../../asmCaseStoreCore';
import {
  createLegacyProgramImage,
  observabilitySchemaDigest,
  oracleEvidenceDigests,
  serializeObservabilitySchema,
  serializeProgramImage
} from '../../mips/replay/programImage';
import { captureSourceGraph } from '../../mips/replay/sourceBundle';
import {
  maximumReplayMachineCodeBytes,
  maximumReplayMachineCodeWords,
  maximumReplaySnapshotBytes,
  maximumReplayStdinBytes,
  maximumReplayTraceBytes
} from '../../mips/replay/boundedFile';
import { canonicalJson, sha256Canonical, type CanonicalJson } from '../../mips/replay/canonical';
import { buildProgramImage } from '../../mips/core/programImage';
import {
  courseInstructionImageWords,
  wordsToHexText
} from '../../mips/core/assembler/artifacts';
import type { ProgramImage } from '../../mips/core/api';

const v1Manifest: AsmCaseManifest = {
  version: 1,
  caseId: 'case-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  profile: 'P4',
  originalAsmPath: 'E:/work/src/test.asm',
  asmSnapshot: { path: 'E:/work/.co/cases/case-1/program.asm', sha256: 'a'.repeat(64), bytes: 3 },
  source: { kind: 'selected' },
  machineCode: { path: 'E:/work/.co/cases/case-1/code.txt', sha256: 'b'.repeat(64), bytes: 8, wordCount: 2, haltPc: 0x3004 },
  mars: { commandLine: 'java -jar Mars.jar', cwd: 'E:/work', memoryConfiguration: 'FixedCompactLargeText' },
  artifacts: {
    verilog: { traceOut: 'E:/work/.co/cases/case-1/verilog/sim.out' },
    mars: { traceOut: 'E:/work/.co/cases/case-1/mars/mars.out' },
    source: { original: 'E:/work/src/test.asm' }
  }
};

const testEngine = {
  id: 'legacy-mars-configured', semanticsRevision: 1, capabilitiesRevision: 1,
  build: 'test', catalogRevision: 1, courseContractRevision: 1, normalizerRevision: 1, eventSchemaRevision: 1,
  artifact: { sha256: 'b'.repeat(64), role: 'user-configured-mars', fileName: 'Mars.jar' },
  legacyProvenance: {
    commandLine: 'java -jar Mars.jar', cwd: 'E:/work', memoryConfiguration: 'CompactLargeText',
    profile: 'P7', runtime: { kind: 'java' as const, command: 'java' }, wallClockMs: 10_000,
    p7RiInstruction: false
  }
};
const testRunConfiguration = {
  profile: 'P7',
  memoryConfiguration: 'CompactLargeText',
  courseTrace: true,
  traceOutput: true,
  traceLevel: 1 as const,
  maxSteps: 64,
  haltPc: 0x3004,
  interruptSchedule: [],
  executionOptions: {
    delayedBranching: true, courseTrace: true, traceOutput: true, traceLevel: 1 as const, p7RiInstruction: false
  },
  stdin: { sha256: null, bytes: 0, mode: 'bytes' as const },
  deviceTimeline: { schemaRevision: 1 as const, events: [], probeMetadataDigest: null },
  cycleContract: { id: 'buaa-co-p7-cycle-contract', revision: 1 },
  stopPolicy: { kind: 'halt-loop' as const, haltPc: 0x3004 },
  haltPolicy: { kind: 'course-self-branch-nop' as const, branchWord: 0x1000ffff, delaySlotWord: 0 },
  stepPolicy: { unit: 'architectural-instruction' as const, limit: 64 },
  seed: null,
  resourceLimits: {
    wallClockMs: 10_000, maxSteps: 64, maxTraceBytes: maximumReplayTraceBytes,
    maxSourceBytes: 1024, maxIncludeDepth: 8, maxIncludeUnits: 8
  },
  runtime: { kind: 'java' as const, command: 'java' }
} satisfies ManifestRunConfiguration;

function artifact(path: string, digest = 'd'): { path: string; sha256: string; bytes: number } {
  return { path, sha256: digest.repeat(64), bytes: 1 };
}

const v2Manifest: AsmCaseManifestV2 = {
  version: asmCaseManifestVersion2,
  caseId: 'case-2',
  createdAt: '2026-01-02T00:00:00.000Z',
  profile: 'P7',
  originalAsmPath: 'E:/work/src/test7.asm',
  asmSnapshot: { path: 'program.asm', sha256: 'a'.repeat(64), bytes: 3 },
  source: { kind: 'builtin' },
  program: {
    assembler: testEngine,
    imageFingerprint: 'c'.repeat(64),
    machineCode: { path: 'code.txt', sha256: 'd'.repeat(64), bytes: 8, wordCount: 2, haltPc: 0x3004 },
    sourceGraph: artifact('source/graph.json'),
    image: artifact('program/image.json'),
    observability: {
      path: 'program/observability.json', sha256: observabilitySchemaDigest(),
      bytes: serializeObservabilitySchema().byteLength
    },
    dutInput: { path: 'code.txt', sha256: 'd'.repeat(64), bytes: 8 }
  },
  oracle: {
    engine: testEngine,
    configurationHash: manifestRunConfigurationHash(testRunConfiguration, testEngine),
    runConfiguration: testRunConfiguration,
    stopReason: 'halt-loop',
    steps: 1,
    eventCount: 1,
    rawOutputDigest: '1'.repeat(64),
    eventDigest: '2'.repeat(64),
    finalStateDigest: '3'.repeat(64)
  },
  artifacts: {
    program: {
      image: artifact('program/image.json'),
      observability: {
        path: 'program/observability.json', sha256: observabilitySchemaDigest(),
        bytes: serializeObservabilitySchema().byteLength
      },
      dutInput: { path: 'code.txt', sha256: 'd'.repeat(64), bytes: 8 }
    },
    oracle: { traceOut: artifact('oracle/mars.out') },
    dut: {
      'verilog/traceOut': artifact('verilog/sim.out'),
      'logisim/preparedCircuit': artifact('logisim/cpu.circ')
    },
    source: {
      graph: artifact('source/graph.json'),
      original: { path: 'program.asm', sha256: 'a'.repeat(64), bytes: 3 }
    }
  }
};

describe('manifest v1/v2 codec', () => {
  it('requires canonical POSIX separators for replay snapshot paths', () => {
    expect(isSafeCaseRelativePath('source/graph.json')).toBe(true);
    expect(isSafeCaseRelativePath('source\\graph.json')).toBe(false);
  });

  it('classifies v1 and v2 manifests and rejects unknown shapes', () => {
    expect(isKnownManifest(v1Manifest)).toBe(true);
    expect(isKnownManifest(v2Manifest)).toBe(true);
    expect(isKnownManifest(null)).toBe(false);
    expect(isKnownManifest({ version: 3, caseId: 'x' })).toBe(false);
    expect(isKnownManifest({ version: 1 })).toBe(false);
    expect(isKnownManifest({ version: 2, caseId: 'x', program: {}, oracle: {} })).toBe(false);
    expect(isKnownManifest({ ...v2Manifest, artifacts: { unexpected: {} } })).toBe(false);
    expect(isKnownManifest({ ...v2Manifest, metadata: { valid: 1 } })).toBe(false);
    expect(isKnownManifest({ ...v2Manifest, metadata: { valid: '' } })).toBe(false);
    expect(isKnownManifest({ ...v2Manifest, asmSnapshot: { ...v2Manifest.asmSnapshot, typo: true } })).toBe(false);
    expect(isKnownManifest({
      ...v2Manifest,
      oracle: {
        ...v2Manifest.oracle,
        runConfiguration: { ...testRunConfiguration, maxStep: 1 }
      }
    })).toBe(false);
  });

  it('reads machine code from v1 top-level and v2 program section', () => {
    expect(manifestMachineCodeOf(v1Manifest)?.haltPc).toBe(0x3004);
    expect(manifestMachineCodeOf(v2Manifest)?.haltPc).toBe(0x3004);
    expect(manifestMachineCodeOf(v2Manifest)?.path).toBe('code.txt');
  });

  it('normalizes v1 artifacts unchanged', () => {
    const view = manifestArtifactsOf(v1Manifest);
    expect(view.verilog?.traceOut).toBe('E:/work/.co/cases/case-1/verilog/sim.out');
    expect(view.mars?.traceOut).toBe('E:/work/.co/cases/case-1/mars/mars.out');
    expect(view.source?.original).toBe('E:/work/src/test.asm');
  });

  it('keeps v2 oracle terminology while exposing DUT compatibility prefixes', () => {
    const view = manifestArtifactsOf(v2Manifest);
    expect(view.oracle?.traceOut).toBe('oracle/mars.out');
    expect(view.verilog?.traceOut).toBe('verilog/sim.out');
    expect(view.logisim?.preparedCircuit).toBe('logisim/cpu.circ');
    expect(view.source?.original).toBe('program.asm');
  });

  it('maps v1 artifact kinds to v2 groups and keys', () => {
    expect(v2ArtifactGroup('mars', 'traceOut')).toEqual({ group: 'oracle', key: 'traceOut' });
    expect(v2ArtifactGroup('verilog', 'traceOut')).toEqual({ group: 'dut', key: 'verilog/traceOut' });
    expect(v2ArtifactGroup('logisim', 'preparedCircuit')).toEqual({ group: 'dut', key: 'logisim/preparedCircuit' });
    expect(v2ArtifactGroup('source', 'original')).toEqual({ group: 'source', key: 'original' });
  });

  it('accepts a dumped v2 manifest as a phase-1 replay closure', () => {
    expect(v2ReplayClosureIssues(v2Manifest)).toEqual([]);
    const incomplete: AsmCaseManifestV2 = {
      ...v2Manifest,
      program: { ...v2Manifest.program, machineCode: undefined }
    };
    const issues = v2ReplayClosureIssues(incomplete);
    expect(issues).toContain('program.machineCode.sha256 missing or invalid (image not dumped yet)');
  });

  it('binds the legacy assembly launch tuple independently from the oracle run', () => {
    const tampered: AsmCaseManifestV2 = {
      ...v2Manifest,
      program: {
        ...v2Manifest.program,
        assembler: {
          ...v2Manifest.program.assembler,
          legacyProvenance: {
            ...v2Manifest.program.assembler.legacyProvenance,
            memoryConfiguration: 'FixedCompactLargeText'
          }
        }
      }
    };

    expect(v2ReplayClosureIssues(tampered)).toContain(
      'legacy assembler and oracle memory configurations differ'
    );
  });

  it('reads early-v2 string artifacts but excludes them from replay closure', () => {
    const earlyV2: AsmCaseManifestV2 = {
      ...v2Manifest,
      artifacts: { oracle: { traceOut: 'oracle/mars.out' } }
    };
    expect(isKnownManifest(earlyV2)).toBe(true);
    expect(v2ReplayClosureIssues(earlyV2)).toContain(
      'artifacts.oracle.traceOut is an unhashed early-v2 reference'
    );
  });

  it('rejects run-configuration drift even when the stored digest looks valid', () => {
    const tampered: AsmCaseManifestV2 = {
      ...v2Manifest,
      oracle: {
        ...v2Manifest.oracle,
        runConfiguration: { ...testRunConfiguration, maxSteps: 1 }
      }
    };
    expect(v2ReplayClosureIssues(tampered)).toContain(
      'oracle.configurationHash does not match the engine/run configuration'
    );
  });

  it('shares the production legacy profile and memory-layout policy with replay closure', () => {
    const unsupportedConfiguration = {
      ...testRunConfiguration,
      profile: 'P8',
      memoryConfiguration: 'CompactLargeText',
      executionOptions: { ...testRunConfiguration.executionOptions, delayedBranching: false },
      cycleContract: { id: 'architectural-commit-v1', revision: 1 }
    };
    const unsupported: AsmCaseManifestV2 = {
      ...v2Manifest,
      profile: 'P8',
      p7: undefined,
      oracle: {
        ...v2Manifest.oracle,
        runConfiguration: unsupportedConfiguration,
        configurationHash: manifestRunConfigurationHash(unsupportedConfiguration, testEngine)
      }
    };
    expect(v2ReplayClosureIssues(unsupported).some((issue) =>
      issue.includes('legacy-mars.profile-unsupported'))).toBe(true);

    const wrongP7Memory = { ...testRunConfiguration, memoryConfiguration: 'FixedCompactLargeText' };
    const wrongMemory: AsmCaseManifestV2 = {
      ...v2Manifest,
      oracle: {
        ...v2Manifest.oracle,
        runConfiguration: wrongP7Memory,
        configurationHash: manifestRunConfigurationHash(wrongP7Memory, testEngine)
      }
    };
    expect(v2ReplayClosureIssues(wrongMemory).some((issue) =>
      issue.includes('legacy-mars.p7-memory-configuration'))).toBe(true);
  });

  it('rejects non-P7 state and the wrong cycle contract after the configuration hash is recomputed', () => {
    const configuration = {
      ...testRunConfiguration,
      profile: 'P6',
      interruptSchedule: [0x3000],
      executionOptions: { ...testRunConfiguration.executionOptions, p7RiInstruction: true },
      deviceTimeline: {
        ...testRunConfiguration.deviceTimeline,
        events: [{ kind: 'external-interrupt' as const, trigger: 'macro-pc' as const, value: 0x3000 }]
      }
    };
    const tampered: AsmCaseManifestV2 = {
      ...v2Manifest,
      profile: 'P6',
      p7: { interruptSchedule: [0x3000] },
      oracle: {
        ...v2Manifest.oracle,
        runConfiguration: configuration,
        configurationHash: manifestRunConfigurationHash(configuration, testEngine)
      }
    };

    expect(v2ReplayClosureIssues(tampered)).toEqual(expect.arrayContaining([
      'manifest.p7 is forbidden outside the P7 profile',
      'oracle.runConfiguration.interruptSchedule must be empty outside the P7 profile',
      'oracle.runConfiguration.deviceTimeline must be empty outside the P7 profile',
      'oracle.runConfiguration.executionOptions.p7RiInstruction is forbidden outside the P7 profile',
      'oracle.runConfiguration.cycleContract must be architectural-commit-v1/rev1'
    ]));
  });

  it('binds the P7 RI instruction flag to exactly one dependency on both engines', () => {
    const riDependency = {
      sha256: 'e'.repeat(64), role: 'mars-p7-ri-instruction-class', fileName: 'P7RI.class'
    };
    const riEngine = {
      ...testEngine,
      artifact: { ...testEngine.artifact, dependencies: [riDependency] },
      legacyProvenance: { ...testEngine.legacyProvenance, p7RiInstruction: true }
    };
    const enabled = {
      ...testRunConfiguration,
      executionOptions: { ...testRunConfiguration.executionOptions, p7RiInstruction: true }
    };
    const valid: AsmCaseManifestV2 = {
      ...v2Manifest,
      program: { ...v2Manifest.program, assembler: riEngine },
      oracle: {
        ...v2Manifest.oracle,
        engine: riEngine,
        runConfiguration: enabled,
        configurationHash: manifestRunConfigurationHash(enabled, riEngine)
      }
    };
    expect(v2ReplayClosureIssues(valid)).toEqual([]);

    const missingDependencies: AsmCaseManifestV2 = {
      ...v2Manifest,
      oracle: {
        ...v2Manifest.oracle,
        runConfiguration: enabled,
        configurationHash: manifestRunConfigurationHash(enabled, testEngine)
      }
    };
    expect(v2ReplayClosureIssues(missingDependencies)).toEqual(expect.arrayContaining([
      'program.assembler must have exactly one mars-p7-ri-instruction-class dependency when p7RiInstruction is enabled',
      'oracle.engine must have exactly one mars-p7-ri-instruction-class dependency when p7RiInstruction is enabled'
    ]));

    const duplicateEngine = {
      ...riEngine,
      artifact: {
        ...riEngine.artifact,
        dependencies: [riDependency, { ...riDependency, sha256: 'f'.repeat(64), fileName: 'P7RI-copy.class' }]
      }
    };
    const duplicatedDependencies: AsmCaseManifestV2 = {
      ...v2Manifest,
      program: { ...v2Manifest.program, assembler: duplicateEngine },
      oracle: {
        ...v2Manifest.oracle,
        engine: duplicateEngine,
        runConfiguration: enabled,
        configurationHash: manifestRunConfigurationHash(enabled, duplicateEngine)
      }
    };
    expect(v2ReplayClosureIssues(duplicatedDependencies)).toEqual(expect.arrayContaining([
      'program.assembler must have exactly one mars-p7-ri-instruction-class dependency when p7RiInstruction is enabled',
      'oracle.engine must have exactly one mars-p7-ri-instruction-class dependency when p7RiInstruction is enabled'
    ]));

    const disabledWithDependencies: AsmCaseManifestV2 = {
      ...v2Manifest,
      program: { ...v2Manifest.program, assembler: riEngine },
      oracle: {
        ...v2Manifest.oracle,
        engine: riEngine,
        configurationHash: manifestRunConfigurationHash(testRunConfiguration, riEngine)
      }
    };
    expect(v2ReplayClosureIssues(disabledWithDependencies)).toEqual(expect.arrayContaining([
      'program.assembler must not have a mars-p7-ri-instruction-class dependency when p7RiInstruction is disabled',
      'oracle.engine must not have a mars-p7-ri-instruction-class dependency when p7RiInstruction is disabled'
    ]));
  });

  it('bounds and deduplicates snapshot closure work and legacy engine dependencies', () => {
    const conflicting: AsmCaseManifestV2 = {
      ...v2Manifest,
      artifacts: {
        ...v2Manifest.artifacts,
        referenceMars: {
          samePathDifferentIdentity: {
            path: v2Manifest.asmSnapshot.path,
            sha256: 'f'.repeat(64),
            bytes: v2Manifest.asmSnapshot.bytes
          }
        }
      }
    };
    expect(v2ReplayClosureIssues(conflicting)).toContain(
      'artifacts.referenceMars.samePathDifferentIdentity conflicts with asmSnapshot for the same case-relative path'
    );

    const caseColliding: AsmCaseManifestV2 = {
      ...v2Manifest,
      artifacts: {
        ...v2Manifest.artifacts,
        referenceMars: {
          caseVariant: {
            ...v2Manifest.asmSnapshot,
            path: v2Manifest.asmSnapshot.path.toUpperCase()
          }
        }
      }
    };
    expect(v2ReplayClosureIssues(caseColliding)).toContain(
      'artifacts.referenceMars.caseVariant case-collides with asmSnapshot for a non-portable case-relative path'
    );

    const tooMany = Object.fromEntries(Array.from({ length: 4100 }, (_, index) => [
      `duplicate-${index}`,
      { ...v2Manifest.asmSnapshot }
    ]));
    expect(v2ReplayClosureIssues({
      ...v2Manifest,
      artifacts: { referenceMars: tooMany }
    })).toContain('replay snapshot reference count exceeds the trusted limit 4096');

    const unexpectedDependency = {
      sha256: 'e'.repeat(64), role: 'unrelated-engine-payload', fileName: 'payload.bin'
    };
    const engine = {
      ...testEngine,
      artifact: { ...testEngine.artifact, dependencies: [unexpectedDependency] }
    };
    const configuration = { ...testRunConfiguration };
    const dependencyIssues = v2ReplayClosureIssues({
      ...v2Manifest,
      program: { ...v2Manifest.program, assembler: engine },
      oracle: {
        ...v2Manifest.oracle,
        engine,
        configurationHash: manifestRunConfigurationHash(configuration, engine)
      }
    });
    expect(dependencyIssues).toEqual(expect.arrayContaining([
      'program.assembler.artifact.dependencies for legacy-mars-configured may contain only one optional mars-p7-ri-instruction-class',
      'oracle.engine.artifact.dependencies for legacy-mars-configured may contain only one optional mars-p7-ri-instruction-class'
    ]));
  });

  it('seals the P7 cycle contract and enforced trace collector limit independently of configurationHash', () => {
    const configuration = {
      ...testRunConfiguration,
      cycleContract: { id: 'architectural-commit-v1', revision: 1 },
      resourceLimits: { ...testRunConfiguration.resourceLimits, maxTraceBytes: 1024 }
    };
    const tampered: AsmCaseManifestV2 = {
      ...v2Manifest,
      oracle: {
        ...v2Manifest.oracle,
        runConfiguration: configuration,
        configurationHash: manifestRunConfigurationHash(configuration, testEngine)
      }
    };
    expect(v2ReplayClosureIssues(tampered)).toEqual(expect.arrayContaining([
      'oracle.runConfiguration.cycleContract must be buaa-co-p7-cycle-contract/rev1',
      `oracle.runConfiguration.resourceLimits.maxTraceBytes must equal the enforced ${maximumReplayTraceBytes}-byte process-output ceiling`
    ]));
  });

  it('rejects deeply nested probe metadata without recursive canonicalization', () => {
    let probe: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 20_000; depth += 1) {
      probe = { next: probe };
    }
    const malicious = {
      ...v2Manifest,
      p7: { probe }
    } as unknown as AsmCaseManifestV2;
    expect(() => v2ReplayClosureIssues(malicious)).not.toThrow();
    expect(v2ReplayClosureIssues(malicious)).toContain(
      'manifest v2 structure is invalid or contains unknown fields'
    );
  });

  it('requires bounded steps and a validated halt PC for replayable course runs', () => {
    const configuration = {
      ...testRunConfiguration,
      maxSteps: undefined,
      haltPc: undefined,
      stopPolicy: { kind: 'halt-loop' as const, haltPc: null },
      stepPolicy: { unit: 'architectural-instruction' as const, limit: null },
      resourceLimits: { ...testRunConfiguration.resourceLimits, maxSteps: null }
    };
    const tampered: AsmCaseManifestV2 = {
      ...v2Manifest,
      oracle: {
        ...v2Manifest.oracle,
        runConfiguration: configuration,
        configurationHash: manifestRunConfigurationHash(configuration, testEngine)
      }
    };

    expect(v2ReplayClosureIssues(tampered)).toEqual(expect.arrayContaining([
      'oracle.runConfiguration.maxSteps must be a positive bounded course-run limit',
      'oracle.runConfiguration halt-loop policy requires the validated machine-code haltPc'
    ]));
    expect(v2ReplayClosureIssues({
      ...v2Manifest,
      oracle: { ...v2Manifest.oracle, stopReason: 'error' }
    })).toContain('oracle.stopReason=error is not supported by phase-1 exact replay');

    const forgedStepLimitConfiguration = {
      ...testRunConfiguration,
      haltPc: 0x3004,
      stopPolicy: { kind: 'step-limit' as const, haltPc: 0x3004 },
      haltPolicy: { kind: 'none' as const, branchWord: null, delaySlotWord: null }
    };
    expect(v2ReplayClosureIssues({
      ...v2Manifest,
      oracle: {
        ...v2Manifest.oracle,
        stopReason: 'step-limit',
        runConfiguration: forgedStepLimitConfiguration,
        configurationHash: manifestRunConfigurationHash(forgedStepLimitConfiguration, testEngine)
      }
    })).toContain('oracle.runConfiguration haltPc must be absent when stopPolicy is not halt-loop');
  });

  it('cross-binds strict HexText, wordCount, ProgramImage text words, DUT bytes, and halt-loop address', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-manifest-program-bind-'));
    try {
      async function bundleIssues(
        machineText: string,
        options: {
          imageText?: string;
          image?: ProgramImage;
          dutText?: string;
          wordCount?: number;
          haltPc?: number;
        } = {}
      ): Promise<string[]> {
        const machineBytes = Buffer.from(machineText, 'utf8');
        const dutBytes = Buffer.from(options.dutText ?? machineText, 'utf8');
        const image = options.image ?? createLegacyProgramImage(
          options.imageText ?? machineText,
          [{ id: 'source-0000', contentHash: 'a'.repeat(64) }]
        );
        const imageBytes = serializeProgramImage(image);
        fs.writeFileSync(path.join(dir, 'code.txt'), machineBytes);
        fs.writeFileSync(path.join(dir, 'dut-code.txt'), dutBytes);
        fs.mkdirSync(path.join(dir, 'program'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'program', 'image.json'), imageBytes);
        const snapshot = (relativePath: string, bytes: Buffer) => ({
          path: relativePath,
          bytes: bytes.byteLength,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        });
        const haltPc = options.haltPc ?? 0x3004;
        const configuration = {
          ...testRunConfiguration,
          haltPc,
          stopPolicy: { kind: 'halt-loop' as const, haltPc }
        };
        const manifest: AsmCaseManifestV2 = {
          ...v2Manifest,
          program: {
            ...v2Manifest.program,
            imageFingerprint: image.fingerprint,
            machineCode: {
              ...snapshot('code.txt', machineBytes),
              wordCount: options.wordCount ?? 3,
              haltPc
            },
            image: snapshot('program/image.json', imageBytes),
            dutInput: snapshot('dut-code.txt', dutBytes)
          },
          artifacts: {
            ...v2Manifest.artifacts,
            program: {
              ...v2Manifest.artifacts?.program,
              image: snapshot('program/image.json', imageBytes),
              dutInput: snapshot('dut-code.txt', dutBytes)
            }
          },
          oracle: {
            ...v2Manifest.oracle,
            runConfiguration: configuration,
            configurationHash: manifestRunConfigurationHash(configuration, testEngine)
          }
        };
        return v2ReplayBundleIssues(manifest, dir);
      }

      const valid = '34010001\n1000ffff\n00000000\n';
      expect(await bundleIssues(valid)).not.toEqual(expect.arrayContaining([
        expect.stringContaining('program.machineCode is not strict HexText'),
        expect.stringContaining('program.machineCode.wordCount mismatch'),
        expect.stringContaining('program.image course IM projection does not match'),
        expect.stringContaining('program.machineCode.haltPc does not identify')
      ]));
      expect(await bundleIssues(valid, { wordCount: 2 })).toContain(
        'program.machineCode.wordCount mismatch: expected 2, parsed 3'
      );
      expect(await bundleIssues(valid, { imageText: '34020002\n1000ffff\n00000000\n' })).toContain(
        'program.image course IM projection does not match program.machineCode/program.dutInput HexText'
      );
      expect(await bundleIssues(valid, { dutText: '34020002\n1000ffff\n00000000\n' })).toEqual(
        expect.arrayContaining([
          'program.dutInput does not identify the exact machine-code bytes',
          'program.dutInput bytes do not exactly match program.machineCode bytes'
        ])
      );
      expect(await bundleIssues('34010001\nnot-hex!\n00000000\n', { imageText: valid })).toEqual(
        expect.arrayContaining([expect.stringContaining('program.machineCode is not strict HexText')])
      );
      expect(await bundleIssues('34010001\n00000000\n00000000\n')).toContain(
        'program.machineCode.haltPc does not identify a 1000ffff/00000000 halt loop in user text'
      );
      expect(await bundleIssues(valid, { haltPc: 0x3000 })).toContain(
        'program.machineCode.haltPc does not identify a 1000ffff/00000000 halt loop in user text'
      );

      const p7Image = buildProgramImage({
        entryPc: 0x3000,
        segments: [
          { name: 'text', baseAddress: 0x3000, words: [0x34010001, 0x1000ffff, 0] },
          { name: 'ktext', baseAddress: 0x4180, words: [0x42000018] }
        ],
        inputGraph: [{ id: 'source-0000', contentHash: 'a'.repeat(64) }]
      });
      const p7MachineText = wordsToHexText(courseInstructionImageWords(p7Image));
      const p7Issues = await bundleIssues(p7MachineText, {
        image: p7Image,
        wordCount: courseInstructionImageWords(p7Image).length,
        haltPc: 0x3004
      });
      expect(p7Issues).not.toEqual(expect.arrayContaining([
        expect.stringContaining('program.image course IM projection does not match'),
        expect.stringContaining('program.machineCode.haltPc')
      ]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives the 4095/4096 capacity boundary from the captured assembler descriptor', () => {
    const withCountAndAssembler = (wordCount: number, assembler: AsmCaseManifestV2['program']['assembler']) => ({
      ...v2Manifest,
      program: {
        ...v2Manifest.program,
        assembler,
        machineCode: { ...v2Manifest.program.machineCode!, wordCount }
      }
    });
    const builtinAssembler = {
      ...testEngine,
      id: 'builtin-ts',
      legacyProvenance: undefined,
      artifact: {
        sha256: 'b'.repeat(64), role: 'builtin-ts-assembler', fileName: 'builtin-ts-assembler.manifest.json'
      }
    };

    expect(v2ReplayClosureIssues(withCountAndAssembler(4095, testEngine)))
      .not.toEqual(expect.arrayContaining([expect.stringContaining('稳定版 MARS')]));
    expect(v2ReplayClosureIssues(withCountAndAssembler(4096, builtinAssembler)))
      .not.toEqual(expect.arrayContaining([expect.stringContaining('最终机器码共有 4096 words')]));
    expect(v2ReplayClosureIssues(withCountAndAssembler(4096, testEngine)))
      .toEqual(expect.arrayContaining([expect.stringContaining('稳定版 MARS v0.6.3')]));
    expect(v2ReplayClosureIssues(withCountAndAssembler(4097, builtinAssembler)))
      .toEqual(expect.arrayContaining([expect.stringContaining('超过教程 IM 4096 words 容量')]));
  });

  it('writes manifests atomically without leaving temp files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-manifest-'));
    try {
      const manifestPath = path.join(dir, 'case.json');
      await writeManifestAtomic(manifestPath, v2Manifest);
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AsmCaseManifestV2;
      expect(parsed.version).toBe(2);
      expect(parsed.program.machineCode?.path).toBe('code.txt');
      expect(isManifestV2(parsed)).toBe(true);
      const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects replay inputs that are present but not bound to a configuration fingerprint', () => {
    const withInterruptDrift: AsmCaseManifestV2 = {
      ...v2Manifest,
      p7: { interruptSchedule: [0x3000] }
    };
    expect(v2ReplayClosureIssues(withInterruptDrift)).toContain(
      'oracle.runConfiguration.interruptSchedule does not match manifest.p7.interruptSchedule'
    );

    const withProbeAndDutMetadata: AsmCaseManifestV2 = {
      ...v2Manifest,
      p7: { probe: { version: 1 } },
      metadata: { 'source.seed': 'seed-1', 'dut.verilog.testbenchModule': 'mips_tb' }
    };
    expect(v2ReplayClosureIssues(withProbeAndDutMetadata)).toEqual(expect.arrayContaining([
      'oracle.runConfiguration.deviceTimeline does not bind P7 probe metadata',
      'metadata contains replay-unbound keys: dut.verilog.testbenchModule'
    ]));
  });

  it('supports concurrent same-process atomic writes without temp-name collisions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-manifest-concurrent-'));
    try {
      const manifestPath = path.join(dir, 'case.json');
      const variants = Array.from({ length: 8 }, (_, index) => ({
        ...v2Manifest,
        caseId: `case-${index}`
      }));
      await Promise.all(variants.map((manifest) => writeManifestAtomic(manifestPath, manifest)));
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AsmCaseManifestV2;
      expect(variants.map((item) => item.caseId)).toContain(parsed.caseId);
      expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('binds all three source resource limits to the verified source graph', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-manifest-source-limits-'));
    try {
      const asm = Buffer.from('nop\n');
      const asmPath = path.join(dir, 'program.asm');
      fs.writeFileSync(asmPath, asm);
      const graphLimits = { maxBytes: 4096, maxDepth: 7, maxUnits: 11 };
      const captured = await captureSourceGraph(asmPath, dir, asm, graphLimits);
      const graphBytes = fs.readFileSync(captured.graphPath);
      const matchingConfiguration = {
        ...testRunConfiguration,
        resourceLimits: {
          ...testRunConfiguration.resourceLimits,
          maxSourceBytes: graphLimits.maxBytes,
          maxIncludeDepth: graphLimits.maxDepth,
          maxIncludeUnits: graphLimits.maxUnits
        }
      };
      const complete: AsmCaseManifestV2 = {
        ...v2Manifest,
        asmSnapshot: {
          path: 'program.asm', bytes: asm.byteLength,
          sha256: crypto.createHash('sha256').update(asm).digest('hex')
        },
        program: {
          ...v2Manifest.program,
          sourceGraph: {
            path: 'source/graph.json', bytes: graphBytes.byteLength,
            sha256: crypto.createHash('sha256').update(graphBytes).digest('hex')
          }
        },
        artifacts: {
          ...v2Manifest.artifacts,
          source: {
            ...v2Manifest.artifacts?.source,
            graph: {
              path: 'source/graph.json', bytes: graphBytes.byteLength,
              sha256: crypto.createHash('sha256').update(graphBytes).digest('hex')
            },
            original: {
              path: 'program.asm', bytes: asm.byteLength,
              sha256: crypto.createHash('sha256').update(asm).digest('hex')
            }
          }
        },
        oracle: {
          ...v2Manifest.oracle,
          runConfiguration: matchingConfiguration,
          configurationHash: manifestRunConfigurationHash(matchingConfiguration, testEngine)
        }
      };
      expect(await v2ReplayBundleIssues(complete, dir)).not.toContain(
        'oracle.runConfiguration.resourceLimits source limits do not match program.sourceGraph.limits'
      );

      for (const resourceLimits of [
        { ...matchingConfiguration.resourceLimits, maxSourceBytes: graphLimits.maxBytes + 1 },
        { ...matchingConfiguration.resourceLimits, maxIncludeDepth: graphLimits.maxDepth + 1 },
        { ...matchingConfiguration.resourceLimits, maxIncludeUnits: graphLimits.maxUnits + 1 }
      ]) {
        const configuration = { ...matchingConfiguration, resourceLimits };
        const tampered: AsmCaseManifestV2 = {
          ...complete,
          oracle: {
            ...complete.oracle,
            runConfiguration: configuration,
            configurationHash: manifestRunConfigurationHash(configuration, testEngine)
          }
        };
        expect(await v2ReplayBundleIssues(tampered, dir)).toContain(
          'oracle.runConfiguration.resourceLimits source limits do not match program.sourceGraph.limits'
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a backslash sourceGraph path before POSIX snapshot verification and graph parsing can select different files',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-manifest-graph-path-'));
      try {
        const verifiedGraph = Buffer.from('{}\n', 'utf8');
        const literalBackslashGraph = Buffer.from('{ invalid graph JSON', 'utf8');
        fs.mkdirSync(path.join(dir, 'source'));
        fs.writeFileSync(path.join(dir, 'source', 'graph.json'), verifiedGraph);
        fs.writeFileSync(path.join(dir, 'source\\graph.json'), literalBackslashGraph);
        const graphSnapshot = {
          path: 'source\\graph.json',
          bytes: verifiedGraph.byteLength,
          sha256: crypto.createHash('sha256').update(verifiedGraph).digest('hex')
        };
        const detached: AsmCaseManifestV2 = {
          ...v2Manifest,
          program: { ...v2Manifest.program, sourceGraph: graphSnapshot },
          artifacts: {
            ...v2Manifest.artifacts,
            source: { ...v2Manifest.artifacts?.source, graph: graphSnapshot }
          }
        };

        expect(fs.readFileSync(path.join(dir, 'source', 'graph.json'))).toEqual(verifiedGraph);
        expect(fs.readFileSync(path.join(dir, 'source\\graph.json'))).toEqual(literalBackslashGraph);
        expect(v2ReplayClosureIssues(detached)).toEqual(expect.arrayContaining([
          'program.sourceGraph.path must be a safe case-relative path',
          'artifacts.source.graph is not case-relative'
        ]));
        const issues = await v2ReplayBundleIssues(detached, dir);
        expect(issues).toEqual(expect.arrayContaining([
          'program.sourceGraph.path must be a safe case-relative path',
          'artifacts.source.graph is not case-relative'
        ]));
        expect(issues.some((issue) => issue.includes('source graph JSON is invalid'))).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('verifies replay snapshot bytes and hashes inside the case directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-manifest-bundle-'));
    try {
      const asm = Buffer.from('nop');
      const code = Buffer.from('00000000');
      const trace = Buffer.from('@00003000: $ 1 <= 00000001\n');
      const evidence = oracleEvidenceDigests(trace.toString('utf8'), 1);
      fs.writeFileSync(path.join(dir, 'program.asm'), asm);
      fs.writeFileSync(path.join(dir, 'code.txt'), code);
      fs.mkdirSync(path.join(dir, 'oracle'));
      fs.writeFileSync(path.join(dir, 'oracle', 'mars.out'), trace);
      const complete: AsmCaseManifestV2 = {
        ...v2Manifest,
        asmSnapshot: {
          path: 'program.asm', bytes: asm.byteLength,
          sha256: crypto.createHash('sha256').update(asm).digest('hex')
        },
        program: {
          ...v2Manifest.program,
          machineCode: {
            path: 'code.txt', bytes: code.byteLength, wordCount: 1, haltPc: 0x3004,
            sha256: crypto.createHash('sha256').update(code).digest('hex')
          },
          dutInput: {
            path: 'code.txt', bytes: code.byteLength,
            sha256: crypto.createHash('sha256').update(code).digest('hex')
          }
        },
        oracle: {
          ...v2Manifest.oracle,
          rawOutputDigest: evidence.rawOutputDigest,
          eventDigest: evidence.eventDigest,
          finalStateDigest: evidence.finalStateDigest,
          eventCount: evidence.eventCount,
          steps: evidence.steps
        },
        artifacts: {
          oracle: {
            traceOut: {
              path: 'oracle/mars.out', bytes: trace.byteLength,
              sha256: crypto.createHash('sha256').update(trace).digest('hex')
            }
          }
        }
      };
      const baselineIssues = await v2ReplayBundleIssues(complete, dir);
      expect(baselineIssues).not.toEqual(expect.arrayContaining([
        expect.stringContaining('program.machineCode.bytes mismatch'),
        expect.stringContaining('artifacts.oracle.traceOut.bytes mismatch'),
        expect.stringContaining('oracle.rawOutputDigest does not match')
      ]));

      const structuredEventDigest = sha256Canonical([] as CanonicalJson);
      const structuredDocument = {
        schemaRevision: 1,
        eventSchema: 'buaa-co-commit-event-v1',
        engine: {
          id: 'builtin-ts', kind: 'executor', build: 'test',
          semanticsRevision: 1, capabilitiesRevision: 1
        },
        imageFingerprint: complete.program.imageFingerprint!,
        profile: 'P7',
        stop: { kind: 'halt-loop', haltPc: 0x3004 },
        status: 'halted',
        instructions: 7,
        eventCount: 0,
        eventDigest: structuredEventDigest,
        finalStateDigest: 'f'.repeat(64),
        events: []
      };
      const structuredBytes = Buffer.from(`${canonicalJson(structuredDocument as CanonicalJson)}\n`);
      const structuredFile = path.join(dir, 'oracle', 'events.json');
      fs.writeFileSync(structuredFile, structuredBytes);
      const builtinEngine = {
        ...testEngine,
        id: 'builtin-ts',
        legacyProvenance: undefined,
        artifact: { sha256: 'b'.repeat(64), role: 'builtin-ts-executor', fileName: 'builtin-ts-executor.manifest.json' }
      };
      const builtinConfiguration = { ...testRunConfiguration, runtime: { kind: 'builtin-ts' as const } };
      const structuredManifest: AsmCaseManifestV2 = {
        ...complete,
        oracle: {
          ...complete.oracle,
          engine: builtinEngine,
          runConfiguration: builtinConfiguration,
          configurationHash: manifestRunConfigurationHash(builtinConfiguration, builtinEngine),
          steps: 7,
          eventCount: 0,
          rawOutputDigest: evidence.rawOutputDigest,
          eventDigest: structuredEventDigest,
          finalStateDigest: 'f'.repeat(64)
        },
        artifacts: {
          ...complete.artifacts,
          oracle: {
            traceOut: complete.artifacts!.oracle!.traceOut,
            events: {
              path: 'oracle/events.json',
              bytes: structuredBytes.byteLength,
              sha256: crypto.createHash('sha256').update(structuredBytes).digest('hex')
            }
          }
        }
      };
      const structuredIssues = await v2ReplayBundleIssues(structuredManifest, dir);
      expect(structuredIssues).not.toEqual(expect.arrayContaining([
        expect.stringContaining('oracle.eventDigest does not match captured traceOut'),
        expect.stringContaining('oracle.steps does not match captured traceOut'),
        expect.stringContaining('oracle.eventDigest does not match captured events')
      ]));
      expect(await v2ReplayBundleIssues({
        ...structuredManifest,
        oracle: { ...structuredManifest.oracle, eventDigest: 'e'.repeat(64) }
      }, dir)).toContain('oracle.eventDigest does not match captured events');

      const legacyEvents = Buffer.from('legacy provider sidecar, not a builtin event envelope');
      const legacyEventsFile = path.join(dir, 'oracle', 'events.bin');
      fs.writeFileSync(legacyEventsFile, legacyEvents);
      const legacyWithArbitraryEvents: AsmCaseManifestV2 = {
        ...complete,
        artifacts: {
          ...complete.artifacts,
          oracle: {
            traceOut: complete.artifacts!.oracle!.traceOut,
            events: {
              path: 'oracle/events.bin',
              bytes: legacyEvents.byteLength,
              sha256: crypto.createHash('sha256').update(legacyEvents).digest('hex')
            }
          }
        }
      };
      expect(await v2ReplayBundleIssues(legacyWithArbitraryEvents, dir)).not.toEqual(expect.arrayContaining([
        expect.stringContaining('oracle structured evidence'),
        expect.stringContaining('builtin event artifact')
      ]));

      const invalidUtf8Trace = Buffer.concat([trace, Buffer.from([0xff])]);
      const replacementEvidence = oracleEvidenceDigests(invalidUtf8Trace.toString('utf8'), 1);
      fs.writeFileSync(path.join(dir, 'oracle', 'mars.out'), invalidUtf8Trace);
      const invalidUtf8Manifest: AsmCaseManifestV2 = {
        ...complete,
        oracle: {
          ...complete.oracle,
          rawOutputDigest: replacementEvidence.rawOutputDigest,
          eventDigest: replacementEvidence.eventDigest,
          finalStateDigest: replacementEvidence.finalStateDigest,
          eventCount: replacementEvidence.eventCount,
          steps: replacementEvidence.steps
        },
        artifacts: {
          oracle: {
            traceOut: {
              path: 'oracle/mars.out', bytes: invalidUtf8Trace.byteLength,
              sha256: crypto.createHash('sha256').update(invalidUtf8Trace).digest('hex')
            }
          }
        }
      };
      expect(await v2ReplayBundleIssues(invalidUtf8Manifest, dir)).toEqual(expect.arrayContaining([
        expect.stringContaining('not lossless UTF-8')
      ]));
      fs.writeFileSync(path.join(dir, 'oracle', 'mars.out'), trace);

      const originalTraceSnapshot = complete.artifacts?.oracle?.traceOut;
      if (!originalTraceSnapshot || typeof originalTraceSnapshot === 'string') {
        throw new Error('The complete fixture must contain a hashed oracle trace snapshot.');
      }
      const oversizedSnapshots: AsmCaseManifestV2 = {
        ...complete,
        asmSnapshot: { ...complete.asmSnapshot, bytes: maximumReplaySnapshotBytes + 1 },
        stdin: {
          path: 'program.asm', sha256: complete.asmSnapshot.sha256,
          bytes: maximumReplayStdinBytes + 1, originalPath: 'captured-input.txt'
        },
        artifacts: {
          oracle: {
            traceOut: {
              ...originalTraceSnapshot,
              bytes: maximumReplaySnapshotBytes + 1
            }
          }
        }
      };
      expect(await v2ReplayBundleIssues(oversizedSnapshots, dir)).toEqual(expect.arrayContaining([
        expect.stringMatching(/asmSnapshot.*declared size .* exceeds the hard limit/),
        expect.stringMatching(/stdin.*declared size .* exceeds the hard limit/),
        expect.stringMatching(/artifacts\.oracle\.traceOut.*declared size .* exceeds the hard limit/)
      ]));

      const oversizedMachineCode: AsmCaseManifestV2 = {
        ...complete,
        program: {
          ...complete.program,
          machineCode: {
            ...complete.program.machineCode!,
            bytes: maximumReplayMachineCodeBytes + 1,
            wordCount: maximumReplayMachineCodeWords + 1
          }
        }
      };
      expect(v2ReplayClosureIssues(oversizedMachineCode)).toEqual(expect.arrayContaining([
        expect.stringContaining(`超过教程 IM ${maximumReplayMachineCodeWords} words 容量`),
        expect.stringMatching(/program\.machineCode declared size .* exceeds the hard limit/)
      ]));

      fs.writeFileSync(path.join(dir, 'oracle', 'mars.out'), 'corrupt');
      expect(await v2ReplayBundleIssues(complete, dir)).toEqual(expect.arrayContaining([
        expect.stringContaining('artifacts.oracle.traceOut')
      ]));
      fs.writeFileSync(path.join(dir, 'oracle', 'mars.out'), trace);
      fs.writeFileSync(path.join(dir, 'code.txt'), 'corrupt');
      expect(await v2ReplayBundleIssues(complete, dir)).toEqual(expect.arrayContaining([
        expect.stringContaining('program.machineCode')
      ]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed without throwing on a malformed runtime bundle value', async () => {
    await expect(v2ReplayBundleIssues({ version: 2 } as never, 'not-used')).resolves.toEqual([
      'manifest v2 structure is invalid or contains unknown fields'
    ]);
  });
});
