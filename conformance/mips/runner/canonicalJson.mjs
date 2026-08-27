/** Canonical JSON helpers shared by the conformance runner (LF, sorted keys). */
import * as crypto from 'node:crypto';

/** JSON value accepted by the canonical schemas. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256CanonicalJson(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    // A null-prototype target makes every own JSON key data, including "__proto__".
    const result = Object.create(null);
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
