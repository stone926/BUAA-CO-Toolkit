// Exercise saved failure navigation and rerun through production VS Code/Worker/Icarus APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');

function sameFile(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function waveformTab(file) {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
    tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'co.waveform.viewer'
      && sameFile(tab.input.uri.fsPath, file));
}

async function caseIds(casesDirectory) {
  return (await fs.readdir(casesDirectory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

/** Independently resolve the first displayed PC from the stored image/source map. */
async function expectedSource(caseDirectory, manifest) {
  const evidence = JSON.parse(manifest.metadata['test.evidence']);
  const rawPc = evidence.oracle?.pc ?? evidence.dut?.pc;
  assert.ok(rawPc, 'The retained writeback mismatch must identify a PC');
  const pc = Number.parseInt(rawPc.replace(/^0x/i, ''), 16);
  const image = JSON.parse(await fs.readFile(path.join(caseDirectory, manifest.program.image.path), 'utf8'));
  let origin;
  for (const [segmentIndex, segment] of image.segments.entries()) {
    const wordIndex = (pc - segment.baseAddress) / 4;
    if (Number.isInteger(wordIndex) && wordIndex >= 0 && wordIndex < segment.words.length) {
      origin = image.sourceMap.find(entry => entry.segmentIndex === segmentIndex && entry.wordIndex === wordIndex);
      break;
    }
  }
  assert.ok(origin && Number.isInteger(origin.startOffset), 'Builtin assembly must retain the mismatch source location');
  const graph = JSON.parse(await fs.readFile(path.join(caseDirectory, manifest.program.sourceGraph.path), 'utf8'));
  const unit = graph.units.find(entry => entry.id === origin.sourceId);
  assert.ok(unit);
  const text = await fs.readFile(path.join(caseDirectory, unit.blobPath), 'utf8');
  const row = text.slice(0, origin.startOffset).split('\n').length - 1;
  return { file: path.join(caseDirectory, unit.materializedPath), row, text: text.split(/\r?\n/)[row].trim() };
}

async function verifyCourseFailure({ folder, result, bounded, waitFor }) {
  const casesDirectory = path.join(folder.uri.fsPath, '.co', 'cases');
  const originalDirectory = path.join(casesDirectory, result.caseId);
  const originalManifestFile = path.join(originalDirectory, 'case.json');
  const originalBytes = await fs.readFile(originalManifestFile);
  const original = JSON.parse(originalBytes.toString('utf8'));
  assert.equal(original.metadata?.['test.status'], 'failed');
  assert.ok(original.metadata?.['test.evidence'], 'Continuous failures must retain navigation evidence');
  assert.equal(JSON.parse(original.metadata['test.evidence']).version, 1);
  const source = await expectedSource(originalDirectory, original);
  const initialIds = await caseIds(casesDirectory);

  const createPanel = vscode.window.createWebviewPanel;
  let history, failure;
  const panels = [];
  vscode.window.createWebviewPanel = function (...args) {
    const panel = createPanel.apply(this, args);
    if (args[0] !== 'coAsmCaseIndex' && args[0] !== 'coTestFailure') return panel;
    const captured = { panel, receive: undefined };
    panels.push(panel);
    if (args[0] === 'coAsmCaseIndex') history = captured;
    else failure = captured;
    const originalReceive = panel.webview.onDidReceiveMessage.bind(panel.webview);
    panel.webview.onDidReceiveMessage = (callback, ...rest) => {
      captured.receive = callback;
      return originalReceive(callback, ...rest);
    };
    return panel;
  };
  const send = (label, captured, message) => bounded(label, async () => {
    assert.ok(captured?.receive, `${label}: production webview callback must be registered`);
    await captured.receive(message);
  });
  try {
    await bounded('Open real test history', () => vscode.commands.executeCommand('co.test.openAsmCaseIndex'));
    await waitFor('History retained failure', () => history?.panel.webview.html.includes(`data-case-id="${result.caseId}"`));
    await send('History inspect saved failure', history, { action: 'inspectCase', caseId: result.caseId });
    await waitFor('Saved failure diagnosis', () => failure?.panel.webview.html.includes('data-failure-action="source"'));
    assert.ok(failure.panel.webview.html.includes(result.caseId));
    assert.ok(failure.panel.webview.html.includes('data-failure-action="waveform"'));

    await send('Diagnosis source navigation', failure, { action: 'source', index: 0 });
    await waitFor('Selected case-contained source line', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && sameFile(editor.document.uri.fsPath, source.file) && editor.selection.start.line === source.row;
    });
    assert.equal(vscode.window.activeTextEditor.document.lineAt(source.row).text.trim(), source.text);
    assert.ok(path.relative(originalDirectory, source.file).startsWith(`source${path.sep}`), 'Source navigation must use the saved case');

    await send('Diagnosis automatic rerun with VCD', failure, { action: 'waveform' });
    const ids = await caseIds(casesDirectory);
    const added = ids.filter(id => !initialIds.includes(id));
    assert.equal(added.length, 1, 'One waveform action must create exactly one independent case');
    const newId = added[0];
    assert.notEqual(newId, result.caseId);
    const newDirectory = path.join(casesDirectory, newId);
    const rerun = JSON.parse(await fs.readFile(path.join(newDirectory, 'case.json'), 'utf8'));
    assert.equal(rerun.metadata?.['rerun.originalCaseId'], result.caseId);
    assert.equal(rerun.metadata?.['test.status'], 'failed', 'The deliberately broken CPU must still fail the new run');
    assert.equal(rerun.program.machineCode.sha256, original.program.machineCode.sha256, 'Rerun must execute the identical saved program');
    assert.equal(rerun.program.assembler.id, 'builtin-ts');
    assert.equal(rerun.oracle.engine.id, 'builtin-ts');
    const dutConfiguration = rerun.dut?.configuration;
    assert.equal(dutConfiguration?.['dut.verilog.testbenchKind'], 'generated');
    const privateTestbench = dutConfiguration['dut.verilog.testbenchModule'];
    assert.equal(privateTestbench, original.dut.configuration['dut.verilog.testbenchModule']);
    assert.notEqual(privateTestbench, 'course_fixture_tb', 'Rerun must use the automatic private TB');
    assert.deepEqual(await fs.readFile(originalManifestFile), originalBytes, 'The archived failure must remain byte-identical');
    const reference = rerun.artifacts?.dut?.['verilog/waveform'];
    assert.ok(reference && typeof reference === 'object', 'The rerun manifest must bind its generated waveform');
    const dumpFile = path.join(newDirectory, reference.path);
    const dump = await fs.readFile(dumpFile, 'utf8');
    assert.ok(dump.includes('$enddefinitions'), 'The real Icarus run must generate a VCD header');
    assert.ok(dump.includes(`$scope module ${privateTestbench} $end`), 'The waveform must dump the automatic private TB');
    assert.equal(Buffer.byteLength(dump), reference.bytes);
    const simFile = dumpFile.replace(/\.vcd$/i, '.sim.out');
    const output = await fs.readFile(simFile, 'utf8');
    assert.match(output, /^VCD info: dumpfile .+ opened for output\.?\s*$/m);
    assert.ok(output.includes(path.basename(dumpFile)), 'Sibling trace must declare the VCD actually opened');
    await waitFor('Automatic rerun waveform viewer', () => waveformTab(dumpFile));
    assert.ok(failure.panel.webview.html.includes(newId));
    assert.ok(failure.panel.webview.html.includes('data-failure-action="openWaveform"'));

    await bounded('Close rerun waveform viewer', () => vscode.window.tabGroups.close(waveformTab(dumpFile)));
    await waitFor('Closed waveform viewer', () => !waveformTab(dumpFile));
    failure.panel.dispose();
    failure = undefined;
    await waitFor('History new rerun case', () => history.panel.webview.html.includes(`data-case-id="${newId}"`));
    await send('History reopen saved rerun diagnosis', history, { action: 'inspectCase', caseId: newId });
    await waitFor('Saved waveform action restored', () => failure?.panel.webview.html.includes('data-failure-action="openWaveform"'));
    await send('Reopen saved waveform without rerunning', failure, { action: 'openWaveform' });
    await waitFor('Saved rerun waveform reopened', () => waveformTab(dumpFile));
    assert.deepEqual(await caseIds(casesDirectory), ids, 'Opening saved waveform must not create another case');
    assert.deepEqual(await fs.readFile(originalManifestFile), originalBytes);
    console.log('PASS failure diagnosis: retained evidence, saved ASM line, Worker/Icarus automatic rerun, independent failed case/VCD, and saved-waveform reopen');
  } finally {
    for (const panel of panels) panel.dispose();
    vscode.window.createWebviewPanel = createPanel;
  }
}

module.exports = { verifyCourseFailure };
