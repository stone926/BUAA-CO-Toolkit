#!/usr/bin/env node
/** Development-only browser fixture. Run npm run build:webview, then node scripts/preview-mars-workbench.mjs. */
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogSource = await readFile(path.join(projectRoot, 'src/mips/core/mars/syscallCatalog.ts'), 'utf8');
const catalogModule = await transform(catalogSource, { loader: 'ts', format: 'esm' });
const { marsSyscallCatalog } = await import(`data:text/javascript;base64,${Buffer.from(catalogModule.code).toString('base64')}`);
const registerNames = ['zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];
const source = [
  ['24020004', 'addiu $v0, $zero, 4', 'li $v0, 4'],
  ['3c041001', 'lui $a0, 0x1001', 'la $a0, greeting'],
  ['34840000', 'ori $a0, $a0, 0', 'la $a0, greeting'],
  ['0000000c', 'syscall', 'syscall'],
  ['24080005', 'addiu $t0, $zero, 5', 'li $t0, 5'],
  ['2508ffff', 'addiu $t0, $t0, -1', 'loop: addiu $t0, $t0, -1'],
  ['1500fffe', 'bne $t0, $zero, 0x00400014', 'bne $t0, $zero, loop'],
  ['00000000', 'sll $zero, $zero, 0', 'nop'],
  ['2402000a', 'addiu $v0, $zero, 10', 'li $v0, 10'],
  ['0000000c', 'syscall', 'syscall']
];
const state = {
  status: 'paused', title: '实验示例 / greeting.asm', mode: 'mars', modeLabel: 'MARS · Default · 延迟槽关闭',
  message: '已到达断点，下一条指令尚未执行。', sourceChanged: false, pc: 0x400010, steps: 4, delaySlot: false,
  instructions: Array.from({ length: 40 }, (_, index) => {
    const [word, instruction, sourceText] = source[index % source.length];
    return { address: 0x400000 + index * 4, word: parseInt(word, 16), instruction,
      source: { id: 'preview', name: '实验示例 / greeting.asm', line: index + 6, text: sourceText } };
  }),
  registers: [...registerNames.map((name, index) => ({ name: `$${name}`, value: index === 2 ? 4 : index === 4 ? 0x10010000 : index === 8 ? 5 : index === 29 ? 0x7fffeffc : 0, changed: index === 2 || index === 4, detail: `$${index}` })),
    { name: 'HI', value: 0, changed: false }, { name: 'LO', value: 0, changed: false }],
  floatingPoint: Array.from({ length: 32 }, (_, index) => ({ name: `$f${index}`, value: index === 12 ? 0x3f800000 : 0, changed: false, detail: 'float 1' })),
  cp0: [{ name: 'Status', value: 0x10000001, changed: false, detail: 'EXL=0 · IE=1' },
    { name: 'Cause', value: 0, changed: false, detail: 'ExcCode=0 · BD=0' }, { name: 'EPC', value: 0, changed: false }],
  memory: Array.from({ length: 32 }, (_, index) => ({ address: 0x10010000 + index * 4, value: index === 0 ? 0x6c6c6548 : index === 1 ? 0x4f43206f : 0, changed: index === 3 })),
  memoryAddress: 0x10010000, memoryRegions: [{ name: '数据段', address: 0x10010000 }, { name: '堆', address: 0x10040000 }, { name: '栈顶', address: 0x7fffef80 }],
  symbols: [{ name: 'main', value: 0x400000, segment: 'text' }, { name: 'loop', value: 0x400014, segment: 'text' }, { name: 'greeting', value: 0x10010000, segment: 'data' }, { name: 'BUFFER_SIZE', value: 256, kind: 'eqv' }],
  breakpoints: [0x400010], console: 'Hello CO!\n欢迎使用 MARS 工作台。\n', inputPrompt: undefined,
  syscalls: marsSyscallCatalog, instructionOffset: 0, instructionCount: 120
};
const fixtureScript = `
const state = ${JSON.stringify(state)};
const params = new URLSearchParams(location.search);
document.body.className = ({dark:'vscode-dark',light:'vscode-light',hc:'vscode-high-contrast','hc-light':'vscode-high-contrast-light'})[params.get('theme')] || 'vscode-dark';
const requests = [];
const fixture = window.__workbenchFixture = {
  state, requests,
  publish() { window.postMessage({type:'state',state}, '*'); },
  setState(patch) { Object.assign(state, patch); this.publish(); }
};
if (params.get('scenario') === 'empty') Object.assign(state, {status:'empty',instructions:[],instructionCount:0,registers:[],floatingPoint:[],cp0:[],memory:[],symbols:[],console:'',pc:undefined,steps:0,message:'点击「汇编」载入程序，然后单步观察或运行到断点。'});
if (params.get('scenario') === 'input') Object.assign(state, {status:'input',inputPrompt:'请输入一个整数',console:state.console+'Enter a number: ',message:'程序正在等待输入，提交后继续执行。'});
if (params.get('scenario') === 'stale') state.sourceChanged = true;
window.acquireVsCodeApi = () => ({ postMessage(request) {
  requests.push(request);
  if (request.type === 'ready') { fixture.publish(); return; }
  if (request.type === 'breakpoint') state.breakpoints = state.breakpoints.includes(request.address) ? state.breakpoints.filter(address => address !== request.address) : [...state.breakpoints,request.address];
  if (request.type === 'run') state.status = 'running';
  if (request.type === 'pause') state.status = 'paused';
  if (request.type === 'stop') state.status = 'stopped';
  if (request.type === 'step') { state.pc += 4; state.steps++; state.registers[8].value++; state.registers[8].changed=true; }
  if (request.type === 'reset') { state.pc=state.instructions[0]?.address; state.steps=0; state.status='paused'; }
  if (request.type === 'mode') {
    state.mode=request.mode; state.modeLabel=request.mode==='mars'?'MARS · Default · 延迟槽关闭':request.mode+' 课程 CPU';
  }
  if (request.type === 'clearConsole') state.console='';
  if (request.type === 'input') { state.console+=request.text;state.status='paused'; }
  if (request.type === 'eof') state.status='exited';
  if (request.type === 'memory') {
    state.memoryAddress=request.address;
    state.memory=Array.from({length:32},(_,index)=>({address:request.address+index*4,value:index}));
  }
  if (request.type === 'listing') {
    const offset=request.address===undefined?request.offset:Math.floor((request.address-0x400000)/4);
    state.instructionOffset=Math.max(0, Math.min(80, offset));
    state.instructions=Array.from({length:40},(_,index)=>({...state.instructions[index],address:0x400000+(state.instructionOffset+index)*4}));
  }
  fixture.publish();
} });
if (params.get('mode')) state.mode=params.get('mode');
`;
const fixtureCss = `
body.vscode-dark { --vscode-editor-background:#1e1e1e; --vscode-editor-foreground:#d4d4d4; --vscode-sideBar-background:#252526; --vscode-descriptionForeground:#a0a5ad; --vscode-panel-border:#383c42; --vscode-list-hoverBackground:#2a2d2e; --vscode-input-background:#2b2d30; --vscode-input-foreground:#d4d4d4; --vscode-input-border:#43474e; --vscode-dropdown-background:#2b2d30; --vscode-dropdown-foreground:#d4d4d4; --vscode-textLink-foreground:#75bfff; --vscode-scrollbarSlider-background:#60646b80; --vscode-editor-stackFrameHighlightBackground:#ffff0033; }
body.vscode-light { --vscode-editor-background:#ffffff; --vscode-editor-foreground:#333333; --vscode-sideBar-background:#f5f5f5; --vscode-descriptionForeground:#666666; --vscode-panel-border:#dedede; --vscode-list-hoverBackground:#eeeeee; --vscode-input-background:#ffffff; --vscode-input-foreground:#333333; --vscode-input-border:#cecece; --vscode-input-placeholderForeground:#767676; --vscode-dropdown-background:#ffffff; --vscode-dropdown-foreground:#333333; --vscode-textLink-foreground:#006ab1; --vscode-symbolIcon-numberForeground:#098658; --vscode-testing-iconPassed:#287e39; --vscode-scrollbarSlider-background:#64646466; --vscode-editor-stackFrameHighlightBackground:#fff3b2; }
body.vscode-high-contrast { --vscode-editor-background:#000000; --vscode-editor-foreground:#ffffff; --vscode-sideBar-background:#000000; --vscode-descriptionForeground:#ffffff; --vscode-panel-border:#ffffff; --vscode-contrastBorder:#ffffff; --vscode-focusBorder:#f38518; --vscode-input-background:#000000; --vscode-input-foreground:#ffffff; --vscode-input-border:#ffffff; --vscode-dropdown-background:#000000; --vscode-dropdown-foreground:#ffffff; --vscode-scrollbarSlider-background:#ffffff99; }
body.vscode-high-contrast-light { --vscode-editor-background:#ffffff; --vscode-editor-foreground:#292929; --vscode-sideBar-background:#ffffff; --vscode-descriptionForeground:#292929; --vscode-panel-border:#292929; --vscode-contrastBorder:#292929; --vscode-focusBorder:#005fb8; --vscode-input-background:#ffffff; --vscode-input-foreground:#292929; --vscode-input-border:#292929; --vscode-dropdown-background:#ffffff; --vscode-dropdown-foreground:#292929; --vscode-scrollbarSlider-background:#29292999; }
`;
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  try {
    if (pathname === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(fixtureScript); return; }
    if (pathname === '/fixture.css') { response.setHeader('Content-Type', 'text/css'); response.end(fixtureCss); return; }
    if (['/media/mars-workbench.js', '/media/mars-workbench.css'].includes(pathname)) {
      response.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript; charset=utf-8');
      response.end(await readFile(path.join(projectRoot, 'out', pathname))); return;
    }
    if (pathname !== '/') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'"><link rel="stylesheet" href="/media/mars-workbench.css"><link rel="stylesheet" href="/fixture.css"><title>MARS workbench preview</title></head><body><div id="app"></div><script src="/fixture.js"></script><script src="/media/mars-workbench.js"></script></body></html>');
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, fixture: '__workbenchFixture', themes: ['dark', 'light', 'hc', 'hc-light'], scenarios: ['empty', 'input', 'stale'] }));
});
