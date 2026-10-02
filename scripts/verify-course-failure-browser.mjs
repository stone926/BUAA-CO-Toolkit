#!/usr/bin/env node
// Exercise the production failure-page renderer and scripts in headless Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { build } from 'esbuild';

const output = path.resolve('.vscode-test/cpu-failure-browser');
await mkdir(output, { recursive: true });
const bundle = path.resolve('.vscode-test/course-failure-renderer.cjs');
await build({ entryPoints: ['src/courseTestFailureReport.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' });
const { renderCourseTestFailure } = createRequire(import.meta.url)(bundle);
const writebackBundle = path.resolve('.vscode-test/course-writeback-renderer.cjs');
await build({
  stdin: {
    contents: "export { renderWritebackComparison } from './src/courseTestWritebackReport';\nexport { buildWritebackComparison } from './src/courseTesting/writebackComparison';",
    resolveDir: process.cwd(), sourcefile: 'course-writeback-browser-entry.ts'
  }, outfile: writebackBundle, bundle: true, platform: 'node', format: 'cjs'
});
const { renderWritebackComparison, buildWritebackComparison } = createRequire(import.meta.url)(writebackBundle);
const base = {
  caseId: '20261002T000000000Z-abcd1234', profile: 'P5', status: 'failed',
  diagnostic: '[AUTO-MISMATCH] 写回值不一致。参考结果 PC 00003084，$8 <= 0000002a；待测 CPU PC 00003084，$8 <= 00000000',
  evidence: { version: 1, index: 32,
    oracle: { pc: '00003084', kind: 'grf', target: '8', value: '0000002a', lineNumber: 33, raw: '' },
    dut: { pc: '00003084', kind: 'grf', target: '8', value: '00000000', lineNumber: 36, raw: '' } },
  targets: [{ label: '差异指令', pc: 0x3084, line: 39, text: 'add $8, $9, $10' }],
  sourceAvailable: true, compareAvailable: true, dutAvailable: true,
  logs: ['Icarus 仿真日志'], canRerun: true, canWaveform: true, canHazard: true, warnings: []
};
const oracleLines = [];
const dutLines = ['WARNING: memory read did not fill the requested range'];
for (let index = 0; index < 127; index++) {
  const pc = (0x3000 + index * 4).toString(16).padStart(8, '0');
  const target = index % 3 === 0 ? `*${(0x1000 + index * 4).toString(16)}` : `$${index % 31 + 1}`;
  const value = (0x10000000 + index * 0x101).toString(16).padStart(8, '0');
  const actual = index === 31 || index === 64 ? `${value.slice(0, 6)}${value[6] === 'f' ? 'e' : 'f'}${value[7]}` : value;
  oracleLines.push(`@${pc}: ${target} <= ${value}`);
  dutLines.push(index % 2 ? `  48@${pc.toUpperCase()}: ${target.replace('$', '$ ')} <= ${actual.toUpperCase()} ` : `38@${pc}: ${target} <= ${actual}`);
  if (index === 40) dutLines.push('WARNING: ignored non-writeback diagnostic between trace records');
}
const writebackModel = await buildWritebackComparison(oracleLines.join('\n'), dutLines.join('\n'));
assert.deepEqual(writebackModel.differences, [31, 64], 'fixture should produce the intended architectural differences');
const writebackView = {
  caseId: '20261002T000000000Z-abcd1234', comparison: writebackModel, focus: 31, start: 26,
  sources: new Map([
    ['31:oracle', { line: 32, text: 'add $1, $2, $3' }],
    ['31:dut', { line: 34, text: 'add $1, $2, $4' }],
    ['64:oracle', { line: 65, text: 'sw $5, 0($6)' }],
    ['64:dut', { line: 68, text: 'sw $5, 0($7)' }]
  ])
};
const writebackPage = renderWritebackComparison(writebackView);
const server = createServer((request, response) => {
  const partial = request.url.includes('partial');
  const page = request.url.includes('writeback')
    ? renderWritebackComparison(request.url.includes('second') ? { ...writebackView, focus: 64, start: 59 } : writebackView)
    : renderCourseTestFailure(partial ? { ...base, status: 'error', diagnostic: '[AUTO-DUT] Icarus 编译失败', evidence: undefined, targets: [], compareAvailable: false, canRerun: false, canWaveform: false, warnings: ['参考写回记录不可用：文件已删除'] } : base);
  const nonce = page.match(/<script nonce="([^"]+)"/)?.[1];
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(page.replace(`<script nonce="${nonce}">`, `<script nonce="${nonce}">window.requests=[];window.acquireVsCodeApi=()=>({postMessage:message=>window.requests.push(message)});</script><script nonce="${nonce}">`));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const port = await new Promise(resolve => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => resolve(value)); });
});
const userData = await mkdtemp(path.join(tmpdir(), 'co-failure-browser-'));
const child = spawn(process.env.CO_BROWSER_EXECUTABLE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, 'about:blank'
], { windowsHide: true, stdio: 'ignore' });
let socket;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, predicate) {
  const start = Date.now();
  while (Date.now() - start < 15000) { const result = await predicate(); if (result) return result; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const targets = await until('browser debugger', async () => {
    try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return false; }
  });
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = event => {
    const result = JSON.parse(event.data);
    const waiter = pending.get(result.id);
    if (!waiter) return;
    pending.delete(result.id);
    if (result.error) waiter.reject(new Error(JSON.stringify(result.error))); else waiter.resolve(result.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.enable');
  for (const [name, width, partial] of [['wide', 1100, false], ['narrow', 420, false], ['partial', 720, true]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${url}?${name}${partial ? '&partial' : ''}` });
    await until('page ready', () => evaluate('Boolean(window.requests && document.querySelector("[data-failure-action]"))'));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${name}: page must fit its viewport`);
    if (!partial) {
      await evaluate('document.querySelector("[data-failure-action=source]").click()');
      assert.deepEqual(await evaluate('window.requests.pop()'), { action: 'source', index: 0 });
      await evaluate('document.querySelector("[data-failure-action=waveform]").click()');
      assert.deepEqual(await evaluate('window.requests.pop()'), { action: 'waveform' });
    } else {
      await evaluate('document.querySelector("[data-failure-action=rerun]").click()');
      assert.equal(await evaluate('window.requests.length'), 0, 'unavailable reruns must not send messages');
      assert.equal(await evaluate('document.querySelector("details").open'), true);
    }
    const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(output, `${name}.png`), Buffer.from(capture.data, 'base64'));
  }
  for (const [name, width] of [['writeback-wide', 1100], ['writeback-narrow', 420]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${url}?writeback` });
    await until('writeback page ready', () => evaluate('Boolean(window.requests && document.querySelector("[data-writeback-action=source]"))'));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${name}: page must fit its viewport`);
    if (width <= 560) {
      assert.equal(await evaluate('(() => { const region=document.querySelector(".writeback-table"); const table=region.querySelector("table"); const last=table.querySelector("tr[data-selected] td:last-child").getBoundingClientRect(); const bounds=region.getBoundingClientRect(); return table.scrollWidth <= region.clientWidth && last.right <= bounds.right - 1; })()'), true, `${name}: both value columns should fit without horizontal table scrolling`);
    }
    assert.equal(await evaluate('Boolean(document.querySelector("tr[data-selected]")?.getBoundingClientRect().height)'), true, `${name}: first difference should be rendered`);
    assert.equal(await evaluate('(() => { const r=document.querySelector("tr[data-selected]").getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; })()'), true, `${name}: selected row should be visible`);
    assert.equal(await evaluate('document.querySelector("tr[data-selected] .row-status").textContent'), '值不同');
    assert.equal(await evaluate('document.querySelectorAll("tr[data-selected] .field-change").length'), 2, 'only the changed value digits should be highlighted');
    assert.equal(await evaluate('document.querySelectorAll("tr.equal .field-change").length'), 0, 'matching rows must not have highlighted fields');
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".writeback-toolbar [data-writeback-action]")].map(button => [button.dataset.writebackAction, button.disabled])'), [
      ['first', false], ['previous', true], ['next', false]
    ]);
    await evaluate('document.querySelector(".writeback-toolbar [data-writeback-action=next]").click()');
    assert.deepEqual(await evaluate('window.requests.pop()'), { action: 'next' });
    await evaluate('document.querySelector("tr[data-selected] [data-writeback-action=source][data-side=oracle]").click()');
    assert.deepEqual(await evaluate('window.requests.pop()'), { action: 'source', row: 31, side: 'oracle' });
    await evaluate('document.querySelector("details").open=true; document.querySelector("[data-writeback-action=rawOracle]").click()');
    assert.deepEqual(await evaluate('window.requests.pop()'), { action: 'rawOracle' });
    await evaluate('document.querySelector("[data-writeback-action=rawDut]").click()');
    assert.deepEqual(await evaluate('window.requests.pop()'), { action: 'rawDut' });
    const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(output, `${name}.png`), Buffer.from(capture.data, 'base64'));
  }
  await call('Page.navigate', { url: `${url}?writeback-second` });
  await until('second writeback state ready', () => evaluate('Boolean(document.querySelector("[data-writeback-action=previous]"))'));
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".writeback-toolbar [data-writeback-action]")].map(button => [button.dataset.writebackAction, button.disabled])'), [
    ['first', false], ['previous', false], ['next', true]
  ], 'navigation should disable previous/next at the corresponding ends');
  assert.equal(await evaluate('document.querySelector("tr[data-selected] .event-index").textContent'), '65');
  console.log('Failure and writeback page browser checks passed: renderer actions, value-only highlights, wide/narrow layout and screenshots.');
} finally {
  socket?.close(); child.kill(); server.close();
}
