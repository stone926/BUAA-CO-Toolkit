import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8');
}

describe('mode-aware toolchain policy consumers', () => {
  it.each(['toolchain.ts', 'sidebar.ts', 'wizard.ts'])('%s uses the shared resource-scoped policy', (file) => {
    const text = source(file);
    expect(text).toContain('getEffectiveRequiredTools');
    expect(text).toContain('getMipsEngine(resource)');
    expect(text).not.toContain('getProfileRequiredTools(');
  });

  it.each(['courseTestContinuous.ts', 'courseTestLogisim.ts'])('%s keeps MARS-only preflight behind engine policy', (file) => {
    const text = source(file);
    expect(text).toContain('courseTraceMemoryConfigurationErrorForEngine');
    expect(text).toContain('requiredCourseTraceToolchainChecks');
    expect(text).toContain('getMipsEngine(resource)');
    expect(text).not.toMatch(/tools:\s*\[\s*['"]java['"]\s*,\s*['"]mars['"]/);
  });
});
