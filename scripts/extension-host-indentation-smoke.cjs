// @index indentation-smoke — 真实宿主的 Verilog 按字符输入缩进回归
// Typing rules come from language-configuration/verilog.json and are applied by VS Code
// core, so only a real editor host can prove the behaviour.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');

// The reported snippet: `else` continues the inner if/else chain and must stay level
// with the `else if` above it instead of moving one indent unit left.
const reportedBug = [
  'always @(posedge inputA) begin',
  '    if (type == ADD) begin',
  '',
  '    end',
  '    else begin',
  '        if (type == ADDI) begin',
  '',
  '        end',
  '        else if (type == SUB) begin',
  '',
  '        end',
  '        ',
  '    end',
  'end'
];
const expectedReportedBug = '        else';
const shallowElse = [
  'always @(posedge clk) begin',
  '    if (a) begin',
  '        x <= 1;',
  '    end',
  '    ',
  'end'
];
const endInsideBody = [
  'always @(posedge clk) begin',
  '    if (a) begin',
  '        x <= 1;',
  '        ',
  '    end',
  'end'
];
const endcaseInsideBody = [
  'always @(*) begin',
  '    case (sel)',
  "        1'b0: y = a;",
  '        ',
  '    endcase',
  'end'
];
const endmoduleAtTopLevel = ['module indentation_smoke;', '    assign value = 1;', '    '];

async function typeCharacters(editor, text) {
  // Trigger characters one by one: VS Code only reindents while typing single characters.
  for (const character of text) {
    await vscode.commands.executeCommand('type', { text: character });
  }
}

async function runIndentationSmoke({ root }) {
  const directory = path.join(root, '缩进 fixture');
  await fs.mkdir(directory, { recursive: true });
  const opened = [];
  async function open(name, lines) {
    const uri = vscode.Uri.file(path.join(directory, name));
    await fs.writeFile(uri.fsPath, `${lines.join('\n')}\n`);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    // Keep the fixture independent of workspace indentation settings.
    editor.options = { tabSize: 4, insertSpaces: true };
    opened.push(document);
    assert.equal(document.languageId, 'verilog');
    return { document, editor };
  }
  async function typeAt(editor, line, column, text) {
    const position = new vscode.Position(line, column);
    editor.selection = new vscode.Selection(position, position);
    await typeCharacters(editor, text);
    return editor.document.lineAt(line).text;
  }
  try {
    const reported = await open('reported.v', reportedBug);
    assert.equal(await typeAt(reported.editor, 11, 8, 'else'), expectedReportedBug,
      'Typing else must not outdent it below the matching end');

    const shallow = await open('shallow.v', shallowElse);
    assert.equal(await typeAt(shallow.editor, 4, 4, 'else'), '    else',
      'A top-level else stays aligned with its if');

    const closer = await open('closer.v', endInsideBody);
    assert.equal(await typeAt(closer.editor, 3, 8, 'end'), '    end',
      'Typing end still leaves the body');

    const endcase = await open('endcase.v', endcaseInsideBody);
    assert.equal(await typeAt(endcase.editor, 3, 8, 'endcase'), '    endcase',
      'Typing endcase still leaves the case body');

    const endmodule = await open('endmodule.v', endmoduleAtTopLevel);
    assert.equal(await typeAt(endmodule.editor, 2, 4, 'endmodule'), 'endmodule',
      'Typing endmodule returns to top level');

    // Documented trade-off: without an else rule, a line inside a branch the user has not
    // closed yet keeps the indentation the user chose instead of being pulled out wrongly.
    const inside = await open('inside.v', endInsideBody);
    assert.equal(await typeAt(inside.editor, 3, 8, 'else'), '        else',
      'An unclosed branch keeps the indentation the user chose');

    // Enter keeps the regular begin/end levels.
    const enter = await open('enter.v', ['module mock;', 'always @(posedge clk) begin', '    end']);
    const beginEnd = enter.document.lineAt(1).text.length;
    enter.editor.selection = new vscode.Selection(new vscode.Position(1, beginEnd), new vscode.Position(1, beginEnd));
    await vscode.commands.executeCommand('type', { text: '\n' });
    assert.equal(enter.document.lineAt(2).text, '    ', 'Enter after begin indents the body');
    const closerEnd = enter.document.lineAt(3).text.length;
    enter.editor.selection = new vscode.Selection(new vscode.Position(3, closerEnd), new vscode.Position(3, closerEnd));
    await vscode.commands.executeCommand('type', { text: '\n' });
    assert.equal(enter.document.lineAt(4).text, '    ', 'Enter after end keeps the closing level');

    console.log('PASS real host Verilog typing indentation: else, end, endcase, endmodule, and Enter');
  } finally {
    // Save instead of leaving unsaved state, then delete: deleting through a workspace
    // edit also closes the fixture editors.
    const cleanup = new vscode.WorkspaceEdit();
    for (const document of opened) {
      await document.save();
      cleanup.deleteFile(document.uri);
    }
    assert.equal(await vscode.workspace.applyEdit(cleanup), true);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { runIndentationSmoke };
