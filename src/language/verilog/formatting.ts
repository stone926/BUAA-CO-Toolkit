// @index formatting — Verilog 全文与选区保真格式化入口
import { FormattingOptions, Range, TextEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { readSource } from './formatting/source';
import { analyzeStructure } from './formatting/structure';
import { createLayout } from './formatting/layout';
import { alignLayout } from './formatting/alignment';
import { finishWhitespace, whitespaceEdits, workRange } from './formatting/edits';

export function getVerilogFormattingEdits(document: TextDocument, _settings: CoSettings, options: FormattingOptions): TextEdit[] {
  return format(document, options);
}
export function getVerilogRangeFormattingEdits(document: TextDocument, range: Range, _settings: CoSettings, options: FormattingOptions): TextEdit[] {
  return format(document, options, range);
}
function format(document: TextDocument, options: FormattingOptions, range?: Range): TextEdit[] {
  const source = readSource(document);
  const work = workRange(document, source, range);
  if (!work) return [];
  const structure = analyzeStructure(source);
  const layout = createLayout(source, structure, options);
  alignLayout(source, structure, layout, range ? work : undefined);
  finishWhitespace(source, layout, options, range === undefined);
  return whitespaceEdits(document, source, layout, work);
}
