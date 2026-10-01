// Real custom-testbench commands; loaded by the packaged VS Code host smoke suite.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

function testbenchText(moduleName, marker) {
  return `\`timescale 1ns/1ps
module custom_smoke_decoy_${moduleName};
  initial $fatal(1, "wrong custom-testbench module selected");
endmodule
module ${moduleName};
  reg clk = 0;
  wire [3:0] count;
  custom_smoke_counter dut(.clk(clk), .count(count));
  initial begin
    repeat (4) begin
      #5 clk = 1;
      #5 clk = 0;
    end
    if (count !== 4) $fatal(1, "CUSTOM_SMOKE_COUNT_MISMATCH: %0d", count);
    $display("${marker} count=%0d", count);
    $finish;
  end
endmodule
`;
}

// Start with valid, unique modules so the baseline project-wide syntax check can
// diagnose its own target. The unrelated file is broken only after that check.
const customTestbenchFixtures = {
  'custom_fixture_dut.v': `\`timescale 1ns/1ps
module custom_smoke_counter(input wire clk, output reg [3:0] count = 0);
  always @(posedge clk) count <= count + 1;
endmodule
`,
  'tb.v': testbenchText('tb', 'CO_CUSTOM_TB_INITIAL'),
  'testbench.v': testbenchText('testbench', 'CO_CUSTOM_TESTBENCH_INITIAL'),
  'unrelated_broken_testbench.v': 'module unrelated_broken_testbench; endmodule\n'
};

async function runCustomTestbenchSmoke({ root, bounded, waitFor, replaceAndSave }) {
  // Its path already belongs to the discovery baseline; changing existing
  // content avoids depending on the timing of a file-creation watcher event.
  await fs.writeFile(path.join(root, 'unrelated_broken_testbench.v'),
    'module unrelated_broken_testbench; this is invalid syntax\nendmodule\n');
  let lastFixture;
  for (const fileName of ['tb.v', 'testbench.v']) {
    const stem = path.basename(fileName, '.v');
    const uri = vscode.Uri.file(path.join(root, fileName));
    const document = await vscode.workspace.openTextDocument(uri);
    for (const moduleName of [stem, `${stem}_custom_tb`]) {
      const marker = `CO_CUSTOM_${moduleName.toUpperCase()}_OK`;
      const text = testbenchText(moduleName, marker);
      await replaceAndSave(document, text);
      // Matching stems take precedence even with the caret in the decoy; with a
      // different stem, selecting the actual module is the editor's explicit choice.
      const line = moduleName === stem ? 1 : document.positionAt(text.indexOf(`module ${moduleName};`)).line;
      const selection = new vscode.Range(line, 0, line, 0);
      await vscode.window.showTextDocument(document, { selection });
      const result = await bounded(`${fileName}/${moduleName} simulation`, () =>
        vscode.commands.executeCommand('co.verilog.runSimulation'));
      assert.equal(result?.backend, 'iverilog');
      assert.equal(result.testbench.kind, 'active');
      assert.equal(result.testbench.moduleName, moduleName);
      assert.equal(path.resolve(result.testbench.sourceUri.fsPath), path.resolve(uri.fsPath));
      assert.equal(result.compileResult.ok, true, result.compileResult.stderr);
      assert.equal(result.simResult?.ok, true, result.simResult?.stderr);
      assert.ok(result.simOut, 'Successful custom simulation must persist its stdout');
      assert.ok((await fs.readFile(result.simOut.fsPath, 'utf8')).includes(`${marker} count=4`));
      assert.equal(await fs.readFile(uri.fsPath, 'utf8'), text, 'Simulation must preserve the custom testbench');
      lastFixture = { document, moduleName, marker, text, selection };
    }
  }
  console.log('PASS tb.v/testbench.v: matching and mismatched modules, real DUT stimulus, and custom-source exclusions');

  const { document, moduleName, marker, text, selection } = lastFixture;
  await replaceAndSave(document, text.replace('    $finish;', '    $display("%b", missing_custom_smoke_signal);\n    $finish;'));
  await vscode.window.showTextDocument(document, { selection });
  const compileFailure = await bounded('Selected custom-testbench compiler failure', () =>
    vscode.commands.executeCommand('co.verilog.runSimulation'));
  assert.equal(compileFailure?.compileResult.ok, false);
  assert.match(compileFailure.compileResult.stderr, /missing_custom_smoke_signal/);
  assert.equal(compileFailure.simResult, undefined, 'A failed compile must never run an earlier cached simulation');

  await replaceAndSave(document, text.replace('count !== 4', 'count !== 5'));
  await vscode.window.showTextDocument(document, { selection });
  const runtimeFailure = await bounded('Selected custom-testbench runtime failure', () =>
    vscode.commands.executeCommand('co.verilog.runSimulation'));
  assert.equal(runtimeFailure?.compileResult.ok, true, runtimeFailure?.compileResult.stderr);
  assert.equal(runtimeFailure.simResult?.ok, false);
  assert.match(runtimeFailure.simResult.stdout + runtimeFailure.simResult.stderr, /CUSTOM_SMOKE_COUNT_MISMATCH: 4/);
  assert.equal(runtimeFailure.simOut, undefined, 'A failed simulation must not publish successful output');

  await replaceAndSave(document, text);
  await vscode.window.showTextDocument(document, { selection });
  const repaired = await bounded('Repaired custom-testbench simulation', () =>
    vscode.commands.executeCommand('co.verilog.runSimulation'));
  assert.equal(repaired?.compileResult.ok, true, repaired?.compileResult.stderr);
  assert.equal(repaired.simResult?.ok, true, repaired.simResult?.stderr);
  assert.ok((await fs.readFile(repaired.simOut.fsPath, 'utf8')).includes(`${marker} count=4`));
  console.log('PASS selected custom TB compiler/runtime errors and successful repair');

  await vscode.window.showTextDocument(document, { selection });
  await bounded('Custom-testbench waveform command', () => vscode.commands.executeCommand('co.verilog.viewWaveform'));
  const dumpPath = path.join(root, '.co', 'wave', `${moduleName}.vcd`);
  const dump = await fs.readFile(dumpPath, 'utf8');
  assert.match(dump, /\$var (?:wire|reg) 4 \S+ count \[3:0\] \$end/);
  assert.match(dump, /b100 \S+/, 'Waveform must include the stimulated counter value 4');
  assert.ok((await fs.readFile(path.join(root, '.co', 'wave', `${moduleName}.sim.out`), 'utf8'))
    .includes(`${marker} count=4`));
  await waitFor('Custom-testbench waveform viewer', () => vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.input instanceof vscode.TabInputCustom
      && tab.input.viewType === 'co.waveform.viewer'
      && path.resolve(tab.input.uri.fsPath) === path.resolve(dumpPath))));
  console.log('PASS custom testbench waveform, stimulated value, persisted trace, and built-in viewer');
}

module.exports = { customTestbenchFixtures, runCustomTestbenchSmoke };
