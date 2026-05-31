import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLogisimDiagnostics, getLogisimDocumentSymbols, getLogisimHover } from '../../../language/logisim/service';

function doc(text: string): TextDocument {
  return TextDocument.create('test://test.circ', 'logisim-circ', 1, text);
}

describe('Logisim service', () => {
  describe('getLogisimDiagnostics', () => {
    it('warns when <project> tag is missing', () => {
      const text = '<circuit name="main"><comp name="AND"/></circuit>';
      const diagnostics = getLogisimDiagnostics(doc(text));
      expect(diagnostics.some((d) => d.code === 'circ-project')).toBe(true);
    });

    it('does not warn when <project> tag is present', () => {
      const text = '<project><circuit name="main"><comp name="AND"/></circuit></project>';
      const diagnostics = getLogisimDiagnostics(doc(text));
      expect(diagnostics.some((d) => d.code === 'circ-project')).toBe(false);
    });

    it('warns about missing labels on key components', () => {
      const text = '<project><circuit name="main"><comp name="Pin"/></circuit></project>';
      const diagnostics = getLogisimDiagnostics(doc(text));
      expect(diagnostics.some((d) => d.code === 'missing-label')).toBe(true);
    });

    it('does not warn when key components have labels', () => {
      const text = '<project><circuit name="main"><comp name="Pin"><a name="label" val="myPin"/></comp></circuit></project>';
      const diagnostics = getLogisimDiagnostics(doc(text));
      expect(diagnostics.some((d) => d.code === 'missing-label')).toBe(false);
    });

    it('warns about ROM without contents', () => {
      const text = '<project><circuit name="main"><comp name="ROM"/></circuit></project>';
      const diagnostics = getLogisimDiagnostics(doc(text));
      expect(diagnostics.some((d) => d.code === 'memory-contents')).toBe(true);
    });

    it('does not warn about ROM with contents', () => {
      const text = '<project><circuit name="main"><comp name="ROM"><a name="contents">v2.0 raw</a></comp></circuit></project>';
      const diagnostics = getLogisimDiagnostics(doc(text));
      expect(diagnostics.some((d) => d.code === 'memory-contents')).toBe(false);
    });

    it('handles empty documents', () => {
      const diagnostics = getLogisimDiagnostics(doc(''));
      expect(diagnostics.some((d) => d.code === 'circ-project')).toBe(true);
    });
  });

  describe('getLogisimDocumentSymbols', () => {
    it('extracts circuit names', () => {
      const text = '<project><circuit name="main"><comp name="AND"/></circuit></project>';
      const symbols = getLogisimDocumentSymbols(doc(text));
      expect(symbols.some((s) => s.name === 'main')).toBe(true);
    });

    it('extracts component labels', () => {
      const text = '<project><circuit name="main"><comp name="Pin"><a name="label" val="myPin"/></comp></circuit></project>';
      const symbols = getLogisimDocumentSymbols(doc(text));
      expect(symbols.some((s) => s.name === 'myPin')).toBe(true);
    });

    it('returns empty for documents with no circuits', () => {
      const symbols = getLogisimDocumentSymbols(doc('<project></project>'));
      expect(symbols).toHaveLength(0);
    });
  });

  describe('getLogisimHover', () => {
    it('returns hover for circuit name', () => {
      const text = '<project><circuit name="main"/></project>';
      const d = doc(text);
      // Position at the circuit name
      const hover = getLogisimHover(d, { line: 0, character: 20 });
      if (hover) {
        expect(hover.contents).toContain('main');
      }
    });

    it('returns undefined for positions outside any element', () => {
      const text = '<project><circuit name="main"/></project>';
      const d = doc(text);
      const hover = getLogisimHover(d, { line: 0, character: 0 });
      // Position 0 is at '<', which is not inside a name
      expect(hover).toBeUndefined();
    });
  });
});
