import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseVerilogCst } from './cst';
import { parseModulesFromTokens } from './astParser';
import { VerilogModule } from './model';

export function parseModules(document: TextDocument, text: string): VerilogModule[] {
  return parseModulesFromTokens(document, text, parseVerilogCst(document, text).codeTokens);
}

export {
  parseModulesFromTokens
} from './astParser';
