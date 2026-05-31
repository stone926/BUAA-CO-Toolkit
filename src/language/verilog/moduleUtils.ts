import { Position } from 'vscode-languageserver/node';
import { containsPosition } from '../common/lsp';
import { VerilogDecl, VerilogModule } from './model';

export function moduleAtPosition(modules: VerilogModule[], position: Position): VerilogModule | undefined {
  return modules.find((module) => containsPosition(module.range, position));
}

export function declDetail(decl: VerilogDecl): string {
  return `${decl.direction ?? decl.kind} ${decl.width ? `${decl.width} ` : ''}${decl.name}`.trim();
}

export function buildTestbench(module: VerilogModule, tbName: string): string {
  const declarations = module.ports.map((port) => {
    const kind = port.direction === 'input' || port.direction === 'inout' ? 'reg' : 'wire';
    return `    ${kind} ${port.width ? `${port.width} ` : ''}${port.name};`;
  });
  const connections = module.ports.map((port, index) => {
    const comma = index === module.ports.length - 1 ? '' : ',';
    return `        .${port.name}(${port.name})${comma}`;
  });
  const hasClk = module.ports.some((port) => port.name === 'clk');
  const hasReset = module.ports.some((port) => port.name === 'reset');
  const lines: string[] = [
    '`timescale 1ns / 1ps',
    '',
    `module ${tbName};`,
    ...declarations,
    '',
    `    ${module.name} uut (`,
    ...connections,
    '    );',
    ''
  ];

  if (hasClk) {
    lines.push(
      '    initial begin',
      "        clk = 1'b0;",
      '        forever #5 clk = ~clk;',
      '    end',
      ''
    );
  }

  lines.push('    initial begin');
  if (hasReset) {
    lines.push(
      "        reset = 1'b1;",
      '        #20;',
      "        reset = 1'b0;"
    );
  }
  lines.push('        #200000;', '        $finish;', '    end', 'endmodule', '');
  return lines.join('\n');
}
