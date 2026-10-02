// @index mips-host — 有界普通 MARS Worker 作业，使用 ACK 往返系统调用
import type { ProgramImage } from '../core/api';
import { buildProgramImage } from '../core/programImage';
import { isMarsMemoryConfiguration, MarsMemoryConfiguration } from '../core/profiles/marsMemoryLayout';
import { MarsSession } from '../core/mars/session';
import type { MarsIoResponse } from '../core/mars/api';
import type { WorkerJobExecutionContext } from './workerJobs';

export async function executeMarsJob(payload: unknown, context: WorkerJobExecutionContext): Promise<unknown> {
  const request = parseRequest(payload);
  const session = new MarsSession(request);
  const yieldControl = context.yieldControl ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  while (!context.signal.aborted) {
    let result = session.runSlice(1024);
    if (result.status === 'waiting') {
      const response = await context.emitProgress([{ kind: 'mars-io', request: result.request }]);
      if (context.signal.aborted) break;
      const resumed = session.resume(response as MarsIoResponse);
      result = { ...resumed, executed: result.executed };
    }
    if (result.status === 'exited') return { status: result.status, exitCode: result.exitCode, instructions: session.instructionsExecuted };
    if (result.status === 'fault' || result.status === 'step-limit') return {
      status: result.status, diagnostic: `[${result.diagnostic.code}] PC 0x${result.diagnostic.pc.toString(16)}: ${result.diagnostic.message}`,
      instructions: session.instructionsExecuted
    };
    await yieldControl();
  }
  throw new Error('cancelled');
}

function parseRequest(payload: unknown): {
  image: ProgramImage; memoryConfiguration?: MarsMemoryConfiguration; delayedBranching?: boolean; maxSteps: number;
} {
  if (!record(payload) || Object.keys(payload).some((key) => !['image', 'memoryConfiguration', 'delayedBranching', 'maxSteps'].includes(key))) {
    throw new Error('Invalid MARS execution request');
  }
  const program = parseMarsProgramImage(payload.image);
  if (payload.memoryConfiguration !== undefined && !isMarsMemoryConfiguration(payload.memoryConfiguration)) throw new Error('Invalid MARS memoryConfiguration');
  if (payload.delayedBranching !== undefined && typeof payload.delayedBranching !== 'boolean') throw new Error('Invalid MARS delayedBranching');
  const maxSteps = payload.maxSteps ?? 10_000_000;
  if (!Number.isSafeInteger(maxSteps) || (maxSteps as number) < 1 || (maxSteps as number) > 100_000_000) throw new Error('MARS maxSteps must be in 1..100000000');
  return { image: program, maxSteps: maxSteps as number,
    memoryConfiguration: payload.memoryConfiguration as MarsMemoryConfiguration | undefined,
    delayedBranching: payload.delayedBranching as boolean | undefined };
}

/** Shared bounded execution-image boundary; metadata remains with the host listing. */
export function parseMarsProgramImage(image: unknown): ProgramImage {
  if (!record(image) || image.formatVersion !== 1 || !uint32(image.entryPc) || (image.entryPc as number) % 4
    || !Array.isArray(image.segments) || image.segments.length > 16) throw new Error('Invalid MARS ProgramImage');
  let words = 0;
  for (const segment of image.segments) {
    if (!record(segment) || typeof segment.name !== 'string' || !['text', 'ktext', 'data', 'kdata'].includes(segment.name)
      || !uint32(segment.baseAddress) || (segment.baseAddress as number) % 4 || !Array.isArray(segment.words)
      || (words += segment.words.length) > 4_194_304 || !segment.words.every(uint32)
      || (segment.baseAddress as number) + segment.words.length * 4 > 0x1_0000_0000) throw new Error('Invalid MARS image segment');
  }
  // Execution consumes only the authoritative bytes and entry point; assembler metadata
  // stays on the host for diagnostics and is not traversed across this execution boundary.
  return buildProgramImage({ entryPc: image.entryPc as number,
    segments: image.segments as unknown as ProgramImage['segments'], symbols: [], sourceMap: [], inputGraph: [] });
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function uint32(value: unknown): boolean { return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff; }
