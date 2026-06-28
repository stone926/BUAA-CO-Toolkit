import {
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  Hover,
  Position,
  Range,
  SymbolKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition, lineAt, makeDiagnostic, rangeAtOffset } from '../common/lsp';

interface LogisimCircuit {
  name: string;
  range: Range;
  selectionRange: Range;
}

interface LogisimComponent {
  name: string;
  label?: string;
  range: Range;
  selectionRange: Range;
}

interface LogisimParseResult {
  circuits: LogisimCircuit[];
  components: LogisimComponent[];
  diagnostics: Diagnostic[];
}

export function getLogisimDiagnostics(document: TextDocument): Diagnostic[] {
  return parseLogisim(document).diagnostics;
}

export function getLogisimHover(document: TextDocument, position: Position): Hover | undefined {
  const parsed = parseLogisim(document);
  const circuit = parsed.circuits.find((item) => containsPosition(item.selectionRange, position));
  if (circuit) {
    return {
      contents: `Logisim circuit \`${circuit.name}\`.`
    };
  }
  const component = parsed.components.find((item) => containsPosition(item.selectionRange, position) || containsPosition(item.range, position));
  if (component) {
    return {
      contents: `Component \`${component.name}\`${component.label ? ` labeled \`${component.label}\`` : ''}.`
    };
  }
  return undefined;
}

export function getLogisimDocumentSymbols(document: TextDocument): DocumentSymbol[] {
  const parsed = parseLogisim(document);
  const symbols = parsed.circuits.map((circuit) => DocumentSymbol.create(circuit.name, 'circuit', SymbolKind.Module, circuit.range, circuit.selectionRange));
  for (const component of parsed.components) {
    symbols.push(DocumentSymbol.create(component.label ?? component.name, component.name, SymbolKind.Object, component.range, component.selectionRange));
  }
  return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
}

function parseLogisim(document: TextDocument): LogisimParseResult {
  const text = document.getText();
  const circuits: LogisimCircuit[] = [];
  const components: LogisimComponent[] = [];
  const diagnostics: Diagnostic[] = [];

  if (!/<project\b/.test(text)) {
    const firstLine = lineAt(document, 0).text;
    diagnostics.push(makeDiagnostic(Range.create(0, 0, 0, Math.max(1, firstLine.length)), 'This .circ file does not look like a Logisim project XML file.', DiagnosticSeverity.Warning, 'circ-project'));
  }
  if (/<comp\b/.test(text) && !/<comp\b[^>]*(?:\/>|>[\s\S]*?<\/comp>)/.test(text)) {
    diagnostics.push(makeDiagnostic(Range.create(0, 0, 0, Math.max(1, lineAt(document, 0).text.length)), 'This .circ file contains an incomplete component tag.', DiagnosticSeverity.Warning, 'circ-xml'));
  }

  const circuitRegex = /<circuit\b[^>]*\bname="([^"]+)"/g;
  let circuitMatch: RegExpExecArray | null;
  while ((circuitMatch = circuitRegex.exec(text))) {
    const name = circuitMatch[1];
    const offset = circuitMatch.index + circuitMatch[0].indexOf(name);
    circuits.push({
      name,
      range: rangeAtOffset(document, circuitMatch.index, circuitMatch[0].length),
      selectionRange: rangeAtOffset(document, offset, name.length)
    });
  }

  const componentRegex = /<comp\b[^>]*\bname="([^"]+)"[^>]*(?:\/>|>[\s\S]*?<\/comp>)/g;
  let componentMatch: RegExpExecArray | null;
  while ((componentMatch = componentRegex.exec(text))) {
    const block = componentMatch[0];
    const name = componentMatch[1];
    const labelMatch = block.match(/<a\b[^>]*\bname="label"[^>]*\bval="([^"]*)"/);
    const offset = componentMatch.index + componentMatch[0].indexOf(name);
    const component: LogisimComponent = {
      name,
      label: labelMatch?.[1],
      range: rangeAtOffset(document, componentMatch.index, block.length),
      selectionRange: rangeAtOffset(document, offset, name.length)
    };
    components.push(component);

    if (shouldLabelComponent(name) && !component.label) {
      diagnostics.push(makeDiagnostic(component.selectionRange, `Consider adding a label to ${name}; Logisim Logging is much easier to read with labels.`, DiagnosticSeverity.Information, 'missing-label'));
    }
    if ((name === 'ROM' || name === 'RAM' || name === 'Memory') && !/name="contents"/.test(block)) {
      diagnostics.push(makeDiagnostic(component.selectionRange, `${name} has no embedded contents. Remember to import a ROM file with 'v2.0 raw' when needed.`, DiagnosticSeverity.Information, 'memory-contents'));
    }
    if ((name === 'ROM' || name === 'RAM' || name === 'Memory') && (!/name="addrWidth"/.test(block) || !/name="dataWidth"/.test(block))) {
      diagnostics.push(makeDiagnostic(component.selectionRange, `${name} should declare addrWidth and dataWidth so course ROM injection can preserve the intended memory shape.`, DiagnosticSeverity.Information, 'memory-widths'));
    }
  }

  return {
    circuits,
    components,
    diagnostics
  };
}

function shouldLabelComponent(name: string): boolean {
  return ['Pin', 'Register', 'ROM', 'RAM', 'Memory', 'Counter'].includes(name);
}

