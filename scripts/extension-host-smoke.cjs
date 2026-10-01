// Real VS Code API smoke tests, loaded by @vscode/test-electron from a packaged VSIX.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('./extension-host-api.cjs');
const { customTestbenchFixtures, runCustomTestbenchSmoke } = require('./extension-host-custom-testbench-smoke.cjs');

const timeoutMs = 30_000;
const validVerilog = `module diagnostic_fixture(output wire value);
  assign value = 1'b1;
endmodule
`;
const invalidVerilog = validVerilog.replace("1'b1", 'missing_smoke_signal');
const commandTestbench = `module command_fixture_tb;
  initial begin
    $display("CO_EXTENSION_HOST_SIM_OK");
    $finish;
  end
endmodule
`;
// Sequential fixture for the waveform flow: a counter plus a small memory that
// `$dumpvars` alone would never record.
const waveTestbench = `\`timescale 1ns/1ps
module wave_fixture_tb;
  reg clk = 0;
  reg [3:0] count = 0;
  reg [7:0] regs [0:3];
  always #5 clk = ~clk;
  always @(posedge clk) begin
    count <= count + 1;
    regs[count[1:0]] <= {4'h0, count};
  end
  initial #100 $finish;
endmodule
`;
const courseAsm = `.text
  ori $8, $0, 42
  sw $8, 0($0)
_co_test_end:
  beq $0, $0, _co_test_end
  nop
`;
// A deliberately incorrect DUT checks the public continuous workflow end to end.
// The generated program and oracle are real; this nonzero-register mismatch must
// stop the first iteration, retain its case, and produce a user-visible report.
const courseVerilog = `module course_fixture(input clk, input reset);
  reg [31:0] code [0:4095];
  initial $readmemh("code.txt", code);
  always @(posedge clk) begin
    if (!reset) begin
      if (^code[0] === 1'bx) $fatal(1, "missing assembled machine code");
      $display("@00003000: $1 <= ffffffff");
      $finish;
    end
  end
endmodule
`;

