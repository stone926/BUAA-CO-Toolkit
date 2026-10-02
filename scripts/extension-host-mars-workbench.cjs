// Exercise the production VS Code panel/controller/Worker boundary, including interactive IO.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');

async function verifyMarsWorkbench({ folder, configure, bounded, waitFor }) {
  await configure(folder, { 'project.profile': 'P2', 'mips.delayedBranching': 'off' });
  const uri = vscode.Uri.file(path.join(folder.uri.fsPath, '调试 程序.asm'));
  await fs.writeFile(uri.fsPath, '\ufeff.data\nvalue: .word 0\n.text\nli $v0, 5\nsyscall\nsw $v0, value\nmove $a0, $v0\nli $v0, 1\nsyscall\nli $v0, 10\nsyscall\n');
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const createPanel = vscode.window.createWebviewPanel;
  let panel, receive, state, browserReady = false;
  vscode.window.createWebviewPanel = function (...args) {
    const created = createPanel.apply(this, args);
    if (args[0] !== 'co.mars.workbench') return created;
    panel = created;
    const originalPost = created.webview.postMessage.bind(created.webview);
    created.webview.postMessage = message => {
      if (message?.type === 'state') state = message.state;
      return originalPost(message);
    };
    const originalReceive = created.webview.onDidReceiveMessage.bind(created.webview);
    created.webview.onDidReceiveMessage = (callback, ...rest) => {
      receive = callback;
      return originalReceive(message => {
        if (message?.type === 'ready') browserReady = true;
        callback(message);
      }, ...rest);
    };
    return created;
  };
  const send = message => { assert.ok(receive); receive(message); };
  try {
    await bounded('Open MARS workbench', () => vscode.commands.executeCommand('co.mips.openWorkbench', uri));
    assert.ok(panel.webview.html.includes('mars-workbench.js'));
    assert.ok(panel.webview.html.includes("default-src 'none'"));
    await waitFor('Production webview browser handshake', () => browserReady);
    await waitFor('Workbench initial handshake', () => state?.status === 'empty');
    assert.equal(state.mode, 'mars');
    assert.ok(state.syscalls.some(item => item.code === 5 && item.supported));
    send({ type: 'assemble' });
    await waitFor('Workbench assembled at entry', () => state?.status === 'paused' && state.steps === 0);
    assert.equal(state.sourceChanged, false, 'UTF-8 BOM must not make a fresh image stale');
    assert.equal(state.pc, 0x400000);
    assert.ok(state.instructions.some(row => row.source?.text.includes('li $v0')));
    send({ type: 'step' });
    await waitFor('Workbench step', () => state.steps === 1 && state.status === 'paused');
    assert.equal(state.registers.find(item => item.name === '$v0').value, 5);
    send({ type: 'step' });
    await waitFor('Workbench input suspension', () => state.status === 'input');
    send({ type: 'input', text: '41' });
    await waitFor('Workbench syscall single step', () => state.status === 'paused' && state.steps === 2);
    assert.equal(state.registers.find(item => item.name === '$v0').value, 41);
    const printPc = state.instructions.filter(row => row.instruction === 'syscall')[1].address;
    send({ type: 'breakpoint', address: printPc });
    await waitFor('Workbench breakpoint configured', () => state.breakpoints.includes(printPc));
    send({ type: 'run' });
    await waitFor('Workbench breakpoint hit', () => state.status === 'paused' && state.pc === printPc);
    assert.equal(state.memory[0].value, 41);
    send({ type: 'run' });
    await waitFor('Workbench service exit', () => state.status === 'exited');
    assert.equal(state.console, '41\n41');
    send({ type: 'memory', address: 0x10010004 });
    await waitFor('Workbench memory after exit', () => state.memoryAddress === 0x10010004);
    assert.equal(state.status, 'exited');

    const originalPicker = vscode.window.showQuickPick;
    const originalSave = vscode.window.showSaveDialog;
    const exportFile = vscode.Uri.file(path.join(folder.uri.fsPath, '调试 导出.hex'));
    try {
      vscode.window.showQuickPick = async items => items.find(item => item.label === 'text');
      vscode.window.showSaveDialog = async () => exportFile;
      send({ type: 'export' });
      await waitFor('Workbench export', async () => {
        try { return (await fs.readFile(exportFile.fsPath, 'utf8')).startsWith('24020005\n0000000c\n'); } catch { return false; }
      });
    } finally { vscode.window.showQuickPick = originalPicker; vscode.window.showSaveDialog = originalSave; }

    send({ type: 'reset' });
    await waitFor('Workbench reset', () => state.status === 'paused' && state.steps === 0);
    send({ type: 'run' });
    await waitFor('Workbench reset input', () => state.status === 'input');
    send({ type: 'stop' });
    await waitFor('Workbench stop during input', () => state.status === 'stopped');
    send({ type: 'reset' });
    await waitFor('Workbench restart after cancellation', () => state.status === 'paused' && state.steps === 0);

    const includeUri = vscode.Uri.file(path.join(folder.uri.fsPath, '调试 常量.inc'));
    await fs.writeFile(includeUri.fsPath, '.eqv RESULT 7\n');
    const includeDocument = await vscode.workspace.openTextDocument(includeUri);
    const rootEdit = new vscode.WorkspaceEdit();
    rootEdit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      '.include "调试 常量.inc"\n.text\nli $t0, RESULT\nli $v0, 10\nsyscall\n');
    assert.equal(await vscode.workspace.applyEdit(rootEdit), true);
    await waitFor('Workbench dirty root detected', () => state.sourceChanged);
    send({ type: 'assemble' });
    await waitFor('Workbench dirty root reassembled', () => state.status === 'paused' && state.instructions[0]?.source?.text.includes('RESULT'));
    assert.equal(state.sourceChanged, false, 'Assemble must accept its own freshly saved source');
    const includeEdit = new vscode.WorkspaceEdit();
    includeEdit.replace(includeUri, new vscode.Range(0, 0, includeDocument.lineCount, 0), '.eqv RESULT 9\n');
    assert.equal(await vscode.workspace.applyEdit(includeEdit), true);
    await waitFor('Workbench dirty include detected', () => state.sourceChanged);
    send({ type: 'assemble' });
    await waitFor('Workbench dirty include reassembled', () => state.status === 'paused' && state.instructions[0]?.word === 0x24080009);
    assert.equal(state.sourceChanged, false, 'A saved include must match the new image');
    await fs.writeFile(includeUri.fsPath, '.eqv RESULT 11\n');
    await waitFor('Workbench external .inc edit detected', () => state.sourceChanged);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      '.text\nori $v0, $zero, 1\nsyscall\nloop: beq $zero, $zero, loop\nnop\n.ktext 0x4180\nmfc0 $k0, $14\naddi $k0, $k0, 4\nmtc0 $k0, $14\neret\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitFor('Workbench stale-source notice', () => state.sourceChanged);
    send({ type: 'mode', mode: 'P7' });
    await waitFor('Workbench course mode', () => state.mode === 'P7' && state.status === 'empty');
    send({ type: 'assemble' });
    await waitFor('Workbench course assembled', () => state.status === 'paused' && state.pc === 0x3000);
    send({ type: 'step' });
    await waitFor('Workbench P7 first step', () => state.steps === 1);
    send({ type: 'step' });
    await waitFor('Workbench P7 syscall trap', () => state.steps === 2 && state.pc === 0x4180);
    assert.equal(state.cp0.find(item => item.name === 'Cause').value & 0x7c, 8 << 2);
    assert.equal(state.cp0.find(item => item.name === 'EPC').value, 0x3004);
    assert.equal(state.registers.find(item => item.name === '$v0').value, 1);
    assert.equal(state.console, '');
    const invalid = new vscode.WorkspaceEdit();
    invalid.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), '.text\ninvalid_workbench_instruction $t0\n');
    assert.equal(await vscode.workspace.applyEdit(invalid), true);
    send({ type: 'assemble' });
    await waitFor('Workbench invalid assembly', () => state.status === 'error');
    assert.equal(state.instructionCount, 0);
    assert.ok(vscode.languages.getDiagnostics(uri).some(item => item.source === '内置 MARS'));
    console.log('PASS MARS workbench: real panel/Worker assembly, step, input, breakpoints, exit inspection, export, reset/cancel, stale sources and P7 trap');
  } finally {
    panel?.dispose();
    vscode.window.createWebviewPanel = createPanel;
    await configure(folder, { 'mips.delayedBranching': 'auto' });
  }
}

module.exports = { verifyMarsWorkbench };
