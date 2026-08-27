// @index mips-cli — 版本化 JSONL 请求校验与纯 ISA/执行/设备服务分派
import {
  CourseProfile,
  InstructionLayer,
  isaCatalogSchemaRevision,
  isaCatalogSha256,
  isaInstructions
} from '../core/generated/isaCatalog';
import { InstructionScope } from '../core/isa/decoder';
import { EncodeOperands, InstructionEncodeError } from '../core/isa/encoder';
import {
  decodeInstructionForService,
  encodeInstructionForService,
  parseInstructionWord
} from '../core/isa/service';
import { timerCycleContractRevision } from '../core/devices/timer';
import { commitEventSchemaRevision } from '../core/events/commitEvent';
import { executionCoverageRevision } from '../core/events/coverage';
import { traceProjectionRevision } from '../core/events/traceProjection';
import {
  ExecuteRequestError,
  executeProgramForService,
  executeServiceRequestFields,
  executorSemanticsRevision,
  maximumDeviceVectorSteps,
  maximumExecuteSegmentWords,
  maximumExecuteSteps,
  parseDeviceVectorSteps,
  parseExecuteServiceRequest,
  runDeviceCycleVectorForService
} from '../core/machine/executeService';
import { courseProfileIds } from '../core/profiles/courseProfiles';

export const mipsEngineCliProtocolVersion = 1 as const;
export const mipsEngineCliMaximumBatch = 4096;

const courseProfiles = new Set<CourseProfile>(['P3', 'P4', 'P5', 'P6', 'P7']);
const instructionLayers = new Set<InstructionLayer>([
  'required',
  'commonExtensions',
  'marsCompatibility'
]);
const operandFields = ['rs', 'rt', 'rd', 'shamt', 'immediate', 'index'] as const;

