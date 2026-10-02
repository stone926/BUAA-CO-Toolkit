#!/usr/bin/env node
// Render and exercise the production webview bundle through Chromium's DevTools protocol.
// Start preview-mars-workbench.mjs, then pass its localhost URL. No browser package required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const url = process.argv[2];
if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error('Pass the local preview fixture URL');
const browser = process.env.CO_BROWSER_EXECUTABLE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const output = path.resolve('.vscode-test/mars-workbench-browser');
await mkdir(output, { recursive: true });
const userData = await mkdtemp(path.join(tmpdir(), 'co-mars-browser-'));
const port = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, predicate) {
  const start = Date.now();
  while (Date.now() - start < 15000) { const result = await predicate(); if (result) return result; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const targets = await until('browser debugger', async () => {
    try { const response = await fetch(`http://127.0.0.1:${port}/json/list`); return response.ok ? response.json() : false; } catch { return false; }
  });
  const target = targets.find(item => item.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = event => {
    const item = JSON.parse(event.data);
    if (item.id) { const waiter = pending.get(item.id); pending.delete(item.id); if (item.error) waiter?.reject(new Error(JSON.stringify(item.error))); else waiter?.resolve(item.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + JSON.stringify(result.exceptionDetails.exception));
    return result.result.value;
  };
  const click = label => evaluate(`[...document.querySelectorAll('button')].find(item=>item.textContent===${JSON.stringify(label)}).click()`);
  const navigate = async (query = '') => {
    await call('Page.navigate', { url: url + query });
    await until('workbench rendered', () => evaluate(`location.href === ${JSON.stringify(url + query)} && Boolean(window.__workbenchFixture && document.querySelector('.status-badge')?.textContent!=='连接中')`));
    await delay(80);
  };
  const screenshot = async name => {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
  };
  await call('Page.enable'); await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false });
  await navigate();
  await screenshot('dark');
  assert.equal(await evaluate(`document.querySelectorAll('.listing-table tbody tr').length`), 40);
  await click('单步 →');
  assert.equal(await evaluate(`window.__workbenchFixture.requests.at(-1).type`), 'step');
  await evaluate(`document.querySelector('.breakpoint').click()`);
  assert.equal(await evaluate(`window.__workbenchFixture.requests.at(-1).type`), 'breakpoint');
  await click('符号');
  assert.equal(await evaluate(`[...document.querySelectorAll('.symbols-panel tbody tr')].find(row=>row.textContent.includes('BUFFER_SIZE')).querySelector('button').disabled`), true, '.eqv constants are values, not memory links');
  await click('内存');
  await screenshot('memory');
  await click('系统服务');
  await screenshot('syscalls');
  await evaluate(`(()=>{const input=document.querySelector('input[type="search"]');input.value='sbrk';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.equal(await evaluate(`document.querySelector('.syscall-scroll tbody').children.length`), 1);
  await evaluate(`(()=>{const input=document.querySelector('input[type="search"]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`window.__workbenchFixture.setState({mode:'P7',modeLabel:'P7 课程 CPU'})`);
  await until('P7 syscall explanation', () => evaluate(`document.body.innerText.includes('ExcCode') && /0x0*4180/.test(document.body.innerText)`));
  await screenshot('p7');
  await navigate('?scenario=input');
  const darkColors = await evaluate(`({scheme:getComputedStyle(document.body).colorScheme,input:getComputedStyle(document.querySelector('#console-stdin')).backgroundColor,select:getComputedStyle(document.querySelector('select')).backgroundColor,current:getComputedStyle(document.querySelector('.current-instruction')).backgroundColor,scrollbar:getComputedStyle(document.querySelector('.listing-scroll'),'::-webkit-scrollbar-thumb').backgroundColor})`);
  assert.equal(darkColors.scheme, 'dark', 'native dark controls and scrollbars use a dark color scheme');
  for (const key of ['input','select','scrollbar']) assert.notEqual(darkColors[key], 'rgb(255, 255, 255)', `${key} must follow the dark theme`);
  await writeFile(path.join(output, 'dark-theme-colors.json'), JSON.stringify(darkColors, null, 2));
  await screenshot('dark-input');
  await navigate('?theme=light&scenario=input');
  assert.equal(await evaluate(`getComputedStyle(document.body).backgroundColor`), 'rgb(255, 255, 255)', 'light theme variables apply at body scope');
  const inputSelector = '#console-stdin';
  await evaluate(`document.querySelector(${JSON.stringify(inputSelector)}).value='41';document.querySelector(${JSON.stringify(inputSelector)}).focus()`);
  await evaluate(`window.__workbenchFixture.setState({steps:5})`);
  await delay(80);
  assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(inputSelector)}) && document.activeElement.value==='41'`), true, 'updates preserve active input');
  await screenshot('light-input');
  await evaluate(`document.querySelector(${JSON.stringify(inputSelector)}).closest('form').requestSubmit()`);
  assert.equal(await evaluate(`window.__workbenchFixture.requests.at(-1).text`), '41');
  await navigate('?scenario=stale');
  assert.equal(await evaluate(`document.querySelector('.stale-banner').hidden`), false);
  // Source text is untrusted: it must stay text, never become executable DOM.
  await evaluate(`window.__workbenchFixture.state.instructions[0].source.text='<img src=x onerror="window.__unsafe=true">';window.__workbenchFixture.publish()`);
  await delay(80);
  assert.equal(await evaluate(`Boolean(window.__unsafe || document.querySelector('.listing-table img'))`), false);
  await call('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  await screenshot('narrow');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'no page horizontal overflow');
  await call('Emulation.setDeviceMetricsOverride', { width: 520, height: 1000, deviceScaleFactor: 1, mobile: false });
  await screenshot('split-panel');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'split panel has no page horizontal overflow');
  await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate('?theme=hc&scenario=empty');
  await screenshot('high-contrast-empty');
  await navigate('?theme=hc-light&scenario=input');
  assert.equal(await evaluate(`getComputedStyle(document.body).colorScheme`), 'light');
  await screenshot('high-contrast-light');
  console.log(`PASS production MARS webview rendering/actions/input focus/XSS/responsive checks; screenshots: ${output}`);
  await call('Browser.close');
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
}
