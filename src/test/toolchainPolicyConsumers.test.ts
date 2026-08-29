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

  it('pins continuous automatic preflight to the private builtin engine', () => {
    const text = source('courseTestContinuous.ts');
    expect(text).toContain('courseTraceMemoryConfigurationErrorForEngine');
    expect(text).toContain('requiredCourseTraceToolchainChecks');
    expect(text).toContain('const engineMode = automaticTestEngineMode');
    expect(text).toContain('engineMode: automaticTestEngineMode');
    expect(text).not.toContain('getMipsEngine(resource)');
  });

  it('keeps manual P3 engine selection while pinning generated Logisim work to builtin', () => {
    const text = source('courseTestLogisim.ts');
    expect(text).toContain("const automatic = source.kind === 'generator'");
    expect(text).toContain('automatic ? automaticTestEngineMode : getMipsEngine(asm)');
    expect(text).toContain('nonInteractive: automatic');
    expect(text).toContain('engineMode: options.nonInteractive ? automaticTestEngineMode : undefined');
    expect(text).not.toMatch(/tools:\s*\[\s*['"]java['"]\s*,\s*['"]mars['"]/);
  });

  it('pins generated case provenance and hidden dump compatibility to builtin', () => {
    const workflow = source(path.join('courseTesting', 'generatorWorkflow.ts'));
    const coordinator = source('courseTest.ts');
    expect(workflow).toContain('resolveCourseEnginePlan(automaticTestEngineMode, setup.profile)');
    expect(workflow).toContain('enginePlan,');
    expect(coordinator).toContain('resolveCourseEnginePlan(automaticTestEngineMode, setup.profile)');
    expect(coordinator).toContain('nonInteractive: true');
  });
});
