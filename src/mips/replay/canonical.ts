// @index mips-replay — replay 证据 digest（复用 core 的 canonical JSON；不依赖 VS Code）
import * as crypto from 'crypto';
import { canonicalJson, type CanonicalJson } from '../core/canonicalJson';

/**
 * Canonical JSON 本身定义在 `src/mips/core/canonicalJson.ts`：image fingerprint 与
 * replay digest 必须共享同一个字节序列定义。这里只补上宿主侧的 SHA-256。
 */
export { canonicalJson };
export type { CanonicalJson };

export function sha256Bytes(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function sha256Canonical(value: CanonicalJson): string {
  return sha256Bytes(canonicalJson(value));
}
