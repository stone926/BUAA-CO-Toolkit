// @index mips-host — Long-lived debug Worker job controlled through progress ACK responses
import { courseProfileIds } from '../core/profiles/courseProfiles';
import { isMarsMemoryConfiguration } from '../core/profiles/marsMemoryLayout';
import type { DebugMode, DebugSessionOptions } from '../core/debug/api';
import { DebugSession } from '../core/debug/session';
import { isDebugRecord, parseDebugBreakpoints, parseDebugMemory, requireDebugKeys } from '../core/debug/validation';
import type { MarsIoResponse } from '../core/mars/api';
import { parseMarsProgramImage } from './marsJobs';
import type { WorkerJobExecutionContext } from './workerJobs';

export async function executeMarsDebugJob(payload: unknown, context: WorkerJobExecutionContext): Promise<unknown> {
  const session = new DebugSession(parseDebugRequest(payload));
  const yieldControl = context.yieldControl ?? (() => new Promise<void>(resolve => setImmediate(resolve)));
  while (!context.signal.aborted) {
    const response = await context.emitProgress([{ kind: 'mars-debug', snapshot: session.snapshot() }]);
    if (context.signal.aborted) break;
    if (response !== undefined) session.command(response as Parameters<DebugSession['command']>[0]);
    else if (!session.running) throw new Error('Paused debugger requires an explicit command');
    if (session.stopped) return session.snapshot();
    if (session.running) {
      const request = session.advance();
      if (request) {
        const ioResponse = await context.emitProgress([{ kind: 'mars-io', request, snapshot: session.snapshot() }]);
        if (context.signal.aborted) break;
        session.resume(ioResponse as MarsIoResponse);
      }
    }
    await yieldControl();
  }
  throw new Error('cancelled');
}

export function parseDebugRequest(payload: unknown): DebugSessionOptions {
  if (!isDebugRecord(payload)) throw new Error('Invalid debugger request');
  requireDebugKeys(payload, ['image', 'mode', 'maxSteps', 'breakpoints', 'memory']);
  const image = parseMarsProgramImage(payload.image);
  const rawMode = payload.mode;
  if (!isDebugRecord(rawMode)) throw new Error('Debugger mode must be explicit');
  let mode: DebugMode;
  if (rawMode.kind === 'mars') {
    requireDebugKeys(rawMode, ['kind', 'memoryConfiguration', 'delayedBranching']);
    if (rawMode.memoryConfiguration !== undefined && !isMarsMemoryConfiguration(rawMode.memoryConfiguration)) throw new Error('Invalid debugger MARS memory layout');
    if (rawMode.delayedBranching !== undefined && typeof rawMode.delayedBranching !== 'boolean') throw new Error('Invalid debugger delayed branching');
    mode = rawMode as unknown as DebugMode;
  } else if (rawMode.kind === 'course') {
    requireDebugKeys(rawMode, ['kind', 'profile']);
    if (!courseProfileIds.includes(rawMode.profile as typeof courseProfileIds[number])) throw new Error('Invalid debugger course profile');
    mode = rawMode as unknown as DebugMode;
  } else throw new Error('Debugger mode must be mars or course');
  const maxSteps = payload.maxSteps ?? 10_000_000;
  if (!Number.isSafeInteger(maxSteps) || (maxSteps as number) < 1 || (maxSteps as number) > 100_000_000) throw new Error('Debugger maxSteps must be in 1..100000000');
  let memory: DebugSessionOptions['memory'];
  if (payload.memory !== undefined) {
    if (!isDebugRecord(payload.memory)) throw new Error('Invalid debugger memory request');
    requireDebugKeys(payload.memory, ['address', 'words']);
    memory = parseDebugMemory(payload.memory as unknown as NonNullable<DebugSessionOptions['memory']>);
  }
  return { image, mode, maxSteps: maxSteps as number, memory, breakpoints: parseDebugBreakpoints(payload.breakpoints ?? []) };
}
