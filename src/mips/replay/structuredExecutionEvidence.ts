// @index mips-replay — canonical builtin commit-event evidence shared by capture and replay

import { sha256Canonical, type CanonicalJson } from './canonical';

export interface StructuredExecutionEvidence {
  readonly steps: number;
  readonly eventCount: number;
  readonly eventDigest: string;
  readonly finalStateDigest: string;
}

export interface ParsedStructuredExecutionEvidence extends StructuredExecutionEvidence {
  readonly events: readonly CanonicalJson[];
  readonly engine: {
    readonly id: string;
    readonly kind: string;
    readonly build?: string;
    readonly semanticsRevision: number;
    readonly capabilitiesRevision: number;
  };
  readonly imageFingerprint: string;
  readonly profile: string;
  readonly stop: { readonly kind: string; readonly haltPc?: number };
  readonly status: string;
}

/** Parse the provider-owned event artifact and bind its summary to the canonical event stream. */
export function parseStructuredExecutionEvidence(bytes: Uint8Array): ParsedStructuredExecutionEvidence {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new Error(`builtin event artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)
    || value.schemaRevision !== 1
    || value.eventSchema !== 'buaa-co-commit-event-v1'
    || !isNonNegativeInteger(value.instructions)
    || !isNonNegativeInteger(value.eventCount)
    || !Array.isArray(value.events)
    || !isSha256(value.eventDigest)
    || !isSha256(value.finalStateDigest)
    || !isRecord(value.engine)
    || typeof value.engine.id !== 'string'
    || value.engine.kind !== 'executor'
    || (value.engine.build !== undefined && typeof value.engine.build !== 'string')
    || !isNonNegativeInteger(value.engine.semanticsRevision)
    || !isNonNegativeInteger(value.engine.capabilitiesRevision)
    || !isSha256(value.imageFingerprint)
    || typeof value.profile !== 'string'
    || value.profile.length === 0
    || !isRecord(value.stop)
    || typeof value.stop.kind !== 'string'
    || (value.stop.haltPc !== undefined && !isUint32(value.stop.haltPc))
    || typeof value.status !== 'string'
    || value.status.length === 0) {
    throw new Error('builtin event artifact has an invalid evidence envelope');
  }
  if (value.events.length !== value.eventCount) {
    throw new Error('builtin event artifact eventCount does not match its event stream');
  }
  const events = value.events as CanonicalJson[];
  const eventDigest = sha256Canonical(events as CanonicalJson);
  if (eventDigest !== value.eventDigest.toLowerCase()) {
    throw new Error('builtin event artifact eventDigest does not match its event stream');
  }
  return Object.freeze({
    steps: value.instructions,
    eventCount: value.eventCount,
    eventDigest,
    finalStateDigest: value.finalStateDigest.toLowerCase(),
    events: Object.freeze(events.slice()),
    engine: Object.freeze({
      id: value.engine.id,
      kind: value.engine.kind,
      ...(value.engine.build === undefined ? {} : { build: value.engine.build }),
      semanticsRevision: value.engine.semanticsRevision,
      capabilitiesRevision: value.engine.capabilitiesRevision
    }),
    imageFingerprint: value.imageFingerprint.toLowerCase(),
    profile: value.profile,
    stop: Object.freeze({
      kind: value.stop.kind,
      ...(value.stop.haltPc === undefined ? {} : { haltPc: value.stop.haltPc >>> 0 })
    }),
    status: value.status
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isUint32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}
