// Exercise the packaged extension's internal MIPS assembler/runtime through real VS Code APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');

const includeName = '打印 宏.asm';
const includeText = `.macro print_number(%value)
  li $a0, %value
  li $v0, 1
  syscall
.end_macro
`;
const ordinaryProgram = `.include "${includeName}"
.text
  print_number(42)
  li $v0, 10
  syscall
`;

async function showSource(file, text) {
  // Once opened, the editor is the only writer. Writing the same file through fs
  // races its asynchronous reload against WorkspaceEdit's document version.
  let document = vscode.workspace.textDocuments.find(item => !item.isClosed && item.uri.toString() === file.toString());
  if (!document) {
    await fs.writeFile(file.fsPath, text);
    document = await vscode.workspace.openTextDocument(file);
  }
  const editor = await vscode.window.showTextDocument(document);
  if (document.getText() !== text) {
    assert.equal(await editor.edit(edit => {
      edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    }), true);
  }
  assert.equal(await document.save(), true);
  assert.equal(document.getText(), text);
  return document;
}

async function verifyMars({ folder, configure, bounded, waitFor }) {
  const root = folder.uri.fsPath;
  const source = vscode.Uri.file(path.join(root, '普通 汇编.asm'));
  const input = vscode.Uri.file(path.join(root, '输入 数据.txt'));
  const outputDir = path.join(root, '.co', 'out');
  const output = path.join(outputDir, '普通 汇编.mars.out');
  await fs.writeFile(path.join(root, includeName), includeText);

  // These invalid paths prove successful MIPS commands never try to launch Java or an external JAR.
  await configure(folder, {
    'toolchain.java': path.join(root, '不存在 Java 工具.exe'),
    'toolchain.mars': path.join(root, '不存在 MARS.jar'),
    'toolchain.marsP7': path.join(root, '不存在 P7 MARS.jar'),
    'mips.extraArgs': ['--must-not-be-used'],
    'run.timeoutMs': 120000,
    'run.revealOutput': false
  });

  for (const profile of ['auto', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']) {
    await configure(folder, { 'project.profile': profile });
    const document = await showSource(source, ordinaryProgram);
    await fs.rm(output, { force: true });
    await bounded(`Internal MIPS ${profile} run`, () => vscode.commands.executeCommand('co.mips.runCurrentFile'));
    assert.equal((await fs.readFile(output, 'utf8')).trim(), '42', `${profile} must run without Java/MARS`);
    const includeUri = vscode.Uri.file(path.join(root, includeName));
    await vscode.workspace.openTextDocument(includeUri);
    const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', includeUri);
    assert.ok(folds.some((fold) => fold.start === 0 && fold.end === 4), 'MIPS macro folding remains available');
    assert.equal(document.languageId, 'mipsasm');
  }
  console.log('PASS internal MIPS console execution for auto and P0-P7 with unavailable Java/MARS, Unicode include, and macro');

  await showSource(source, '.text\nli $v0, 5\nsyscall\nmove $a0, $v0\nli $v0, 1\nsyscall\nli $v0, 10\nsyscall\n');
  await fs.writeFile(input.fsPath, '73\n');
  const originalPicker = vscode.window.showOpenDialog;
  try {
    vscode.window.showOpenDialog = async () => [input];
    await bounded('Internal MIPS stdin file command', () => vscode.commands.executeCommand('co.mips.runWithStdinFile'));
  } finally {
    vscode.window.showOpenDialog = originalPicker;
  }
  const stdinOutput = path.join(outputDir, '普通 汇编._.mars.out');
  assert.equal((await fs.readFile(stdinOutput, 'utf8')).trim(), '73');
  console.log('PASS internal MIPS syscall input from a selected UTF-8 file');

  await configure(folder, { 'project.profile': 'P2', 'project.machineCode': 'code.txt' });
  await showSource(source, ordinaryProgram);
  await bounded('P2 internal MIPS text export command', () => vscode.commands.executeCommand('co.mips.dumpText'));
  const machineCodePath = path.join(root, 'code.txt');
  const words = (await fs.readFile(machineCodePath, 'utf8')).trim().split(/\r?\n/);
  assert.deepEqual(words, ['2404002a', '24020001', '0000000c', '2402000a', '0000000c']);
  console.log('PASS P2 internal ASM export and exact syscall program words');

  const originalError = vscode.window.showErrorMessage;
  const errors = [];
  try {
    vscode.window.showErrorMessage = async (message) => { errors.push(message); return undefined; };
    await showSource(source, '.text\nthis_is_not_an_instruction $t0\n');
    await bounded('Invalid internal P2 ASM export', () => vscode.commands.executeCommand('co.mips.dumpText'));
    assert.ok(errors.some((message) => message.includes('导出失败')));
    assert.deepEqual((await fs.readFile(machineCodePath, 'utf8')).trim().split(/\r?\n/), words,
      'A failed export must preserve the previous machine-code artifact');

    errors.length = 0;
    await bounded('Invalid internal MIPS run', () => vscode.commands.executeCommand('co.mips.runCurrentFile'));
    assert.ok(errors.some((message) => message.includes('运行失败')));

    errors.length = 0;
    await configure(folder, { 'run.timeoutMs': 1000 });
    await showSource(source, '.text\nloop: j loop\nnop\n');
    await bounded('Internal MIPS infinite-loop timeout command', () => vscode.commands.executeCommand('co.mips.runCurrentFile'));
    assert.ok(errors.some((message) => message.includes('运行失败')),
      'The bounded internal runtime must report a timeout');
  } finally {
    vscode.window.showErrorMessage = originalError;
    await configure(folder, { 'run.timeoutMs': 120000 });
  }
  console.log('PASS internal MIPS diagnostics, atomic export preservation, and timeout');

  const terminalResult = path.join(root, 'terminal 数据.txt');
  await fs.rm(terminalResult, { force: true });
  await configure(folder, { 'project.profile': 'P2', 'run.timeoutMs': 120000 });
  const terminalProgram = `.data
filename: .asciiz "terminal 数据.txt"
payload: .ascii "TERMINAL_OK"
.align 2
input_value: .word 0
readback: .space 16
.text
  li $v0, 5
  syscall
  sw $v0, input_value
  li $v0, 13
  la $a0, filename
  li $a1, 1
  li $a2, 0
  syscall
  move $s0, $v0
  move $a0, $s0
  la $a1, payload
  li $a2, 11
  li $v0, 15
  syscall
  move $a0, $s0
  la $a1, input_value
  li $a2, 4
  li $v0, 15
  syscall
  move $a0, $s0
  li $v0, 16
  syscall
  li $v0, 13
  la $a0, filename
  li $a1, 0
  li $a2, 0
  syscall
  move $s0, $v0
  move $a0, $s0
  la $a1, readback
  li $a2, 15
  li $v0, 14
  syscall
  move $t0, $v0
  bne $t0, 15, failed
  nop
  li $v0, 4
  la $a0, readback
  syscall
  move $a0, $s0
  li $v0, 16
  syscall
  li $v0, 10
  syscall
failed:
  li $v0, 10
  syscall
`;
  await showSource(source, terminalProgram);
  const previousTerminals = new Set(vscode.window.terminals);
  try {
    await bounded('Internal MIPS PTY terminal command', () => vscode.commands.executeCommand('co.mips.runInTerminal'));
    const terminal = await waitFor('Internal MIPS PTY terminal', async () =>
      vscode.window.terminals.find((item) => !previousTerminals.has(item) && item.name.startsWith('MARS:')));
    await new Promise((resolve) => setTimeout(resolve, 250));
    terminal.sendText('73');
    const written = await waitFor('Interactive MIPS syscall file I/O', async () => {
      try {
        const bytes = await fs.readFile(terminalResult);
        return bytes.length === 15 ? bytes : undefined;
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
    });
    assert.deepEqual(written, Buffer.concat([Buffer.from('TERMINAL_OK'), Buffer.from([73, 0, 0, 0])]));
  } finally {
    for (const terminal of vscode.window.terminals) {
      if (!previousTerminals.has(terminal)) terminal.dispose();
    }
  }
  console.log('PASS internal MIPS VS Code pseudoterminal, sendText stdin, and syscall 13-16 file write/read');

  const standaloneRoot = path.join(path.dirname(root), '独立 ASM 文件');
  await fs.mkdir(standaloneRoot, { recursive: true });
  const standalone = vscode.Uri.file(path.join(standaloneRoot, 'outside.asm'));
  await fs.writeFile(path.join(standaloneRoot, includeName), includeText);
  const standaloneDocument = await showSource(standalone, ordinaryProgram);
  assert.equal(vscode.workspace.getWorkspaceFolder(standalone), undefined);
  await configure(folder, { 'project.profile': 'P7' });
  await bounded('Standalone internal MIPS ASM outside the workspace', () =>
    vscode.commands.executeCommand('co.mips.runCurrentFile'));
  assert.equal((await fs.readFile(path.join(standaloneRoot, '.co', 'out', 'outside.mars.out'), 'utf8')).trim(), '42');
  assert.equal(standaloneDocument.languageId, 'mipsasm');
  console.log('PASS internal MIPS ASM include and execution outside the workspace');
}

module.exports = { verifyMars };
