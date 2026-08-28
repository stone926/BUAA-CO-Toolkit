// @index mips-host — 可取消、按固定 slice yield 的真实 ISA Worker 作业
import { CourseProfile, InstructionLayer } from '../core/generated/isaCatalog';
import { InstructionScope } from '../core/isa/decoder';
import { EncodeOperands, InstructionEncodeError } from '../core/isa/encoder';
import {
  decodeInstructionForService,
  encodeInstructionForService,
  parseInstructionWord
} from '../core/isa/service';
import {
  executeProgramForServiceAsync,
  parseExecuteServiceRequest,
  parseDeviceVectorSteps,
  runDeviceCycleVectorForService
} from '../core/machine/executeService';
import { assembleProgramForService, parseAssemblerServiceRequest } from '../core/assembler/assemblyService';

export const mipsWorkerSliceSize = 128;
export const mipsWorkerMaximumBatch = 65_536;

const profiles = new Set<CourseProfile>(['P3', 'P4', 'P5', 'P6', 'P7']);
const layers = new Set<InstructionLayer>(['required', 'commonExtensions', 'marsCompatibility']);
const operandFields = ['rs', 'rt', 'rd', 'shamt', 'immediate', 'index'] as const;

export interface WorkerJobExecutionContext {
  signal: AbortSignal;
  /** Resolves only after the host acknowledges consumption of this batch. */
  emitProgress(batch: unknown[]): void | Promise<void>;
  /** Test seam; production yields to the worker message loop with setImmediate. */
  yieldControl?: () => Promise<void>;
}

export async function executeProductionWorkerJob(
  kind: string,
  payload: unknown,
  context: WorkerJobExecutionContext
): Promise<unknown> {
  switch (kind) {
    case 'ping':
      return { token: payload ?? null, receivedAt: 'phase-1' };
    case 'isa-decode-batch':
      return await executeDecodeBatch(payload, context);
    case 'isa-encode-batch':
      return await executeEncodeBatch(payload, context);
    case 'assembler-assemble':
      // Bounded DTO validation shared with the CLI; pure layout runs quickly but
      // keeps the same request shape as the process boundary.
      return assembleProgramForService(parseAssemblerServiceRequest(payload as Record<string, unknown>));
    case 'machine-execute':
      // Bounded DTO validation is shared with the CLI; execution then streams
      // CommitEvent slices under worker protocol ACK/backpressure.
      return await executeMachineJob(payload, context);
    case 'device-cycle-vector':
      return runDeviceCycleVectorForService(parseDeviceVectorSteps(payload));
    default:
      throw new Error(`unknown job kind: ${kind}`);
  }
}

async function executeMachineJob(
  payload: unknown,
  context: WorkerJobExecutionContext
): Promise<unknown> {
  const request = parseExecuteServiceRequest(payload);
  return await executeProgramForServiceAsync(request, {
    aborted: () => context.signal.aborted,
    onSlice: async (events) => {
      await context.emitProgress([...events]);
    },
    retainEvents: false
  });
}

async function executeDecodeBatch(payload: unknown, context: WorkerJobExecutionContext): Promise<unknown> {
  const value = requireRecord(payload, 'isa-decode-batch payload');
  requireOnlyKeys(value, ['words', 'scope'], 'isa-decode-batch payload');
  const words = requireBatch(value.words, 'words');
  const scope = parseScope(value.scope);
  return await executeSlices(words, context, (word, index) => {
    if (typeof word !== 'string') {
      throw new Error(`words[${index}] must be a fixed-width hex string`);
    }
    return decodeInstructionForService(parseInstructionWord(word), scope);
  });
}

async function executeEncodeBatch(payload: unknown, context: WorkerJobExecutionContext): Promise<unknown> {
  const value = requireRecord(payload, 'isa-encode-batch payload');
  requireOnlyKeys(value, ['entries'], 'isa-encode-batch payload');
  const entries = requireBatch(value.entries, 'entries');
  return await executeSlices(entries, context, (entry, index) => {
    const item = requireRecord(entry, `entries[${index}]`);
    requireOnlyKeys(item, ['mnemonic', 'operands'], `entries[${index}]`);
    if (typeof item.mnemonic !== 'string' || !item.mnemonic.trim()) {
      throw new Error(`entries[${index}].mnemonic must be a non-empty string`);
    }
    try {
      return encodeInstructionForService(item.mnemonic, parseEncodeOperands(item.operands, `entries[${index}].operands`));
    } catch (error) {
      if (error instanceof InstructionEncodeError) {
        throw new Error(`entries[${index}]: ${error.message}`);
      }
      throw error;
    }
  });
}

async function executeSlices(
  input: unknown[],
  context: WorkerJobExecutionContext,
  transform: (value: unknown, index: number) => unknown
): Promise<{ processed: number; sliceSize: number }> {
  const yieldControl = context.yieldControl ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  let processed = 0;
  while (processed < input.length) {
    throwIfCancelled(context.signal);
    const end = Math.min(input.length, processed + mipsWorkerSliceSize);
    const batch: unknown[] = [];
    for (let index = processed; index < end; index++) {
      batch.push(transform(input[index], index));
    }
    processed = end;
    await context.emitProgress(batch);
    throwIfCancelled(context.signal);
    if (processed < input.length) {
      await yieldControl();
    }
  }
  throwIfCancelled(context.signal);
  return { processed, sliceSize: mipsWorkerSliceSize };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('cancelled');
  }
}

function parseScope(value: unknown): InstructionScope {
  const scope = requireRecord(value, 'scope');
  requireOnlyKeys(scope, ['profile', 'enabledLayers'], 'scope');
  if (typeof scope.profile !== 'string' || !profiles.has(scope.profile as CourseProfile)) {
    throw new Error(`scope.profile is invalid: ${String(scope.profile)}`);
  }
  if (!Array.isArray(scope.enabledLayers)
    || scope.enabledLayers.length === 0
    || scope.enabledLayers.some((layer) => typeof layer !== 'string' || !layers.has(layer as InstructionLayer))
    || new Set(scope.enabledLayers).size !== scope.enabledLayers.length) {
    throw new Error('scope.enabledLayers must be a non-empty unique list of known layers');
  }
  return {
    profile: scope.profile as CourseProfile,
    enabledLayers: scope.enabledLayers as InstructionLayer[]
  };
}

function parseEncodeOperands(value: unknown, label: string): EncodeOperands {
  if (value === undefined) {
    return {};
  }
  const operands = requireRecord(value, label);
  requireOnlyKeys(operands, operandFields, label);
  const result: EncodeOperands = {};
  for (const field of operandFields) {
    const raw = operands[field];
    if (raw === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(raw)) {
      throw new Error(`${label}.${field} must be a safe integer`);
    }
    result[field] = raw as number;
  }
  return result;
}

function requireBatch(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > mipsWorkerMaximumBatch) {
    throw new Error(`${label} must contain 1..${mipsWorkerMaximumBatch} entries`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) {
    throw new Error(`${label} has unknown fields: ${unknown.join(', ')}`);
  }
}
