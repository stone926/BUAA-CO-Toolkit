import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Stage 1 boundary: production scheduling may reach the legacy process only
 * through LegacyMarsProvider. mips.ts remains the compatibility implementation
 * and command surface, but no other production module may consume runMarsFile.
 */
describe('legacy MARS production boundary', () => {
  it('keeps runMarsFile confined to its implementation and provider adapter', () => {
    const allowed = new Set([
      'src/mips.ts',
      'src/mips/providers/legacyMarsProvider.ts'
    ]);
    const violations = productionTypeScriptFiles(path.join(process.cwd(), 'src'))
      .filter((file) => !allowed.has(file))
      .filter((file) => /\brunMarsFile\b/.test(readFileSync(path.join(process.cwd(), file), 'utf8')));

    expect(violations).toEqual([]);
  });
});

function productionTypeScriptFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (entry !== 'test') {
        result.push(...productionTypeScriptFiles(absolute));
      }
    } else if (entry.endsWith('.ts')) {
      result.push(path.relative(process.cwd(), absolute).replace(/\\/g, '/'));
    }
  }
  return result;
}
