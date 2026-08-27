// @index mips-core — canonical JSON 序列化（递归键排序，数组保序）；replay/digest 共用
/**
 * Canonical JSON 是"同一内容必须得到同一字节序列"的唯一定义。它同时被 core 的
 * `ProgramImage` fingerprint 与 replay 的证据 digest 使用，因此实现放在 core：
 * 两侧共享定义而不是各写一份，避免同一 image 在两条路径上得到不同 hash。
 */

/** JSON value accepted by the canonical schemas. Undefined/non-finite values are never canonical. */
export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

/**
 * Serialize JSON with recursively sorted object keys. Arrays deliberately retain
 * order: source discovery, event order and device timelines are semantic inputs
 * rather than sets.
 */
export function canonicalJson(value: CanonicalJson): string {
  return JSON.stringify(canonicalize(value));
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
