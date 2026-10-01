// Builtin ASM export through real VS Code commands and the packaged Worker.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');

const userWords = ['3408002a', '3c091234', '3529abcd', 'ac080000'];
const haltWords = ['1000ffff', '00000000'];
const handlerWords = ['401a7000', '42000018'];
const handlerIndex = (0x4180 - 0x3000) / 4;
const macroSource = `.macro emit_value(%value)
  ori $8, $0, %value
.end_macro
`;
const userSource = `.include "导出 宏.inc"
.text
  emit_value(42)
  lui $9, 0x1234
  ori $9, $9, 0xabcd
  sw $8, 0($0)
`;
const kernelSource = `.ktext 0x4180
handler:
  mfc0 $26, $14
  eret
`;

function expectedUserWords(profile) {
  if (profile === 'P3') return userWords;
  if (profile !== 'P7') return [...userWords, ...haltWords];
  return [...userWords, ...haltWords,
    ...Array(handlerIndex - userWords.length - haltWords.length).fill('00000000'),
    ...handlerWords];
}

async function readHexText(file) {
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /^(?:[0-9a-f]{8}\n)+$/, 'Export must contain one exact 32-bit hexadecimal word per line');
  return { text, words: text.trimEnd().split('\n') };
}

async function verifyBuiltinAsm({ folder, configure, bounded, replaceAndSave }) {
  const root = folder.uri.fsPath;
  const source = vscode.Uri.file(path.join(root, '课程 ASM 导出.asm'));
  const outputName = 'ASM 导出结果.txt';
  const outputPath = path.join(root, outputName);
  const kernelPath = path.join(root, '课程 ASM 导出.kernel.txt');
  await fs.writeFile(path.join(root, '导出 宏.inc'), macroSource);
  await fs.writeFile(source.fsPath, userSource);
  const document = await vscode.workspace.openTextDocument(source);
  assert.equal(document.languageId, 'mipsasm');

  const configuration = vscode.workspace.getConfiguration('co', folder.uri);
  const previous = Object.fromEntries(['toolchain.java', 'toolchain.mars', 'project.machineCode']
    .map((key) => [key, configuration.inspect(key)?.workspaceFolderValue]));
  const originalError = vscode.window.showErrorMessage;
  const originalInformation = vscode.window.showInformationMessage;
  const errors = [];
  const notices = [];
  try {
    // Successful P3-P7 exports must be independent of any external Java/MARS.
    await configure(folder, {
      'toolchain.java': path.join(root, '不存在 Java 工具.exe'),
      'toolchain.mars': path.join(root, '不存在 MARS.jar'),
      'project.machineCode': outputName
    });
    vscode.window.showErrorMessage = async (message) => { errors.push(message); return undefined; };
    vscode.window.showInformationMessage = async (message) => { notices.push(message); return undefined; };
    for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7']) {
      await configure(folder, { 'project.profile': profile });
      await replaceAndSave(document, userSource + (profile === 'P7' ? kernelSource : ''));
      await vscode.window.showTextDocument(document);
      await fs.rm(outputPath, { force: true });
      notices.length = 0;
      await bounded(`${profile} builtin text export command`, () => vscode.commands.executeCommand('co.mips.dumpText'));
      assert.deepEqual(errors, [], `${profile} export must succeed with unavailable external tools`);
      assert.ok(notices.some((message) => message.includes('内置汇编器 已导出')), 'Export must name the builtin assembler');
      const exported = await readHexText(outputPath);
      assert.deepEqual(exported.words, expectedUserWords(profile), `${profile} exported machine code and halt policy`);
      assert.ok(exported.words.length <= 4096, 'Course IM must fit 16 KiB');
      assert.equal(Buffer.byteLength(exported.text), exported.words.length * 9);
    }
    console.log('PASS builtin P3-P7 real command exports: Unicode include/macro, exact instructions, halt policy, and P7 handler projection');

    await fs.rm(kernelPath, { force: true });
    await bounded('P7 builtin kernel export command', () => vscode.commands.executeCommand('co.mips.dumpKernelText'));
    assert.deepEqual(errors, []);
    const kernel = await readHexText(kernelPath);
    assert.deepEqual(kernel.words, handlerWords, 'Separate kernel dump starts at its handler with no user-text padding');
    const exported = await readHexText(outputPath);
    assert.deepEqual(exported.words.slice(handlerIndex), kernel.words,
      'Kernel file must equal user IM words beginning at address 0x4180');
    console.log('PASS builtin P7 kernel export filename, exact CP0/eret words, and absolute user-image address');

    await replaceAndSave(document, (userSource + kernelSource)
      .replace('emit_value(42)', 'this_is_not_an_instruction $8'));
    await vscode.window.showTextDocument(document);
    for (const command of ['co.mips.dumpText', 'co.mips.dumpKernelText']) {
      errors.length = 0;
      await bounded(`Invalid builtin ${command} command`, () => vscode.commands.executeCommand(command));
      assert.ok(errors.some((message) => message.includes('导出失败')), 'Invalid source must report export failure');
      assert.equal(await fs.readFile(outputPath, 'utf8'), exported.text, 'Failed export must preserve existing user IM');
      assert.equal(await fs.readFile(kernelPath, 'utf8'), kernel.text, 'Failed export must preserve existing kernel output');
    }
    errors.length = 0;
    await replaceAndSave(document, userSource + kernelSource);
    await vscode.window.showTextDocument(document);
    await bounded('Repaired builtin ASM text export', () => vscode.commands.executeCommand('co.mips.dumpText'));
    await bounded('Repaired builtin ASM kernel export', () => vscode.commands.executeCommand('co.mips.dumpKernelText'));
    assert.deepEqual(errors, []);
    assert.equal(await fs.readFile(outputPath, 'utf8'), exported.text);
    assert.equal(await fs.readFile(kernelPath, 'utf8'), kernel.text);
    console.log('PASS builtin invalid ASM export: visible failures, preserved user/kernel artifacts, and repaired exports');
  } finally {
    vscode.window.showErrorMessage = originalError;
    vscode.window.showInformationMessage = originalInformation;
    await configure(folder, previous);
  }
}

module.exports = { verifyBuiltinAsm };
