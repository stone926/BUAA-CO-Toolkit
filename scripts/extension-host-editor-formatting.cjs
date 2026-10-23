// @index editor-formatting-smoke — 真实编辑器格式化命令、撤销、保存与源码保真
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');

async function runEditorFormattingSmoke({ root, waitFor }) {
  const directory = path.join(root, '编辑器 formatting');
  await fs.mkdir(directory, { recursive: true });
  const settings = vscode.workspace.getConfiguration('editor', vscode.Uri.file(directory));
  const overrides = { defaultFormatter: 'stone926.buaa-co-toolkit', detectIndentation: false,
    insertSpaces: true, tabSize: 2, formatOnSave: false, formatOnSaveMode: 'file' };
  const previous = new Map(Object.keys(overrides).map(key => [key, settings.inspect(key)?.workspaceFolderValue]));
  const fixtures = [];
  const failures = [];
  async function check(name, test) {
    try { await test(); console.log(`PASS editor formatting: ${name}`); }
    catch (error) { failures.push(error); console.error(`FAIL editor formatting: ${name}`, error); }
  }
  async function open(name, source) {
    const uri = vscode.Uri.file(path.join(directory, name));
    await fs.writeFile(uri.fsPath, source);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    editor.options = { insertSpaces: true, tabSize: 2 };
    // Editor actions require editor focus; a visible tab alone is insufficient
    // after other smoke checks have opened views or removed their active file.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await waitFor('Formatting fixture active editor', () => vscode.window.activeTextEditor?.document === document);
    fixtures.push(document);
    return { document, editor };
  }
  async function replace(document, text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  const provider = async (document, options = { insertSpaces: true, tabSize: 2 }) =>
    (await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, options)) ?? [];
  try {
    for (const [key, value] of Object.entries(overrides)) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    await check('Verilog document command, CRLF, undo and redo', async () => {
      const source = 'module editor_format;\r\nreg[7:0] x;\r\ninitial begin\r\nx=1;\r\nend\r\nendmodule\r\n';
      const expected = 'module editor_format;\r\n  reg [7:0] x;\r\n  initial begin\r\n    x = 1;\r\n  end\r\nendmodule\r\n';
      const { document } = await open('全文 command.v', source);
      await waitFor('Verilog formatter registration', async () => (await provider(document)).length);
      await vscode.commands.executeCommand('editor.action.formatDocument');
      assert.equal(document.getText(), expected);
      assert.equal(document.eol, vscode.EndOfLine.CRLF);
      assert.deepEqual(await provider(document), []);
      await vscode.commands.executeCommand('undo');
      assert.equal(document.getText(), source);
      await vscode.commands.executeCommand('redo');
      assert.equal(document.getText(), expected);
    });
    await check('Verilog selection command preserves surrounding lines', async () => {
      const source = 'module selection_format;\nreg[7:0] x;\ninitial begin\nx=1;\nend\nendmodule\n';
      const { document, editor } = await open('选区 command.v', source);
      editor.selection = new vscode.Selection(3, 0, 4, 0);
      await vscode.commands.executeCommand('editor.action.formatSelection');
      assert.equal(document.getText(), source.replace('x=1;', '    x = 1;'));
    });
    await check('Verilog format on save writes the formatted buffer to disk', async () => {
      const source = 'module save_format;\nwire[7:0] x=1;\nendmodule\n';
      const { document } = await open('保存 command.v', source);
      await settings.update('formatOnSave', true, vscode.ConfigurationTarget.WorkspaceFolder);
      try {
        await replace(document, source.replace('x=1', 'x=2'));
        assert.equal(await document.save(), true);
        const expected = 'module save_format;\n  wire [7:0] x = 2;\nendmodule\n';
        assert.equal(document.getText(), expected);
        assert.equal(await fs.readFile(document.uri.fsPath, 'utf8'), expected);
        assert.deepEqual(await provider(document), []);
      } finally { await settings.update('formatOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder); }
    });
    await check('MIPS character and string literals keep their contents', async () => {
      const { document } = await open('字面量.asm', '.data\ncomma:.byte \',\'\nmsg:.asciiz "a,b # c"\n');
      assert.equal(document.languageId, 'mipsasm');
      await waitFor('MIPS formatter registration', async () => (await provider(document)).length);
      await vscode.commands.executeCommand('editor.action.formatDocument');
      assert.equal(document.getText(), '.data\ncomma: .byte \',\'\nmsg: .asciiz "a,b # c"\n');
      assert.deepEqual(await provider(document), []);
    });
    await check('MIPS incomplete source is never deleted', async () => {
      const source = '.text\nmain: ???\n%op $t0\n$name.sub:\n';
      const { document } = await open('编辑中.asm', source);
      await vscode.commands.executeCommand('editor.action.formatDocument');
      assert.equal(document.getText(), source);
    });
    await check('MIPS document command honors editor spaces and tabs', async () => {
      const { document, editor } = await open('缩进.asm', '.text\nadd $t0,$t1,$t2\n');
      await vscode.commands.executeCommand('editor.action.formatDocument');
      assert.equal(document.getText(), '.text\n  add $t0, $t1, $t2\n');
      editor.options = { insertSpaces: false, tabSize: 4 };
      await vscode.commands.executeCommand('editor.action.formatDocument');
      assert.equal(document.getText(), '.text\n\tadd $t0, $t1, $t2\n');
      assert.deepEqual(await provider(document, { insertSpaces: false, tabSize: 4 }), []);
    });
    await check('MIPS format on save preserves character literals on disk', async () => {
      const { document } = await open('保存 command.asm', '.data\nchars:.byte 0\n.text\nnop\n');
      await settings.update('formatOnSave', true, vscode.ConfigurationTarget.WorkspaceFolder);
      try {
        await replace(document, '.data\nchars:.byte \',\',\'(\',\'#\'\n.text\nnop\n');
        assert.equal(await document.save(), true);
        const expected = '.data\nchars: .byte \',\', \'(\', \'#\'\n.text\n  nop\n';
        assert.equal(document.getText(), expected);
        assert.equal(await fs.readFile(document.uri.fsPath, 'utf8'), expected);
        assert.deepEqual(await provider(document), []);
      } finally { await settings.update('formatOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder); }
    });
    await check('SystemVerilog is excluded from the Verilog formatter', async () => {
      const source = 'interface bus;\nlogic[7:0] a;\nendinterface\n';
      const { document } = await open('边界.sv', source);
      assert.equal(document.languageId, 'systemverilog');
      assert.deepEqual(await provider(document), []);
      assert.equal(document.getText(), source);
    });
  } finally {
    for (const [key, value] of previous) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    for (const document of fixtures) {
      await document.save();
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(document.uri);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} editor formatting checks failed`);
}

module.exports = { runEditorFormattingSmoke };
