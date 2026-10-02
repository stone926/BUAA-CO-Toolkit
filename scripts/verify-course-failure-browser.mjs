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
const server = createServer((request, response) => {
  const partial = request.url.includes('partial');
  const page = renderCourseTestFailure(partial ? { ...base, status: 'error', diagnostic: '[AUTO-DUT] Icarus 编译失败', evidence: undefined, targets: [], compareAvailable: false, canRerun: false, canWaveform: false, warnings: ['参考写回记录不可用：文件已删除'] } : base);
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
  console.log('Failure page browser checks passed: source/waveform messages, disabled actions, wide/narrow layout.');
} finally {
  socket?.close(); child.kill(); server.close();
}
