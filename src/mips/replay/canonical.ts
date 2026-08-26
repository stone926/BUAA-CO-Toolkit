// @index mips-replay — canonical JSON 与 replay 证据 digest（不依赖 VS Code）
import * as crypto from 'crypto';

/** JSON value accepted by the replay schemas. Undefined/non-finite values are never canonical. */
export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

/**
 * Serialize JSON with recursively sorted object keys. Arrays deliberately retain order: source
 * discovery, event order and device timelines are semantic inputs rather than sets.
 */
export function canonicalJson(value: CanonicalJson): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function sha256Canonical(value: CanonicalJson): string {
  return sha256Bytes(canonicalJson(value));
}

function canonicalize(value: CanonicalJson): CanonicalJson {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    // A null-prototype target makes every own JSON key data, including
    // "__proto__". A normal object would invoke Object.prototype's setter and
    // silently omit that semantic field from the digest.
    const result: { [key: string]: CanonicalJson } = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('canonical JSON cannot contain a non-finite number');
  }
  return value;
}
