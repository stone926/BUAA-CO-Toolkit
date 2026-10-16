import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface VerilogLanguageConfiguration {
  indentationRules: {
    increaseIndentPattern: string;
    decreaseIndentPattern: string;
    indentNextLinePattern?: string | null;
  };
}

const configuration = JSON.parse(
  readFileSync(resolve(process.cwd(), 'language-configuration/verilog.json'), 'utf8')
) as VerilogLanguageConfiguration;
const increaseIndent = new RegExp(configuration.indentationRules.increaseIndentPattern);
const decreaseIndent = new RegExp(configuration.indentationRules.decreaseIndentPattern);
const indentNextLine = new RegExp(configuration.indentationRules.indentNextLinePattern ?? '(?!)');

// VS Code 在输入字符使当前行匹配 decreaseIndentPattern 时立刻把该行左移一级；基准缩进来自上一条
// 非空行。Verilog 的 else 紧跟自身分支的 end，上一行已经是目标缩进，因此 else 不能进该模式，
// 否则每个正确位置的 else 都会被多移一级。真实宿主行为见 scripts/extension-host-indentation-smoke.cjs。
describe('Verilog indentation rules', () => {
  it('keeps a correctly placed else where the matching end already sits', () => {
    // 上一行的 end 命中该模式并给出目标缩进；else 若也命中就会被多移一级。
    expect(decreaseIndent.test('    end')).toBe(true);
    const elseLines = [
      '    else',
      '    else begin',
      '    else if (type == SUB) begin',
      '\telse',
      '        else // 嵌套层同样保持'
    ];
    for (const line of elseLines) {
      expect(decreaseIndent.test(line)).toBe(false);
    }
  });

  it('outdents every closing construct', () => {
    const closers = [
      '    end',
      'endmodule',
      '    endfunction',
      '    endtask',
      '    endgenerate',
      '    endcase',
      '    join',
      '    join_any',
      '    join_none'
    ];
    for (const line of closers) {
      expect(decreaseIndent.test(line)).toBe(true);
    }
  });

  it('indents openers, controlled statements and case bodies', () => {
    const openers = [
      'always @(posedge clk) begin',
      '    if (type == ADD) begin',
      '    else begin',
      '    case (type)',
      '    generate',
      'module alu(input a);'
    ];
    for (const line of openers) {
      expect(increaseIndent.test(line)).toBe(true);
    }
    // 闭合行自身不再开新层，else 的单语句分支交给 indentNextLinePattern。
    expect(increaseIndent.test('    end')).toBe(false);
    for (const line of ['    if (type == ADD)', '    else', '    else if (type == SUB)', '    for (i = 0; i < 4; i = i + 1)']) {
      expect(indentNextLine.test(line)).toBe(true);
    }
  });
});
