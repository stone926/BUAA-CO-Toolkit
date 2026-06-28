// @index(wire Verilog completion provider dependencies)
import { CompletionItem, Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { getVerilogCompletions as getVerilogCompletionsFromProvider } from './completionProvider';
import { findInstanceContext } from './resolveSymbol';

export function getVerilogCompletions(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): CompletionItem[] {
  return getVerilogCompletionsFromProvider(document, position, settings, index, { findInstanceContext });
}
