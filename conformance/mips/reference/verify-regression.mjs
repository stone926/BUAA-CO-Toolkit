#!/usr/bin/env node
/** Cross-platform execution of the frozen v0.6.3 regression ZIP. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { referenceRoles, resolveVerifiedReference } from './referenceAssets.mjs';

const expectedEntries = [
  'behlbal.class', 'behlbal.java', 'code1.asm', 'code2.asm', 'code_cc.asm',
  'run_p7_regression.bat', 'stdout1.txt', 'stdout2.txt', 'stdout_cc1.txt', 'stdout_cc2.txt',
  'p7/bd_not_taken.asm', 'p7/bd_not_taken.out', 'p7/cp0_mask.asm', 'p7/cp0_mask.out',
  'p7/eret_delay_slot.asm', 'p7/eret_delay_slot.out',
  'p7/external_interrupt_ip.asm', 'p7/external_interrupt_ip.out',
  'p7/fetch_unaligned.asm', 'p7/fetch_unaligned.out', 'p7/jump_far.asm', 'p7/jump_far.out',
  'p7/status.asm', 'p7/status.out', 'p7/status_legacy.out',
  'p7/timer_write_count.asm', 'p7/timer_write_count.out'
].sort();

const cases = [
  { id: 'status', asm: 'p7/status.asm', expected: 'p7/status.out', efc: true, extra: [] },
  { id: 'bd_not_taken', asm: 'p7/bd_not_taken.asm', expected: 'p7/bd_not_taken.out', efc: true, extra: ['db'] },
  { id: 'fetch_unaligned', asm: 'p7/fetch_unaligned.asm', expected: 'p7/fetch_unaligned.out', efc: true, extra: ['db'] },
  { id: 'jump_far', asm: 'p7/jump_far.asm', expected: 'p7/jump_far.out', efc: true, extra: ['db'] },
  { id: 'external_interrupt_ip', asm: 'p7/external_interrupt_ip.asm', expected: 'p7/external_interrupt_ip.out', efc: true, extra: ['db', 'p7irq=0x3008'] },
  { id: 'timer_write_count', asm: 'p7/timer_write_count.asm', expected: 'p7/timer_write_count.out', efc: true, extra: [] },
  { id: 'eret_delay_slot', asm: 'p7/eret_delay_slot.asm', expected: 'p7/eret_delay_slot.out', efc: true, extra: ['db'] },
  { id: 'cp0_mask', asm: 'p7/cp0_mask.asm', expected: 'p7/cp0_mask.out', efc: true, extra: [] },
  { id: 'status_legacy', asm: 'p7/status.asm', expected: 'p7/status_legacy.out', efc: false, extra: [] }
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    ...options
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.error?.message ?? `exit ${result.status}`}\n${(result.stderr ?? '').slice(0, 1000)}`
    );
  }
  return result.stdout ?? '';
}

function withoutBlankLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n').filter((line) => line.length > 0).join('\n');
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const count = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < count; index++) {
    if (expectedLines[index] !== actualLines[index]) {
      return `line ${index + 1}: expected ${JSON.stringify(expectedLines[index])}, got ${JSON.stringify(actualLines[index])}`;
    }
  }
  return 'unknown difference';
}

function main() {
  const regression = resolveVerifiedReference(referenceRoles.frozenRegression);
  const jarTool = process.env.CONFORMANCE_JAR_TOOL || 'jar';
  const listed = run(jarTool, ['tf', regression.file]).split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(listed) !== JSON.stringify(expectedEntries)) {
    throw new Error(`frozen regression ZIP entry list changed:\n${listed.join('\n')}`);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buaa-co-mars-regression-'));
  try {
    run(jarTool, ['xf', regression.file], { cwd: temporaryRoot });
    let passed = 0;
    for (const regressionCase of cases) {
      // Re-resolve and re-hash the executable role for every regression JVM.
      const assembler = resolveVerifiedReference(referenceRoles.stockAssembler);
      const args = ['-jar', assembler.file, 'nc', 'mc', 'CompactLargeText', 'ae1', 'se1', 'coL1'];
      if (regressionCase.efc) {
        args.push('efc');
      }
      args.push(...regressionCase.extra, path.join(temporaryRoot, regressionCase.asm));
      const actual = withoutBlankLines(run(process.env.CONFORMANCE_JAVA || 'java', args));
      const expected = withoutBlankLines(fs.readFileSync(path.join(temporaryRoot, regressionCase.expected), 'utf8'));
      if (actual !== expected) {
        throw new Error(`${regressionCase.id} differs: ${firstDifference(expected, actual)}`);
      }
      passed++;
      process.stdout.write(`${JSON.stringify({ type: 'regression-result', caseId: regressionCase.id, status: 'passed' })}\n`);
    }
    process.stdout.write(`${JSON.stringify({
      type: 'regression-summary',
      passed,
      failed: 0,
      regressionSha256: regression.verifiedSha256
    })}\n`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`Frozen MARS regression FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
