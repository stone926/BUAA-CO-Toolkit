// @index(Verilog inlay hint provider)
import { InlayHint, InlayHintKind, MarkupKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { getCachedVerilogParse } from './parseCache';
import { widthOfDecl } from './expressions';
import { parameterOverridesForInstance } from './parameterOverrides';
import {
  lineInRange,
  parameterConnectionTooltip,
  portConnectionTooltip,
  portDirectionLabel
} from './display';
import { resolveInstanceTargetModule } from './resolveSymbol';

export function getVerilogInlayHints(document: TextDocument, range: Range, settings: CoSettings, index: VerilogWorkspaceIndex): InlayHint[] {
  const hints: InlayHint[] = [];
  const parsed = getCachedVerilogParse(document, settings, false);
  for (const module of parsed.modules) {
    for (const instance of module.instances) {
      const target = resolveInstanceTargetModule(index, parsed.modules, instance);
      if (!target) {
        continue;
      }
      for (const connection of instance.portConnections) {
        const port = connection.name
          ? target.ports.find((item) => item.name === connection.name)
          : target.ports[connection.positionalIndex];
        if (!port) {
          continue;
        }
        const overrides = parameterOverridesForInstance(instance, module, target);
        const direction = portDirectionLabel(port);
        const effectiveWidth = widthOfDecl(port, target, overrides).width;
        const labelSuffix = effectiveWidth && effectiveWidth > 1 ? `${direction}[${effectiveWidth}]` : direction;
        const tooltip = {
          kind: MarkupKind.Markdown,
          value: portConnectionTooltip(module, instance, target, port, connection)
        };
        if (connection.nameRange && lineInRange(connection.nameRange.start.line, range)) {
          hints.push({
            position: connection.nameRange.end,
            label: `: ${labelSuffix}`,
            kind: InlayHintKind.Type,
            tooltip,
            paddingLeft: true
          });
        } else if (!connection.name && lineInRange(connection.expressionRange.start.line, range)) {
          hints.push({
            position: connection.expressionRange.start,
            label: `.${port.name}: ${labelSuffix}=`,
            kind: InlayHintKind.Parameter,
            tooltip,
            paddingRight: true
          });
        }
      }
      for (const connection of instance.parameterConnections) {
        const parameter = connection.name
          ? target.parameters.find((item) => item.name === connection.name)
          : target.parameters[connection.positionalIndex];
        if (!parameter) {
          continue;
        }
        const tooltip = {
          kind: MarkupKind.Markdown,
          value: parameterConnectionTooltip(module, instance, target, parameter, connection)
        };
        if (connection.nameRange && lineInRange(connection.nameRange.start.line, range)) {
          hints.push({
            position: connection.nameRange.end,
            label: ': param',
            kind: InlayHintKind.Type,
            tooltip,
            paddingLeft: true
          });
        } else if (!connection.name && lineInRange(connection.expressionRange.start.line, range)) {
          hints.push({
            position: connection.expressionRange.start,
            label: `.${parameter.name}=`,
            kind: InlayHintKind.Parameter,
            tooltip,
            paddingRight: true
          });
        }
      }
    }
  }
  return hints;
}
