// @index(Verilog signature help provider)
import {
  MarkupKind,
  ParameterInformation,
  Position,
  SignatureHelp,
  SignatureInformation
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { declDetail } from './parser';
import { getCachedVerilogParse } from './parseCache';
import { moduleMarkdown } from './display';
import { activeConnectionIndex, findInstanceContext } from './resolveSymbol';

export function getVerilogSignatureHelp(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): SignatureHelp | undefined {
  const parsed = getCachedVerilogParse(document, settings, false);
  const context = findInstanceContext(parsed.modules, position, index);
  if (!context?.targetModule) {
    return undefined;
  }
  const entries = context.listKind === 'parameters' ? context.targetModule.parameters : context.targetModule.ports;
  if (!entries.length) {
    return undefined;
  }
  const activeParameter = activeConnectionIndex(document, position, context, entries);
  const signature: SignatureInformation = {
    label: `${context.targetModule.name}(${entries.map((entry) => entry.name).join(', ')})`,
    documentation: {
      kind: MarkupKind.Markdown,
      value: moduleMarkdown(context.targetModule)
    },
    parameters: entries.map((entry): ParameterInformation => ({
      label: entry.name,
      documentation: {
        kind: MarkupKind.Markdown,
        value: `\`${declDetail(entry)}\``
      }
    }))
  };
  return {
    signatures: [signature],
    activeSignature: 0,
    activeParameter: Math.min(activeParameter, entries.length - 1)
  };
}
