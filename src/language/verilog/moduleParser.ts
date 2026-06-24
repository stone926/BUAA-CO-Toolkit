import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseModulesFromTokens } from './astParser';
import { lexVerilog } from './lexer';
import { VerilogModule } from './model';

export function parseModules(document: TextDocument, text: string): VerilogModule[] {
  return parseModulesFromTokens(document, text, lexVerilog(text).tokens);
}

export {
  parseModulesFromTokens
} from './astParser';
