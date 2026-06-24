import {
  Diagnostic,
  DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import {
  evalExpressionConstant,
  evalExpressionAstConstant,
  shouldReportWidthMismatch,
  widthOfDecl,
  widthOfExpression,
  widthOfExpressionAst
} from './expressions';
import {
  VerilogDecl,
  VerilogInstance,
  VerilogModule,
  VerilogPortConnection
} from './model';
import { parameterOverridesForInstance } from './parameterOverrides';

export interface InstanceConnectionDiagnosticOptions {
  checkPorts?: boolean;
  checkPortWidths?: boolean;
  checkMissingPorts?: boolean;
  checkParameters?: boolean;
  checkParameterWidths?: boolean;
}

export function collectInstanceConnectionDiagnostics(
  document: TextDocument,
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  diagnostics: Diagnostic[],
  options: InstanceConnectionDiagnosticOptions = {}
): void {
  const resolved = {
    checkPorts: options.checkPorts ?? true,
    checkPortWidths: options.checkPortWidths ?? true,
    checkMissingPorts: options.checkMissingPorts ?? true,
    checkParameters: options.checkParameters ?? true,
    checkParameterWidths: options.checkParameterWidths ?? true
  };

  if (resolved.checkParameters) {
    collectParameterConnectionDiagnostics(document, parentModule, instance, targetModule, diagnostics, resolved.checkParameterWidths);
  }
  if (resolved.checkPorts) {
    collectPortConnectionDiagnostics(document, parentModule, instance, targetModule, diagnostics, resolved.checkPortWidths, resolved.checkMissingPorts);
  }
}

function collectPortConnectionDiagnostics(
  document: TextDocument,
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  diagnostics: Diagnostic[],
  checkWidths: boolean,
  checkMissing: boolean
): void {
  const targetPorts = new Map(targetModule.ports.map((port) => [port.name, port]));
  const seenConnections = new Map<string, VerilogPortConnection>();
  for (const connection of instance.portConnections) {
    const targetPort = targetDeclForConnection(targetModule.ports, targetPorts, connection);
    if (connection.name) {
      const previous = seenConnections.get(connection.name);
      if (previous) {
        diagnostics.push(makeDiagnostic(connection.nameRange ?? connection.range, `Port '${connection.name}' is connected more than once.`, DiagnosticSeverity.Warning, 'duplicate-port-connection'));
        continue;
      }
      seenConnections.set(connection.name, connection);
      if (!targetPort) {
        diagnostics.push(makeDiagnostic(connection.nameRange ?? connection.range, `Module '${targetModule.name}' has no port named '${connection.name}'.`, DiagnosticSeverity.Error, 'unknown-port'));
        continue;
      }
    } else if (!targetPort) {
      diagnostics.push(makeDiagnostic(connection.range, `Module '${targetModule.name}' has only ${targetModule.ports.length} port(s); positional port connection ${connection.positionalIndex + 1} is out of range.`, DiagnosticSeverity.Error, 'port-index-out-of-range'));
      continue;
    }

    if (!checkWidths || !targetPort || !connection.expression.trim()) {
      continue;
    }
    const expected = widthOfDecl(targetPort, targetModule, parameterOverridesForInstance(instance, parentModule, targetModule));
    const actual = connection.expressionAst
      ? widthOfExpressionAst(connection.expressionAst, parentModule)
      : widthOfExpression(connection.expression, parentModule);
    if (shouldReportWidthMismatch(expected, actual)) {
      diagnostics.push(makeDiagnostic(
        connection.expressionRange,
        `Port '${targetPort.name}' is ${expected.width} bit(s), but this connection is ${actual.width} bit(s).`,
        DiagnosticSeverity.Warning,
        'port-width-mismatch'
      ));
    }
  }

  if (checkMissing && instance.portConnections.some((connection) => connection.name)) {
    for (const port of targetModule.ports) {
      if (!seenConnections.has(port.name) && shouldReportMissingPort(port)) {
        diagnostics.push(makeDiagnostic(instance.selectionRange, `Instance '${instance.instanceName}' does not connect port '${port.name}'.`, DiagnosticSeverity.Information, `missing-port:${port.name}`));
      }
    }
  }
}

function shouldReportMissingPort(port: VerilogDecl): boolean {
  return port.direction !== 'output' && port.direction !== 'inout';
}

function collectParameterConnectionDiagnostics(
  document: TextDocument,
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  diagnostics: Diagnostic[],
  checkWidths: boolean
): void {
  const targetParameters = new Map(targetModule.parameters.map((parameter) => [parameter.name, parameter]));
  const seenConnections = new Map<string, VerilogPortConnection>();
  for (const connection of instance.parameterConnections) {
    const targetParameter = targetDeclForConnection(targetModule.parameters, targetParameters, connection);
    if (connection.name) {
      const previous = seenConnections.get(connection.name);
      if (previous) {
        diagnostics.push(makeDiagnostic(connection.nameRange ?? connection.range, `Parameter '${connection.name}' is overridden more than once.`, DiagnosticSeverity.Warning, 'duplicate-parameter-connection'));
        continue;
      }
      seenConnections.set(connection.name, connection);
      if (!targetParameter) {
        diagnostics.push(makeDiagnostic(connection.nameRange ?? connection.range, `Module '${targetModule.name}' has no parameter named '${connection.name}'.`, DiagnosticSeverity.Error, 'unknown-parameter'));
        continue;
      }
    } else if (!targetParameter) {
      diagnostics.push(makeDiagnostic(connection.range, `Module '${targetModule.name}' has only ${targetModule.parameters.length} parameter(s); positional parameter override ${connection.positionalIndex + 1} is out of range.`, DiagnosticSeverity.Error, 'parameter-index-out-of-range'));
      continue;
    }

    if (!targetParameter || !connection.expression.trim()) {
      continue;
    }
    const value = connection.expressionAst
      ? evalExpressionAstConstant(connection.expressionAst, parentModule)
      : evalExpressionConstant(connection.expression, parentModule);
    if (value === undefined) {
      diagnostics.push(makeDiagnostic(
        connection.expressionRange,
        `Parameter '${targetParameter.name}' override must be a constant expression.`,
        DiagnosticSeverity.Warning,
        'parameter-not-constant'
      ));
    }
    if (!checkWidths) {
      continue;
    }
    const expected = widthOfDecl(targetParameter, targetModule);
    const actual = connection.expressionAst
      ? widthOfExpressionAst(connection.expressionAst, parentModule)
      : widthOfExpression(connection.expression, parentModule);
    if (shouldReportWidthMismatch(expected, actual)) {
      diagnostics.push(makeDiagnostic(
        connection.expressionRange,
        `Parameter '${targetParameter.name}' is ${expected.width} bit(s), but this override is ${actual.width} bit(s).`,
        DiagnosticSeverity.Warning,
        'parameter-width-mismatch'
      ));
    }
  }
}

function targetDeclForConnection(
  positionalDecls: VerilogDecl[],
  namedDecls: Map<string, VerilogDecl>,
  connection: VerilogPortConnection
): VerilogDecl | undefined {
  return connection.name
    ? namedDecls.get(connection.name)
    : positionalDecls[connection.positionalIndex];
}
