// Real VS Code API smoke tests, loaded by @vscode/test-electron from a packaged VSIX.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

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
const courseAsm = `.text
  ori $8, $0, 42
  sw $8, 0($0)
_co_test_end:
  beq $0, $0, _co_test_end
  nop
`;
// A tiny protocol fixture, not a student CPU: check the actual assembler's
// code.txt, then emit two independently specified architectural write events.
const courseVerilog = `module course_fixture(input clk, input reset);
  reg [31:0] code [0:4095];
  integer step;
  initial $readmemh("code.txt", code);
  always @(posedge clk) begin
    if (reset) step <= 0;
    else begin
      case (step)
        0: begin
          if (code[0] !== 32'h3408002a) $fatal(1, "unexpected ori machine code");
          $display("@00003000: $8 <= 0000002a");
        end
        1: begin
          if (code[1] !== 32'hac080000) $fatal(1, "unexpected sw machine code");
          $display("@00003004: *00000000 <= 0000002a");
        end
        2: begin
          if (code[2] !== 32'h1000ffff || code[3] !== 32'h00000000)
            $fatal(1, "unexpected halt machine code");
          $finish;
        end
      endcase
      step <= step + 1;
    end
  end
endmodule
`;
const courseTestbench = `\`timescale 1ns/1ps
module course_fixture_tb;
  reg clk = 0;
  reg reset = 1;
  course_fixture dut(.clk(clk), .reset(reset));
  always #5 clk = ~clk;
  initial #20 reset = 0;
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

function traceLines(text) {
  return text.split(/\r?\n/)
    .filter((line) => /^\s*@/.test(line))
    .map((line) => line.replace(/\s+/g, '').toLowerCase());
}

async function run() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'The test runner must open an isolated workspace');
  assert.ok(process.env.CO_EXTENSION_ROOT, 'The runner must provide the unpacked VSIX root');
  const root = folder.uri.fsPath;
  const files = {
    '诊断 fixture.v': validVerilog,
    'command_fixture_tb.v': commandTestbench,
    'course_fixture.v': courseVerilog,
    'course_fixture_tb.v': courseTestbench,
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
    vscode.commands.executeCommand('co.verilog.runIsim'));
  assert.equal(simulation?.backend, 'iverilog');
  assert.equal(simulation.compileResult.ok, true, simulation.compileResult.stderr);
  assert.equal(simulation.simResult?.ok, true, simulation.simResult?.stderr);
  assert.match(await fs.readFile(simulation.simOut.fsPath, 'utf8'), /CO_EXTENSION_HOST_SIM_OK/);
  console.log('PASS Verilog simulation command and persisted output');

  await configure(folder, {
    'project.profile': 'P4',
    'project.topModule': 'course_fixture',
    'project.testbench': 'course_fixture_tb'
  });
  const asm = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'course smoke.asm')));
  await vscode.window.showTextDocument(asm);
  assert.equal(asm.languageId, 'mipsasm');
  await bounded('P4 course test command', () => vscode.commands.executeCommand('co.test.runFullTest'));
  const expectedTrace = ['@00003000:$8<=0000002a', '@00003004:*00000000<=0000002a'];
  for (const suffix of ['oracle.out', 'sim.out']) {
    const text = await fs.readFile(path.join(root, '.co', 'out', `course smoke.${suffix}`), 'utf8');
    assert.deepEqual(traceLines(text), expectedTrace, `${suffix} must contain the two golden write events`);
  }
  await waitFor('Course comparison report tab', () => vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) =>
    tab.label === 'CO Trace 比较' && tab.input instanceof vscode.TabInputWebview)));
  console.log('PASS course command: builtin assembler, Worker oracle, Icarus DUT, and comparison report');
}

module.exports = { run };
