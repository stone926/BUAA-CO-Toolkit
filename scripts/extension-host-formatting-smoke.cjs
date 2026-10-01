// @index formatting-smoke — 真实宿主全文/选区格式化、配置刷新与保护区回归
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');

async function runFormattingSmoke({ root, waitFor }) {
  const directory = path.join(root, '格式化 fixture');
  await fs.mkdir(directory, { recursive: true });
  const uri = vscode.Uri.file(path.join(directory, '选区 smoke.v'));
  const source = 'module formatting_smoke;\nreg[7:0] value;\ninitial begin\nvalue=1;\nend\nendmodule\n';
  await fs.writeFile(uri.fsPath, source);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const configuration = vscode.workspace.getConfiguration('co', uri);
  const previous = configuration.inspect('verilog.format.spaceInRange')?.workspaceFolderValue;
  const spaces = { tabSize: 2, insertSpaces: true };
  const tabs = { tabSize: 4, insertSpaces: false };
  // VS Code 的命令聚合层可将空编辑返回为 undefined；首次非空请求单独验证注册成功。
  const full = async (options = spaces) => (await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', uri, options)) ?? [];
  const range = async (selection, options = spaces) => (await vscode.commands.executeCommand('vscode.executeFormatRangeProvider', uri, selection, options)) ?? [];
  async function apply(edits) {
    assert.ok(Array.isArray(edits), 'The real provider must return edits');
    const edit = new vscode.WorkspaceEdit();
    edit.set(uri, edits);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  async function replace(text) {
    await apply([vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text)]);
  }
  try {
    assert.equal(document.languageId, 'verilog');
    const initial = await waitFor('Full formatting dynamic registration', async () => {
      const edits = await full();
      return edits?.length ? edits : undefined;
    });
    await apply(initial);
    assert.match(document.getText(), /^  initial begin\r?\n    value = 1;/m);
    assert.deepEqual(await full(), [], 'A second full request must be a no-op');

    await replace(source);
    await apply(await full(tabs));
    assert.match(document.getText(), /^\tinitial begin\r?\n\t\tvalue = 1;/m);
    assert.deepEqual(await full(tabs), [], 'Tab formatting must be stable');

    // 末端 character=0 不包含末行，选区外文本必须完全不变。
    await replace(source);
    const selection = new vscode.Range(3, 0, 4, 0);
    const selected = await waitFor('Range formatting dynamic registration', async () => {
      const edits = await range(selection);
      return edits?.length ? edits : undefined;
    });
    await apply(selected);
    assert.equal(document.getText(), source.replace('value=1;', '    value = 1;'));
    assert.deepEqual(await range(selection), [], 'A second range request must be a no-op');

    // 前一行末尾空格不属于选区，不能因此跳过所选首行的缩进。
    const boundarySource = 'module formatting_smoke;   \nwire value;\nendmodule\n';
    await replace(boundarySource);
    const boundarySelection = new vscode.Range(1, 0, 2, 0);
    await apply(await range(boundarySelection));
    assert.equal(document.getText(), boundarySource.replace('wire value;', '  wire value;'));
    assert.deepEqual(await range(boundarySelection), []);

    // 等待配置真正影响输出，不用固定延时冒充配置已传播。
    for (const [enabled, expected] of [[true, /\[7: 0\]/], [false, /\[7:0\]/]]) {
      await configuration.update('verilog.format.spaceInRange', enabled, vscode.ConfigurationTarget.WorkspaceFolder);
      await replace(source);
      await waitFor(`Legacy range spacing setting ${enabled}`, async () => {
        await apply(await full());
        return expected.test(document.getText());
      });
      assert.deepEqual(await full(), [], 'Legacy setting output must be stable');
    }

    const protectedPart = '// co-format: off\n  initial begin\nvalue=  2;  \n  end\n// co-format: on\n';
    const protectedSource = `module formatting_smoke;\nreg value;\n${protectedPart}initial begin\nvalue=1;\nend\nendmodule\n`;
    await replace(protectedSource);
    await apply(await full());
    assert.ok(document.getText().includes(protectedPart), 'Disabled region and markers must remain byte-identical');
    assert.match(document.getText(), /^  initial begin\r?\n    value = 1;/m);
    assert.deepEqual(await full(), []);
    await replace(protectedSource);
    const allLines = new vscode.Range(0, 0, document.lineCount - 1, 0);
    await apply(await range(allLines));
    assert.ok(document.getText().includes(protectedPart), 'Range formatting must also preserve disabled regions');
    assert.match(document.getText(), /^  initial begin\r?\n    value = 1;/m);
    assert.deepEqual(await range(allLines), []);

    // 保护区跨越结构边界时，区外仍应继承真实的 begin/end 上下文。
    const protectedHeader = '// co-format: off\nif(1) begin\n// co-format: on\n';
    await replace(`module formatting_smoke;\nreg value;\ninitial begin\n${protectedHeader}value=1;\nend\nend\nendmodule\n`);
    await apply(await full());
    assert.ok(document.getText().includes(protectedHeader));
    assert.match(document.getText(), /^      value = 1;/m);
    assert.deepEqual(await full(), []);
    console.log('PASS real Verilog full/range formatting, spaces/tabs, legacy settings, and protected regions');
  } finally {
    await configuration.update('verilog.format.spaceInRange', previous, vscode.ConfigurationTarget.WorkspaceFolder);
    // 删除独立 fixture 并清除未保存状态，不污染后续诊断或课程 smoke。
    await replace(source);
    await document.save();
    const cleanup = new vscode.WorkspaceEdit();
    cleanup.deleteFile(uri);
    assert.equal(await vscode.workspace.applyEdit(cleanup), true);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { runFormattingSmoke };