export interface MipsEngineCliResponse {
  protocolVersion: typeof mipsEngineCliProtocolVersion;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

class CliRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Validate and execute one JSONL value. Every input produces exactly one
 * protocol response; malformed requests never escape as an uncaught error.
 */
export function handleMipsEngineCliValue(value: unknown): MipsEngineCliResponse {
  const requestId = requestIdForError(value);
  try {
    const request = parseBaseRequest(value);
    return {
      protocolVersion: mipsEngineCliProtocolVersion,
      requestId: request.requestId,
      ok: true,
      result: dispatch(request.value, request.operation)
    };
  } catch (error) {
    const failure = error instanceof CliRequestError
      ? error
      : new CliRequestError('internal-error', error instanceof Error ? error.message : String(error));
    return {
      protocolVersion: mipsEngineCliProtocolVersion,
      requestId,
      ok: false,
      error: { code: failure.code, message: failure.message }
    };
  }
}

function dispatch(request: Record<string, unknown>, operation: string): unknown {
  switch (operation) {
    case 'describe':
      requireOnlyKeys(request, ['protocolVersion', 'requestId', 'operation']);
      return {
        engine: {
          id: 'builtin-ts-isa',
          build: 'extension-phase1',
          semanticsRevision: 1,
          capabilitiesRevision: 1
        },
        catalog: {
          schemaRevision: isaCatalogSchemaRevision,
          sha256: isaCatalogSha256,
          instructionCount: isaInstructions.length
        },
        // The executor and the device model carry their own revisions: execution
        // and device evidence buckets must not be invalidated by an assembler or
        // catalog change, and vice versa (计划第 7.6 节).
        executor: {
          id: 'builtin-ts-executor',
          build: 'extension-phase2-3',
          semanticsRevision: executorSemanticsRevision,
          eventSchemaRevision: commitEventSchemaRevision,
          traceProjectionRevision,
          coverageRevision: executionCoverageRevision,
          profiles: [...courseProfileIds],
          maximumSegmentWords: maximumExecuteSegmentWords,
          maximumSteps: maximumExecuteSteps
        },
        device: {
          id: 'builtin-ts-course-timer',
          build: 'extension-phase3',
          cycleContractRevision: timerCycleContractRevision,
          maximumVectorSteps: maximumDeviceVectorSteps
        },
        operations: [
          'describe',
          'isa.encode',
          'isa.decode',
          'isa.encodeBatch',
          'isa.decodeBatch',
          'machine.execute',
          'device.cycleVector'
        ],
        profiles: [...courseProfiles],
        instructionLayers: [...instructionLayers],
        maximumBatch: mipsEngineCliMaximumBatch
      };
    case 'isa.encode': {
      requireOnlyKeys(request, ['protocolVersion', 'requestId', 'operation', 'mnemonic', 'operands']);
      return encodeOne(request.mnemonic, request.operands);
    }
    case 'isa.decode': {
      requireOnlyKeys(request, ['protocolVersion', 'requestId', 'operation', 'word', 'scope']);
      return decodeOne(request.word, request.scope);
    }
    case 'isa.encodeBatch': {
      requireOnlyKeys(request, ['protocolVersion', 'requestId', 'operation', 'entries']);
      const entries = requireBatch(request.entries, 'entries');
      return entries.map((entry, index) => {
        if (!isRecord(entry)) {
          throw new CliRequestError('invalid-request', `entries[${index}] must be an object`);
        }
        requireOnlyKeys(entry, ['mnemonic', 'operands'], `entries[${index}]`);
        return encodeOne(entry.mnemonic, entry.operands, `entries[${index}]`);
      });
    }
    case 'isa.decodeBatch': {
      requireOnlyKeys(request, ['protocolVersion', 'requestId', 'operation', 'words', 'scope']);
      const scope = parseScope(request.scope);
      const words = requireBatch(request.words, 'words');
      return words.map((word, index) => decodeWord(word, scope, `words[${index}]`));
    }
    case 'machine.execute': {
      requireOnlyKeys(request, [
        'protocolVersion', 'requestId', 'operation', ...executeServiceRequestFields
      ]);
      return runService(() => executeProgramForService(parseExecuteServiceRequest(request)),
        'machine-execute-invalid');
    }
    case 'device.cycleVector': {
      requireOnlyKeys(request, ['protocolVersion', 'requestId', 'operation', 'steps']);
      return runService(() => runDeviceCycleVectorForService(parseDeviceVectorSteps(request.steps)),
        'device-vector-invalid');
    }
    default:
      throw new CliRequestError('unsupported-operation', `unsupported operation: ${operation}`);
  }
}

/**
 * Request validation lives in the host-free service so the CLI and the Worker
 * validate one DTO shape. Malformed input keeps the protocol's stable
 * `invalid-request` code; anything else becomes an operation-specific code.
 */
function runService<T>(run: () => T, failureCode: string): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ExecuteRequestError) {
      throw new CliRequestError('invalid-request', error.message);
    }
    throw new CliRequestError(
      failureCode,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function encodeOne(mnemonic: unknown, operands: unknown, label = 'request'): unknown {
  if (typeof mnemonic !== 'string' || !mnemonic.trim()) {
    throw new CliRequestError('invalid-request', `${label}.mnemonic must be a non-empty string`);
  }
  const parsedOperands = parseEncodeOperands(operands, `${label}.operands`);
  try {
    return encodeInstructionForService(mnemonic, parsedOperands);
  } catch (error) {
    if (error instanceof InstructionEncodeError) {
      throw new CliRequestError('isa-encode-invalid', error.message);
    }
    throw error;
  }
}

function decodeOne(word: unknown, scope: unknown): unknown {
  return decodeWord(word, parseScope(scope), 'word');
}

function decodeWord(word: unknown, scope: InstructionScope, label: string): unknown {
  if (typeof word !== 'string') {
    throw new CliRequestError('invalid-request', `${label} must be a fixed-width hex string`);
  }
  try {
    return decodeInstructionForService(parseInstructionWord(word), scope);
  } catch (error) {
    throw new CliRequestError('invalid-request', error instanceof Error ? error.message : String(error));
  }
}

function parseBaseRequest(value: unknown): {
  requestId: string;
  operation: string;
  value: Record<string, unknown>;
} {
  if (!isRecord(value)) {
    throw new CliRequestError('invalid-request', 'request must be a JSON object');
  }
  if (value.protocolVersion !== mipsEngineCliProtocolVersion) {
    throw new CliRequestError(
      'protocol-version-unsupported',
      `protocolVersion must be ${mipsEngineCliProtocolVersion}`
    );
  }
  if (!isNonEmptyString(value.requestId) || value.requestId.length > 128) {
    throw new CliRequestError('invalid-request', 'requestId must be a non-empty string of at most 128 characters');
  }
  if (!isNonEmptyString(value.operation)) {
    throw new CliRequestError('invalid-request', 'operation must be a non-empty string');
  }
  return { requestId: value.requestId, operation: value.operation, value };
}

function parseScope(value: unknown): InstructionScope {
  if (!isRecord(value)) {
    throw new CliRequestError('invalid-request', 'scope must be an object');
  }
  requireOnlyKeys(value, ['profile', 'enabledLayers'], 'scope');
  if (typeof value.profile !== 'string' || !courseProfiles.has(value.profile as CourseProfile)) {
    throw new CliRequestError('invalid-request', `scope.profile is invalid: ${String(value.profile)}`);
  }
  if (!Array.isArray(value.enabledLayers)
    || value.enabledLayers.length === 0
    || value.enabledLayers.some((layer) => typeof layer !== 'string' || !instructionLayers.has(layer as InstructionLayer))
    || new Set(value.enabledLayers).size !== value.enabledLayers.length) {
    throw new CliRequestError('invalid-request', 'scope.enabledLayers must be a non-empty unique list of known layers');
  }
  return {
    profile: value.profile as CourseProfile,
    enabledLayers: value.enabledLayers as InstructionLayer[]
  };
}

function parseEncodeOperands(value: unknown, label: string): EncodeOperands {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new CliRequestError('invalid-request', `${label} must be an object`);
  }
  requireOnlyKeys(value, operandFields, label);
  const result: EncodeOperands = {};
  for (const field of operandFields) {
    const raw = value[field];
    if (raw === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(raw)) {
      throw new CliRequestError('invalid-request', `${label}.${field} must be a safe integer`);
    }
    result[field] = raw as number;
  }
  return result;
}

function requireBatch(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > mipsEngineCliMaximumBatch) {
    throw new CliRequestError(
      'invalid-request',
      `${label} must contain 1..${mipsEngineCliMaximumBatch} entries`
    );
  }
  return value;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label = 'request'
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) {
    throw new CliRequestError('invalid-request', `${label} has unknown fields: ${unknown.join(', ')}`);
  }
}

function requestIdForError(value: unknown): string {
  return isRecord(value) && isNonEmptyString(value.requestId) && value.requestId.length <= 128
    ? value.requestId
    : 'invalid-request';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