async function bounded(label, action) {
  let timer;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(label, predicate) {
  return bounded(label, async () => {
    while (true) {
      const result = await predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
}

async function replaceAndSave(document, text) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(await document.save(), true);
}

async function configure(folder, values) {
  const configuration = vscode.workspace.getConfiguration('co', folder.uri);
  for (const [key, value] of Object.entries(values)) {
    await configuration.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

async function run() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'The test runner must open an isolated workspace');
  assert.ok(process.env.CO_EXTENSION_ROOT, 'The runner must provide the unpacked VSIX root');
  const root = folder.uri.fsPath;
  const files = {
    ...customTestbenchFixtures,
    '诊断 fixture.v': validVerilog,
    'command_fixture_tb.v': commandTestbench,
    'wave_fixture_tb.v': waveTestbench,
    'course_fixture.v': courseVerilog,
    'course smoke.asm': courseAsm
  };
  await Promise.all(Object.entries(files).map(([name, text]) => fs.writeFile(path.join(root, name), text)));
  await configure(folder, {
    'project.profile': 'P1',
    'project.topModule': 'diagnostic_fixture',
    'project.testbench': 'command_fixture_tb',
    'verilog.syntax.external.mode': 'onSave'
  });

  const extension = vscode.extensions.getExtension('stone926.buaa-co-toolkit');
  assert.ok(extension, 'The packaged extension must be discoverable');
  assert.equal(path.resolve(extension.extensionPath), path.resolve(process.env.CO_EXTENSION_ROOT));
  await bounded('Extension activation', () => extension.activate());
  assert.equal(extension.isActive, true);
  console.log('PASS packaged extension activation');

  const diagnosticUri = vscode.Uri.file(path.join(root, '诊断 fixture.v'));
  const document = await vscode.workspace.openTextDocument(diagnosticUri);
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, 'verilog');
  await waitFor('Verilog language server startup', async () => {
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', diagnosticUri);
    return symbols?.some((symbol) => symbol.name === 'diagnostic_fixture');
  });
  // The parser reports only a warning for this identifier; the actual bundled
  // compiler must supply the error, rather than a parser or toolchain failure.
  await replaceAndSave(document, invalidVerilog);
  // Unrelated editor settings must not cancel the pending on-save compiler run.
  await vscode.workspace.getConfiguration('editor', diagnosticUri).update(
    'wordWrap', 'on', vscode.ConfigurationTarget.WorkspaceFolder);
  try {
    await waitFor('Icarus on-save diagnostic', () => vscode.languages.getDiagnostics(diagnosticUri).some((diagnostic) =>
      diagnostic.source === 'Icarus Verilog'
        && diagnostic.code === 'iverilog-syntax'
        && diagnostic.severity === vscode.DiagnosticSeverity.Error
        && diagnostic.message.includes('missing_smoke_signal')));
  } catch (error) {
    console.error('Current diagnostics:', JSON.stringify(vscode.languages.getDiagnostics(diagnosticUri)));
    throw error;
  }
  await replaceAndSave(document, validVerilog);
  await waitFor('Cleared Icarus diagnostic after repair', () =>
    !vscode.languages.getDiagnostics(diagnosticUri).some((diagnostic) =>
      diagnostic.source === 'Icarus Verilog' || diagnostic.severity === vscode.DiagnosticSeverity.Error));
  console.log('PASS real LSP startup, on-save compiler error, and repair');

  await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'command_fixture_tb.v')));
  const simulation = await bounded('Verilog simulation command', () =>
    vscode.commands.executeCommand('co.verilog.runSimulation'));
  assert.equal(simulation?.backend, 'iverilog');
  assert.equal(simulation.compileResult.ok, true, simulation.compileResult.stderr);
  assert.equal(simulation.simResult?.ok, true, simulation.simResult?.stderr);
  assert.match(await fs.readFile(simulation.simOut.fsPath, 'utf8'), /CO_EXTENSION_HOST_SIM_OK/);
  console.log('PASS Verilog simulation command and persisted output');

  await runCustomTestbenchSmoke({ root, bounded, waitFor, replaceAndSave });

  await configure(folder, { 'project.testbench': 'wave_fixture_tb' });
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'wave_fixture_tb.v')));
  await bounded('Waveform simulation command', () => vscode.commands.executeCommand('co.verilog.viewWaveform'));
  const dumpPath = path.join(root, '.co', 'wave', 'wave_fixture_tb.vcd');
  const dump = await fs.readFile(dumpPath, 'utf8');
  assert.match(dump, /\$var reg 4 \S+ count \[3:0\] \$end/);
  assert.match(dump, /\$var reg 8 \S+ \\regs\[3\] \[7:0\] \$end/, 'small memories must be dumped word by word');
  const waveTrace = await fs.readFile(path.join(root, '.co', 'wave', 'wave_fixture_tb.sim.out'), 'utf8');
  assert.match(waveTrace, /Time scale of \(wave_fixture_tb\)/);
  await waitFor('Waveform viewer tab', () => vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) =>
    tab.input instanceof vscode.TabInputCustom
      && tab.input.viewType === 'co.waveform.viewer'
      && path.resolve(tab.input.uri.fsPath) === path.resolve(dumpPath))));
  console.log('PASS waveform simulation, per-word memory dump, and built-in viewer');

  await require('./extension-host-mars.cjs').verifyMars({ folder, configure, bounded, waitFor });
  await require('./extension-host-asm-smoke.cjs').verifyBuiltinAsm({ folder, configure, bounded, replaceAndSave });

  await configure(folder, {
    'project.profile': 'P4',
    'project.topModule': 'course_fixture',
    'project.testbench': 'course_fixture_tb'
  });
  const asm = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'course smoke.asm')));
  await vscode.window.showTextDocument(asm);
  assert.equal(asm.languageId, 'mipsasm');
  try {
    await bounded('P4 continuous test command', () =>
      vscode.commands.executeCommand('co.test.startContinuousGeneratedTraceTests'));
  } finally {
    await vscode.commands.executeCommand('co.test.stopContinuousTests');
  }
  const report = JSON.parse(await fs.readFile(
    path.join(root, '.co', 'out', 'continuous-trace-report.json'), 'utf8'));
  assert.equal(report.running, false);
  assert.equal(report.totalIterations, 1);
  const result = report.iterations[0].results[0];
  assert.equal(result.status, 'failed', result.message);
  assert.equal(result.stage, 'compare');
  assert.equal(result.dutBackend, 'iverilog');
  assert.ok(result.caseId, 'The failing generated case must be retained');
  const manifest = JSON.parse(await fs.readFile(
    path.join(root, '.co', 'cases', result.caseId, 'case.json'), 'utf8'));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.program.assembler.id, 'builtin-ts');
  assert.equal(manifest.oracle.engine.id, 'builtin-ts');
  await waitFor('Continuous report tab', () => vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) =>
    tab.label === '持续测试' && tab.input instanceof vscode.TabInputWebview)));
  await vscode.commands.executeCommand('co.test.openAsmCaseIndex');
  await waitFor('Test history tab', () => vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) =>
    tab.label === '测试历史 / 失败用例' && tab.input instanceof vscode.TabInputWebview)));
  console.log('PASS continuous command: generator, builtin assembler, Worker oracle, Icarus mismatch, and history');
}

module.exports = { run };
