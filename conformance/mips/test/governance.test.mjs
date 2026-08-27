import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import test from 'node:test';

import {
  assertPolicyReviewer,
  phase0ApprovalReviewer
} from '../governance/reviewerPolicy.mjs';

test('phase-0 approval policy has one allowed GitHub reviewer', () => {
  assert.equal(phase0ApprovalReviewer, 'stone926');
  assert.equal(assertPolicyReviewer('stone926'), 'stone926');
  assert.throws(() => assertPolicyReviewer('attacker-user'), /policy reviewer stone926/);
  assert.throws(() => assertPolicyReviewer('not a user'), /GitHub username/);
});

test('CODEOWNERS protects evidence, validators, workflows, and policy itself', () => {
  const codeowners = fs.readFileSync(new URL('../../../.github/CODEOWNERS', import.meta.url), 'utf8');
  for (const rule of [
    '/.github/CODEOWNERS @stone926',
    '/.github/workflows/ @stone926',
    '/conformance/mips/ @stone926',
    '/docs/adr/0001-mips-performance-baseline-policy.md @stone926'
  ]) {
    assert.match(codeowners, new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});

test('package scripts keep candidate and formal gates mechanically separate', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts['run:candidate'], /run-conformance\.mjs/);
  assert.doesNotMatch(packageJson.scripts['run:candidate'], /--formal/);
  assert.match(packageJson.scripts['run:formal'], /--formal/);
  assert.equal(packageJson.scripts['run:required'], 'npm run run:formal');
  assert.match(packageJson.scripts['verify:formal'], /verify:isa-golden:approved/);
  assert.match(packageJson.scripts['verify:formal'], /verify:course-vectors:approved/);
  assert.match(packageJson.scripts['verify:formal'], /verify:ts-cli:approved/);
  assert.match(packageJson.scripts['verify:formal'], /benchmark:verify-approved/);
  assert.match(packageJson.scripts['verify:formal'], /verify:seed-evidence:formal/);
  assert.match(packageJson.scripts['verify:candidate'], /verify:seed-evidence:candidate/);
  assert.doesNotMatch(packageJson.scripts['verify:candidate'], /seed-evidence:formal/);
  assert.doesNotMatch(packageJson.scripts['verify:candidate'], /:approved|verify:formal|run:formal/);
});
