// @index mips-host — Shared assembly and course execution DTOs for the Worker
import type { ProgramImage, SourceUnit } from '../core/api';
import type { AssemblerServiceInclude } from '../core/assembler/assemblyService';
import type { DebugMode } from '../core/debug/api';
import { hex8Address } from '../core/values';
import type { WorkerJob } from './workerProtocol';

export function mipsAssemblyJob(mode: DebugMode, input: {
  sources: readonly SourceUnit[];
  includes: readonly AssemblerServiceInclude[];
}, courseOptions?: { layers: readonly string[]; p7RiInstruction: boolean }): WorkerJob {
  if (mode.kind === 'course') return { kind: 'assembler-assemble', payload: { ...input, ...courseOptions, profile: mode.profile } };
  return { kind: 'mars-assemble', payload: { ...input, memoryConfiguration: mode.memoryConfiguration, delayedBranching: mode.delayedBranching } };
}

export function courseExecutionImagePayload(image: ProgramImage) {
  return {
    entryPc: hex8Address(image.entryPc),
    segments: image.segments.map(segment => ({
      name: segment.name, baseAddress: hex8Address(segment.baseAddress), words: segment.words.map(hex8Address)
    }))
  };
}
