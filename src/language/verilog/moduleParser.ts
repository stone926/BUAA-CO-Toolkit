import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseVerilogCst, VerilogCstDocument } from './cst';
import { parseModulesFromCst } from './astParser';
import { VerilogModule } from './model';

export function parseModules(document: TextDocument, text: string, cst: VerilogCstDocument = parseVerilogCst(document, text)): VerilogModule[] {
  return parseModulesFromCst(document, text, cst);
}
