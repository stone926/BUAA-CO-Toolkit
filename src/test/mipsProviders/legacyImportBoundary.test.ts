import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Commands share the internal runner; course orchestration uses providers.
 */
describe('internal MARS production boundary', () => {
  it('keeps the console runner confined to its command surface', () => {
    const allowed = new Set(['src/mips.ts']);
    const violations = productionTypeScriptFiles(path.join(process.cwd(), 'src'))
      .filter((file) => !allowed.has(file))
      .filter((file) => /\brunMarsFile\b/.test(readFileSync(path.join(process.cwd(), file), 'utf8')));

    expect(violations).toEqual([]);
  });

  it('keeps legacy request and trace repair APIs out of provider-neutral course orchestration', () => {
    const forbidden = /\b(?:iterMarsDetailedTraceEvents|courseTraceMarsHaltError|courseMarsOracleCompatibilityError|machineCodeNeedsDetailedMarsTrace|marsDetailedUndefinedBehaviorError|traceLevel|traceOutput|imageRef)\b/;
    const violations = [
      'src/courseTesting/traceRunner.ts',
      'src/courseTestLogisim.ts'
    ].filter((file) => forbidden.test(readFileSync(path.join(process.cwd(), file), 'utf8')));

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
