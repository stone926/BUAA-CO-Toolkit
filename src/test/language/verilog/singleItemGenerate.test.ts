// @index single-generate-tests — Scoped declarations and leaf module ASTs for unbraced generate items
import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/diagnosticProvider';
import { parseVerilogCore } from '../../../language/verilog/parseCore';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';
import { invalidSingleGenerateCases, validSingleGenerateCases } from '../../helpers/singleItemGenerateCases';

const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
let version = 1;
function check(source: string) {
  const document = TextDocument.create(`test://single-generate/${version++}.v`, 'verilog', version, source);
  const index = new VerilogWorkspaceIndex();
  index.updateDocument(document, settings);
  return { document, diagnostics: getVerilogDiagnostics(document, settings, index) };
}

describe('single-item generate bodies through indexed production diagnostics', () => {
  it.each(invalidSingleGenerateCases)('rejects %s with the exact source expression', (_name, marked, code) => {
    const start = marked.indexOf('[['), end = marked.indexOf(']]');
    const { document, diagnostics } = check(marked.replace('[[', '').replace(']]', ''));
    expect(diagnostics.find((diagnostic) => diagnostic.code === code), JSON.stringify(diagnostics)).toMatchObject({ code, severity: DiagnosticSeverity.Error, range: Range.create(document.positionAt(start), document.positionAt(end - 2)) });
  });
  it.each(validSingleGenerateCases)('preserves the neighboring legal construct: %s', (source) => {
    expect(check(source).diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)).toEqual([]);
  });
  it('keeps real declarations local and makes single assignment bodies continuous module items', () => {
    const source = 'module m(output [1:0] y); genvar i; if(1) wire a; if(1) wire a; for(i=0;i<2;i=i+1) assign y[i]=i; endmodule';
    const { document } = check(source);
    const parsed = parseVerilogCore(document), module = parsed.modules[0];
    expect(module.declarations.has('a')).toBe(false);
    expect(module.generateBlocks.filter((block) => block.implicit && block.declarations.some((declaration) => declaration.name === 'a'))).toHaveLength(2);
    const continuous = parsed.ast.modules[0].items.filter((item) => item.kind === 'continuousAssign');
    expect(continuous).toHaveLength(1);
    expect(document.getText(continuous[0].range)).toBe('assign y[i]=i;');
    const body = parsed.ast.modules[0].generateControls.find((control) => control.kind === 'for')!.bodyRange!;
    expect(module.generateBlocks.find((block) => block.implicit && document.getText(block.range) === 'assign y[i]=i;')?.range).toEqual(body);
    expect(parsed.semantic.blockScopes.filter((scope) => JSON.stringify(scope.range) === JSON.stringify(body))).toHaveLength(1);
  });
});
