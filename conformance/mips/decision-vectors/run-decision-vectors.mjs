#!/usr/bin/env node
import { runDecisionVectors } from './runner.mjs';

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--require-rtl');
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}`);
  process.exit(2);
}

const report = runDecisionVectors({ requireRtl: args.includes('--require-rtl') });
for (const result of report.results) {
  console.log(`${result.status.toUpperCase()} ${result.id}: ${result.evidence} (${result.vectors} vectors)`);
}
if (!report.ok) {
  console.error(report.requireRtl
    ? 'Decision-vector verification failed (official RTL evidence is required).'
    : 'Decision-vector verification failed.');
  process.exitCode = 1;
}
