// Focused real-host entry point; the same checks also run in the packaged release gate.
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');
const { runFormattingSmoke } = require('./extension-host-formatting-smoke.cjs');
const { runEditorFormattingSmoke } = require('./extension-host-editor-formatting.cjs');

async function waitFor(label, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out`);
}

exports.run = async () => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'The runner must open an isolated workspace');
  const extension = vscode.extensions.getExtension('stone926.buaa-co-toolkit');
  assert.ok(extension, 'The extension must be discoverable');
  assert.equal(path.resolve(extension.extensionPath), path.resolve(process.env.CO_EXTENSION_ROOT));
  await extension.activate();
  await vscode.workspace.getConfiguration('co', folder.uri).update(
    'verilog.syntax.external.mode', 'off', vscode.ConfigurationTarget.WorkspaceFolder);
  await runFormattingSmoke({ root: folder.uri.fsPath, waitFor });
  await runEditorFormattingSmoke({ root: folder.uri.fsPath, waitFor });
};
