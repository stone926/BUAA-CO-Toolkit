#!/usr/bin/env node
// End-to-end source/include capture -> production Worker -> MARS IO -> artifacts.
// No Java or external MARS is used; run after npm run compile.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MipsRuntimeManager } = require('../out/mips/host/runtimeManager.js');
const { runInternalMars } = require('../out/mips/host/marsService.js');
const runtime = new MipsRuntimeManager();
const root = await fs.mkdtemp(path.join(tmpdir(), 'co-mars-e2e-'));
const sourcePath = path.join(root, '课程 测试.asm');
let passed = 0;
async function run(text, options = {}, execute = true) {
  await fs.writeFile(sourcePath, text);
  return runInternalMars({ sourcePath, allowedRoot: root, runtime, memoryConfiguration: 'Default',
    delayedBranching: false, timeoutMs: 5000, ...options }, execute);
}
function check(output, expected) {
  assert.equal(output.result.ok, true, output.result.stderr);
  assert.equal(output.result.stdout, expected);
  passed++;
}
try {
  assert.equal(runtime.started, false);
  await fs.writeFile(path.join(root, '公共 宏.asm'), '.macro print(%r)\nmove $a0,%r\nli $v0,1\nsyscall\n.end_macro\n');
  check(await run('.include "公共 宏.asm"\n.text\nli $t0,42\nprint($t0)\nli $v0,10\nsyscall\n'), '42');
  const echo = '.text\nli $v0,5\nsyscall\nmove $a0,$v0\nli $v0,1\nsyscall\nli $v0,10\nsyscall\n';
  check(await run(echo, { stdin: '-2147483648\n' }), '-2147483648');
  check(await run('.data\nbuf: .space 4\n.text\nli $a0,0\nla $a1,buf\nli $a2,4\nli $v0,14\nsyscall\nlbu $a0,buf\nli $v0,1\nsyscall\nlbu $a0,buf+2\nli $v0,1\nsyscall\n',
    { stdin: Uint8Array.from([255, 0, 128, 65]) }), '255128');
  check(await run('.data\nutf8: .byte 0xe4,0xb8,0xad\n.text\nli $a0,1\nla $a1,utf8\nli $a2,1\nli $v0,15\nsyscall\naddiu $a1,$a1,1\nli $v0,15\nsyscall\naddiu $a1,$a1,1\nli $v0,15\nsyscall\n'), '中');
  const writes = [];
  let reads = 0;
  check(await run(echo, { console: { write: text => writes.push(text), readLine: async () => { reads++; return '73\n'; } } }), '73');
  assert.equal(reads, 1); assert.equal(writes.join(''), '73');
  check(await run('.text\nli $a0,16\nli $v0,9\nsyscall\nli $t0,12345\nsw $t0,0($v0)\naddiu $sp,$sp,-4\nsw $v0,0($sp)\nlw $t1,0($sp)\nlw $a0,0($t1)\nli $v0,1\nsyscall\n'), '12345');
  for (const memoryConfiguration of ['Default', 'CompactDataAtZero', 'CompactTextAtZero']) {
    check(await run('.data\nmsg: .asciiz "layout"\n.text\nla $a0,msg\nli $v0,4\nsyscall\n', { memoryConfiguration }), 'layout');
  }
  const files = `.data
name: .asciiz "读写 文件.txt"
payload: .ascii "FILE_OK"
buf: .space 16
.text
la $a0,name
li $a1,1
li $v0,13
syscall
move $s0,$v0
move $a0,$s0
la $a1,payload
li $a2,7
li $v0,15
syscall
move $a0,$s0
li $v0,16
syscall
la $a0,name
li $a1,0
li $v0,13
syscall
move $s0,$v0
move $a0,$s0
la $a1,buf
li $a2,7
li $v0,14
syscall
move $a0,$s0
li $v0,16
syscall
la $a0,buf
li $v0,4
syscall
`;
  check(await run(files), 'FILE_OK');
  assert.equal(await fs.readFile(path.join(root, '读写 文件.txt'), 'utf8'), 'FILE_OK');
  check(await run('.text\nli $v0,6\nsyscall\nmov.s $f12,$f0\nli $v0,2\nsyscall\n', { stdin: '1.5\n' }), '1.5');
  const malformed = await run('.text\ninvalid_instruction\n');
  assert.equal(malformed.result.ok, false); assert.match(malformed.result.stderr, /asm\.(instruction\.unknown|pseudo\.unsupported)/); passed++;
  const limit = await run('.text\nloop: j loop\nnop\n', { maxSteps: 32 });
  assert.equal(limit.result.ok, false); assert.equal(limit.result.stopReason, 'step-limit'); passed++;
  const timeout = await run('.text\nloop: j loop\nnop\n', { timeoutMs: 100, maxSteps: 100000000 });
  assert.equal(timeout.result.timedOut, true); passed++;
  const abort = new AbortController();
  const pending = run(echo, { signal: abort.signal, console: {
    write() {}, readLine: () => { abort.abort(); return Promise.resolve(undefined); }
  } });
  assert.equal((await pending).result.stopReason, 'cancelled'); passed++;
  check(await run('.text\nli $a0,7\nli $v0,1\nsyscall\n'), '7');
  // Exactly the same syscall instruction must remain a P7 CPU exception.
  const assembled = await runtime.runJob({ kind: 'assembler-assemble', payload: { profile: 'P7', sources: [{ id: 'root', text:
    '.text\nli $v0,1\nli $a0,42\nsyscall\nnop\n.ktext 0x4180\nmfc0 $k0,$13\nhalt: beq $zero,$zero,halt\nnop\n' }] } });
  assert.equal(assembled.ok, true); assert.equal(assembled.payload.ok, true, JSON.stringify(assembled.payload.diagnostics));
  const events = [];
  const hex = value => `0x${value.toString(16).padStart(8, '0')}`;
  const p7 = await runtime.runJob({ kind: 'machine-execute', payload: {
    profile: 'P7', segments: assembled.payload.image.segments.map(segment => ({
      name: segment.name, baseAddress: hex(segment.baseAddress), words: segment.words.map(hex)
    })), entryPc: hex(0x3000), haltPc: hex(0x4184), maxSteps: 32
  } }, { onProgress: batch => { events.push(...batch); } });
  assert.equal(p7.ok, true, p7.error);
  assert.equal(p7.payload.finalState.cp0.epc, '0x00003008');
  assert.equal(p7.payload.finalState.cp0.cause, '0x00000020');
  assert.equal(p7.payload.finalState.gpr[4], '0x0000002a');
  passed++;
  console.log(`PASS internal MARS end-to-end: ${passed} cases, real Worker, no Java/JAR; P7 syscall exception preserved`);
} finally {
  runtime.dispose();
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.match(path.basename(resolved), /^co-mars-e2e-/);
  await fs.rm(resolved, { recursive: true, force: true });
}
