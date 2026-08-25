#!/usr/bin/env node
/**
 * MARS performance baseline benchmark (plan section 8.1).
 *
 * Phase 0 ships the matrix and report schema only; measurements are taken later
 * on a fixed CI runner (CPU governor/concurrency/Java/Node recorded) and the
 * initial SLOs confirmed by ADR. Do not treat a run on a dev laptop as the
 * fixed baseline.
 *
 * Matrix:
 *   assembly:      10 / 200 / 1000 / 4096 words
 *   execution:     1K / 65536 / 1M steps
 *   trace modes:   off | course commit trace (coL2)
 *   workload mix:  plain | memory-heavy | p7 exception/irq/timer-heavy (later phases)
 *   cold/warm:     cold end-to-end (JVM start), warm assemble, warm execute
 *
 * Usage: node bench/mars-benchmark.mjs [--quick]
 *   --quick runs only the 10-word x 1K-step x off cell for smoke-testing the harness.
 *
 * Output: JSON lines with schemaRevision, cell, wallClockMs, exitCode, rssKb (child),
 * javaVersion, nodeVersion, startedAt (epoch), runnerRevision. Summary at the end.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const cacheDir = path.resolve(here, '..', '..', '.cache');
const jar = path.join(cacheDir, 'Mars_CO_v0.6.3.jar');
const quick = process.argv.includes('--quick');
const runnerRevision = 1;

const assemblyCells = quick ? [10] : [10, 200, 1000, 4096];
const stepCells = quick ? [1000] : [1000, 65536, 1000000];
const traceModes = quick ? ['off'] : ['off', 'coL2'];

function report(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function generateAsm(wordCount) {
  // Deterministic straight-line text ending in the standard halt loop. The
  // benchmark measures MARS overhead, not generator quality.
  const lines = ['.text'];
  const payload = wordCount - 2;
  for (let i = 0; i < payload; i++) {
    lines.push(i % 2 === 0 ? `    ori $t0, $0, ${(i & 0xffff).toString(16)}` : `    addu $t1, $t1, $t0`);
  }
  lines.push('_end:', '    beq $0, $0, _end', '    nop');
  return `${lines.join('\n')}\n`;
}

function runCell(wordCount, steps, traceMode) {
  const asm = generateAsm(wordCount);
  const asmFile = path.join(here, '.tmp-bench.asm');
  fs.writeFileSync(asmFile, asm);
  const args = ['-jar', jar, 'nc', 'mc', 'FixedCompactLargeText'];
  if (traceMode === 'coL2') {
    args.push('coL2');
  }
  args.push(String(steps), asmFile);
  const startedAt = Date.now();
  const result = spawnSync('java', args, { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const wallClockMs = Date.now() - startedAt;
  fs.rmSync(asmFile, { force: true });
  return {
    schemaRevision: 1,
    runnerRevision,
    cell: { wordCount, steps, traceMode, workload: 'plain' },
    wallClockMs,
    exitCode: result.status,
    ok: result.status === 0,
    note: result.status !== 0 ? `stderr head: ${result.stderr.slice(0, 200)}` : undefined
  };
}

function main() {
  if (!fs.existsSync(jar)) {
    console.error(`Reference JAR missing: ${jar}`);
    console.error('Run "node reference/download-references.mjs" first.');
    process.exitCode = 1;
    return;
  }
  const javaVersion = spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0]?.trim();
  console.error(`Benchmark runner revision ${runnerRevision}${quick ? ' (--quick)' : ''}`);
  console.error(`Java: ${javaVersion}`);
  console.error(`Node: ${process.version}`);
  for (const wordCount of assemblyCells) {
    for (const traceMode of traceModes) {
      for (const steps of stepCells) {
        report(runCell(wordCount, steps, traceMode));
      }
    }
  }
  console.error('Done. Store this run only on the fixed CI runner; laptop runs are harness smoke tests.');
}

main();
