#!/usr/bin/env node
// Production controller + real Worker verification; run after npm run compile.
// Optional source argument uses the P2 convolution sample: dimensions 3,3,2,2;
// target 1..9; kernel 1,0,0,1; expected output "6 8 \n12 14 \n".
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MarsWorkbenchController } = require('../out/mips/debug/controller.js');
const { MipsRuntimeManager } = require('../out/mips/host/runtimeManager.js');
const { captureAssemblyInput } = require('../out/mips/host/sourceInput.js');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(projectRoot, '.vscode-test');
await fs.mkdir(artifactRoot, { recursive: true });
const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(artifactRoot, 'workbench-input.asm');
const inputs = process.argv[2] ? ['3', '3', '2', '2', '1', '2', '3', '4', '5', '6', '7', '8', '9', '1', '0', '0', '1'] : ['19', '23'];
const expectedOutput = process.argv[2] ? '6 8 \n12 14 \n' : '42';
if (!process.argv[2]) {
  await fs.writeFile(sourcePath, `.text\n${'nop\n'.repeat(64)}li $v0, 5\nsyscall\nmove $s0, $v0\nli $v0, 5\nsyscall\naddu $a0, $s0, $v0\nli $v0, 1\nsyscall\nli $v0, 10\nsyscall\n`);
}
const sourceBefore = await fs.readFile(sourcePath);
const runtime = new MipsRuntimeManager();
const runs = [];
let recording;
let waiter;
const mode = { kind: 'mars', memoryConfiguration: 'Default', delayedBranching: false };
const controller = new MarsWorkbenchController({
  sourcePath, mode, ordinaryMode: mode, runtime,
  capture: () => captureAssemblyInput(sourcePath, path.dirname(sourcePath)),
  diagnostics(items) { assert.deepEqual(items, [], JSON.stringify(items)); },
  changed(state) {
    if (recording && ['paused', 'input', 'exited'].includes(state.status)) recording.states.push(structuredClone(state));
    waiter?.(state);
  }
});

function until(predicate, label) {
  if (controller.state.status === 'error') return Promise.reject(new Error(controller.state.message));
  if (predicate(controller.state)) return Promise.resolve(controller.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiter = undefined; reject(new Error(`Timeout waiting for ${label}: ${controller.state.status}, ${controller.state.message}`)); }, 10_000);
    waiter = state => {
      if (state.status !== 'error' && !predicate(state)) return;
      clearTimeout(timer); waiter = undefined;
      if (state.status === 'error') reject(new Error(state.message)); else resolve(state);
    };
  });
}
function verifyInput(state) {
  const instruction = state.instructions.find(row => row.address === state.pc);
  assert.ok(instruction, 'Waiting PC must be included in the listing page');
  assert.equal(instruction.instruction, 'syscall', 'Waiting PC must point at the actual input syscall');
  assert.equal(state.registers.find(register => register.detail === '$2')?.value, 5);
  const location = controller.sourceAtAddress(state.pc);
  assert.ok(location, 'Input syscall must map back to captured source');
  assert.equal(instruction.source.line, location.line);
}
async function command(request, predicate) {
  await controller.handle(request);
  return until(predicate, request.type);
}
async function verifyPendingInspection() {
  const pending = controller.state;
  for (const address of [0x10010100, 0x7fffef80, 0x10010000]) {
    const state = await command({ type: 'memory', address }, next => next.memoryAddress === address);
    assert.equal(state.status, 'input', 'Memory inspection must preserve the pending input');
    assert.equal(state.inputPrompt, pending.inputPrompt);
    assert.equal(state.pc, pending.pc, 'Inspection must not execute instructions');
    assert.equal(state.steps, pending.steps);
    assert.equal(state.console, pending.console, 'Inspection must not submit or echo input');
    assert.equal(state.memory[0]?.address, address);
    verifyInput(state);
  }
  recording.inspectedWhileInput = true;
}
async function verifyRun(kind) {
  recording = { kind, states: [] };
  runs.push(recording);
  await command({ type: kind === 'run' ? 'assemble' : 'reset' }, state => state.status === 'paused');
  let consumed = 0;
  let stepped = 0;
  let laterRow;
  if (kind === 'run') await command({ type: 'run' }, state => state.status === 'input' || state.status === 'exited');
  while (controller.state.status !== 'exited') {
    const state = controller.state;
    if (state.status === 'input') {
      verifyInput(state);
      if (consumed === 1) await verifyPendingInspection();
      assert.ok(consumed < inputs.length, 'Program requested more inputs than the sample contains');
      const previousSteps = state.steps;
      await command({ type: 'input', text: inputs[consumed++] }, next =>
        (next.status === 'paused' && next.steps > previousSteps) || next.status === 'input' || next.status === 'exited');
      continue;
    }
    assert.equal(state.status, 'paused');
    const row = state.instructions.findIndex(instruction => instruction.address === state.pc);
    if (consumed === inputs.length && row >= 50 && !laterRow) {
      laterRow = { address: state.pc, row: state.instructionOffset + row, sourceLine: controller.sourceAtAddress(state.pc)?.line };
    }
    if (kind === 'step' && !laterRow) {
      assert.ok(stepped++ < 4096, 'Sample did not reach a later listing row within the step budget');
      const previousSteps = state.steps;
      await command({ type: 'step' }, next =>
        (next.status === 'paused' && next.steps > previousSteps) || next.status === 'input' || next.status === 'exited');
    } else {
      await command({ type: 'run' }, next => next.status === 'input' || next.status === 'exited');
    }
  }
  assert.equal(consumed, inputs.length);
  assert.equal(controller.state.console, inputs.map(input => `${input}\n`).join('') + expectedOutput);
  if (kind === 'step') assert.ok(laterRow, 'Single stepping must reach a later listing row');
  recording.stepped = stepped;
  recording.laterRow = laterRow;
  recording.finalSteps = controller.state.steps;
  recording = undefined;
}

try {
  assert.equal(runtime.started, false);
  await verifyRun('run');
  await verifyRun('step');
  assert.deepEqual(await fs.readFile(sourcePath), sourceBefore, 'The source file must remain unchanged');
  const artifact = path.join(artifactRoot, 'mars-workbench-program.json');
  await fs.writeFile(artifact, JSON.stringify({ sourcePath, inputs, expectedOutput, runs }, null, 2));
  console.log(`PASS production workbench + Worker: ${inputs.length} inputs, ${controller.state.instructionCount} listing rows, ${runs[1].stepped} single steps; output ${JSON.stringify(expectedOutput)}`);
  console.log(`Recorded states: ${artifact}`);
} finally {
  controller.dispose();
  runtime.dispose();
}
