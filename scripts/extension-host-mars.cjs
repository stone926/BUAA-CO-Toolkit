// Optional real-Java command tests. Set CO_MARS_JARS to a JSON array of local JAR paths.
// Only the native input-file picker is supplied by the harness; all commands and tools are real.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');

async function verifyMars({ folder, configure, bounded, waitFor }) {
  const jars = JSON.parse(process.env.CO_MARS_JARS || '[]');
  if (!jars.length) {
    console.log('SKIP optional MARS command tests: CO_MARS_JARS is not set');
    return;
  }
  const root = folder.uri.fsPath;
  const source = vscode.Uri.file(path.join(root, '普通 汇编.asm'));
  const input = vscode.Uri.file(path.join(root, '输入 数据.txt'));
  const output = path.join(root, '.co', 'out', '普通 汇编.mars.out');
  const program = `.macro print_number(%value)
  li $a0, %value
  li $v0, 1
  syscall
.end_macro
.text
  print_number(42)
  li $v0, 10
  syscall
`;
  const showSource = async (text) => {
    await fs.writeFile(source.fsPath, text);
    const document = await vscode.workspace.openTextDocument(source);
    // Existing open documents may not have reloaded after an external write yet.
    const edit = new vscode.WorkspaceEdit();
    edit.replace(source, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await document.save();
    await vscode.window.showTextDocument(document);
    return document;
  };

  for (const jar of jars) {
    await configure(folder, { 'toolchain.mars': jar, 'toolchain.java': process.env.CO_JAVA || 'java',
      'run.timeoutMs': 0, 'run.revealOutput': false });
    for (const profile of ['auto', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']) {
      await configure(folder, { 'project.profile': profile });
      const document = await showSource(program);
      await fs.rm(output, { force: true });
      await bounded(`MARS ${profile} ordinary run`, () => vscode.commands.executeCommand('co.mips.runCurrentFile'));
      assert.equal((await fs.readFile(output, 'utf8')).trim(), '42');
      const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', source);
      assert.ok(folds.some((fold) => fold.start === 0 && fold.end === 4), 'macro folding must remain available');
      assert.equal(document.languageId, 'mipsasm');
    }
    console.log(`PASS real MARS ordinary run, macros, zero-timeout migration, all Profiles: ${jar}`);

    await showSource('.text\nli $v0, 5\nsyscall\nmove $a0, $v0\nli $v0, 1\nsyscall\nli $v0, 10\nsyscall\n');
    await fs.writeFile(input.fsPath, '73\n');
    const originalPicker = vscode.window.showOpenDialog;
    try {
      vscode.window.showOpenDialog = async () => [input];
      await bounded('MARS stdin file command', () => vscode.commands.executeCommand('co.mips.runWithStdinFile'));
    } finally {
      vscode.window.showOpenDialog = originalPicker;
    }
    assert.equal((await fs.readFile(path.join(root, '.co', 'out', '普通 汇编._.mars.out'), 'utf8')).trim(), '73');
    console.log('PASS real MARS stdin-file command');

    await configure(folder, { 'project.profile': 'P2' });
    await showSource(program);
    await bounded('MARS text export command', () => vscode.commands.executeCommand('co.mips.dumpText'));
    const words = (await fs.readFile(path.join(root, 'code.txt'), 'utf8')).trim().split(/\r?\n/);
    assert.deepEqual(words, ['2404002a', '24020001', '0000000c', '2402000a', '0000000c']);
    console.log('PASS real MARS assembly and exact HexText export');

    const originalError = vscode.window.showErrorMessage;
    const errors = [];
    try {
      vscode.window.showErrorMessage = async (message) => { errors.push(message); return undefined; };
      await showSource('.text\nthis_is_not_an_instruction $t0\n');
      await bounded('MARS invalid assembly', () => vscode.commands.executeCommand('co.mips.dumpText'));
      assert.ok(errors.some((message) => message.includes('导出失败')));
      assert.deepEqual((await fs.readFile(path.join(root, 'code.txt'), 'utf8')).trim().split(/\r?\n/), words,
        'Failed assembly must preserve existing machine code');
      errors.length = 0;
      await bounded('MARS invalid run', () => vscode.commands.executeCommand('co.mips.runCurrentFile'));
      assert.ok(errors.some((message) => message.includes('运行失败')));
      errors.length = 0;
      await configure(folder, { 'run.timeoutMs': 1000 });
      await showSource('.text\nloop: j loop\nnop\n');
      await bounded('MARS infinite loop timeout', () => vscode.commands.executeCommand('co.mips.runCurrentFile'));
      assert.ok(errors.some((message) => message.includes('运行失败')));
    } finally {
      vscode.window.showErrorMessage = originalError;
      await configure(folder, { 'run.timeoutMs': 0 });
    }
    console.log('PASS real MARS assembly/run errors, preserved output, and infinite-loop timeout');

    // The terminal command must actually execute Java, not merely create a terminal.
    const marker = path.join(root, 'terminal-result.txt');
    await fs.rm(marker, { force: true });
    await configure(folder, { 'project.profile': 'P7' });
    await showSource(`.data
filename: .asciiz "terminal-result.txt"
payload: .ascii "TERMINAL_OK"
.text
li $v0, 13
la $a0, filename
li $a1, 1
li $a2, 0
syscall
move $s0, $v0
move $a0, $s0
li $v0, 15
la $a1, payload
li $a2, 11
syscall
move $a0, $s0
li $v0, 16
syscall
li $v0, 10
syscall
`);
    const previous = new Set(vscode.window.terminals);
    try {
      await bounded('MARS terminal command', () => vscode.commands.executeCommand('co.mips.runInTerminal'));
      await waitFor('Real terminal Java output', async () => {
        try { return (await fs.readFile(marker, 'utf8')) === 'TERMINAL_OK'; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      });
    } finally {
      for (const terminal of vscode.window.terminals) if (!previous.has(terminal)) terminal.dispose();
    }
    console.log('PASS real MARS P7 terminal execution and file output');

    const standaloneRoot = path.join(path.dirname(root), '独立 ASM 文件');
    await fs.mkdir(standaloneRoot, { recursive: true });
    const standalone = vscode.Uri.file(path.join(standaloneRoot, 'outside.asm'));
    await fs.writeFile(standalone.fsPath, program);
    assert.equal(vscode.workspace.getWorkspaceFolder(standalone), undefined);
    const global = vscode.workspace.getConfiguration('co');
    for (const [key, value] of Object.entries({ 'toolchain.mars': jar,
      'toolchain.java': process.env.CO_JAVA || 'java', 'run.timeoutMs': 0, 'project.profile': 'auto' })) {
      await global.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(standalone));
    await bounded('MARS standalone ASM', () => vscode.commands.executeCommand('co.mips.runCurrentFile'));
    assert.equal((await fs.readFile(path.join(standaloneRoot, '.co', 'out', 'outside.mars.out'), 'utf8')).trim(), '42');
    console.log('PASS real MARS standalone ASM outside workspace');
  }
}

module.exports = { verifyMars };
