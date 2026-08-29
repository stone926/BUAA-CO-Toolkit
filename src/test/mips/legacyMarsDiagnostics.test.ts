import { describe, expect, it } from 'vitest';
import { legacyMarsCompatibilityDiagnostic } from '../../language/mips/legacyMarsDiagnostics';

const base = {
  stdout: '', stderr: '', mode: 'run' as const, traceOutput: true, courseTrace: true,
  p7RiInstruction: false, memoryConfiguration: 'CompactLargeText'
};

describe('legacy MARS compatibility diagnostics', () => {
  it('treats exit-zero unsupported course options as hard failures', () => {
    expect(legacyMarsCompatibilityDiagnostic({ ...base, stdout: 'Invalid Command Argument: coL2' }))
      .toMatch(/不支持 coL1\/coL2/);
    expect(legacyMarsCompatibilityDiagnostic({ ...base, stderr: 'Invalid Command Argument: p7irq' }))
      .toMatch(/不支持 efc \/ p7irq/);
    expect(legacyMarsCompatibilityDiagnostic({
      ...base, p7RiInstruction: true, stdout: 'Invalid Command Argument: cl'
    })).toMatch(/不支持旧用例所需的 cl/);
    expect(legacyMarsCompatibilityDiagnostic({
      ...base, stdout: 'Invalid memory configuration: CompactLargeText'
    })).toMatch(/不支持 CompactLargeText/);
  });
});
