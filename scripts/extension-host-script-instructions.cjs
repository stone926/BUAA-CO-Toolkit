// Real extension-host proof: no installed Node/tsc/Java is used for JS/TS instructions.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');

async function verifyScriptInstructions({ folder, configure, bounded, waitFor }) {
  const root = folder.uri.fsPath;
  const directory = path.join(root, '.co', 'custom-instructions');
  await fs.mkdir(directory, { recursive: true });
  const created = [];
  try {
    for (const extension of ['js', 'ts']) {
      const file = path.join(directory, `xinc.${extension}`);
      const pick = vscode.window.showQuickPick, input = vscode.window.showInputBox;
      try {
        vscode.window.showQuickPick = async items => (await items).find(item => item.extension === extension);
        vscode.window.showInputBox = async () => 'xinc';
        await bounded('Create custom instruction SDK and example', () => vscode.commands.executeCommand('co.mips.createCustomInstruction'));
      } finally { vscode.window.showQuickPick = pick; vscode.window.showInputBox = input; }
      created.push(file);
      assert.match(await fs.readFile(file, 'utf8'), /bits\.addSigned32/);
      assert.match(await fs.readFile(path.join(directory, 'co-instructions.d.ts'), 'utf8'), /declare module '@buaa-co\/instructions'/);
      // First execute the actual generated template, including the namespaced SDK export.
      await configure(folder, { 'project.profile': 'P2', 'project.machineCode': 'code.txt' });
      const source = vscode.Uri.file(path.join(root, `自定义-${extension}.asm`));
      await fs.writeFile(source.fsPath, '.text\nxinc $a0,$zero,65535\nli $v0,1\nsyscall\nli $v0,10\nsyscall\n');
      const document = await vscode.workspace.openTextDocument(source);
      await vscode.window.showTextDocument(document);
      await bounded(`Generated ${extension} instruction console`, () => vscode.commands.executeCommand('co.mips.runCurrentFile'));
      const output = path.join(root, '.co', 'out', `自定义-${extension}.mars.out`);
      assert.equal((await fs.readFile(output, 'utf8')).trim(), '-1');
      if (extension === 'ts') {
        // Require actual type erasure, not merely accepting JavaScript with a .ts suffix.
        const definition = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const edit = new vscode.WorkspaceEdit();
        edit.insert(definition.uri, new vscode.Position(0, 0), 'interface NativeStripProof { readonly value: number }\n');
        assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(await definition.save(), true);
      }
      await waitFor('Custom instruction LSP completion', async () => {
        const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', source, new vscode.Position(1, 2));
        return completion?.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'xinc');
      });
      assert.ok(!vscode.languages.getDiagnostics(source).some(item => item.code === 'unknown-instruction'));
      await bounded(`Custom ${extension} ordinary export`, () => vscode.commands.executeCommand('co.mips.dumpText'));
      assert.equal((await fs.readFile(path.join(root, 'code.txt'), 'utf8')).trim().split(/\r?\n/)[0], 'cc04ffff');
      await configure(folder, { 'project.profile': 'P5' });
      const course = vscode.Uri.file(path.join(root, `自定义课程-${extension}.asm`));
      await fs.writeFile(course.fsPath, '.text\nxinc $1,$0,65535\nsw $1,0($0)\nhalt: beq $0,$0,halt\nnop\n');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(course));
      await bounded(`Custom ${extension} P5 export`, () => vscode.commands.executeCommand('co.mips.dumpText'));
      assert.equal((await fs.readFile(path.join(root, 'code.txt'), 'utf8')).trim().split(/\r?\n/)[0], 'cc01ffff');
      await fs.unlink(file);
    }
    console.log(`PASS JS/TS custom instruction creation, native stripping, LSP, ordinary execution and P5 export (host Node ${process.versions.node})`);
  } finally {
    for (const file of created) await fs.rm(file, { force: true });
    for (const file of ['co-instructions.d.ts', 'tsconfig.json']) await fs.rm(path.join(directory, file), { force: true });
  }
}
module.exports = { verifyScriptInstructions };
