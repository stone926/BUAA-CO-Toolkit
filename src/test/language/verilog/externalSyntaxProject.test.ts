import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { URI } from 'vscode-uri';
import { resolveExternalSyntaxProject } from '../../../language/verilog/externalSyntaxProject';

describe('external syntax project sources', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-syntax-project-'));
    write('alu.v', 'module alu(input a, output y); assign y = a; endmodule\n');
    write('.co/tb/alu_tb.v', 'module alu_tb; reg a; wire y; alu uut(.a(a), .y(y)); endmodule\n');
    write('.co/tb/ext_tb.v', 'module ext_tb; broken syntax\n');
    write('.co/iverilog/co_generated_alu_tb.v', 'module co_generated_alu_tb; endmodule\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relativePath: string, text: string): void {
    const file = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  async function sourcesFor(relativeTrigger: string): Promise<string[] | undefined> {
    const folders = [{ uri: URI.file(root).toString(), name: 'p1' }];
    const trigger = URI.file(path.join(root, ...relativeTrigger.split('/'))).toString();
    const project = await resolveExternalSyntaxProject(folders, trigger);
    return project?.sources.map((source) => path.relative(project.root, source).replace(/\\/g, '/'));
  }

  it('checks a saved .co/tb testbench after the project sources it instantiates', async () => {
    expect(await sourcesFor('.co/tb/alu_tb.v')).toEqual(['alu.v', '.co/tb/alu_tb.v']);
  });

  it('keeps .co/tb and generated testbenches out of checks triggered by project files', async () => {
    expect(await sourcesFor('alu.v')).toEqual(['alu.v']);
    expect(await sourcesFor('.co/iverilog/co_generated_alu_tb.v')).toEqual(['alu.v']);
  });
});
