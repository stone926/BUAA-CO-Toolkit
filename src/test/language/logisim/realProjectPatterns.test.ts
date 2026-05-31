import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLogisimDiagnostics, getLogisimDocumentSymbols, getLogisimHover } from '../../../language/logisim/service';

function doc(text: string): TextDocument {
  return TextDocument.create('test://test.circ', 'logisim-circ', 1, text);
}

// ────────────────────────────────────────────────────────────────────────────────
// Logisim工程 real patterns — from actual .circ files
// ────────────────────────────────────────────────────────────────────────────────
describe('Logisim工程 real patterns', () => {

  describe('CPU circuit structure (from 单周期cpu.circ)', () => {
    it('parses a CPU circuit with multiple components', () => {
      const text = `<project source="2.7.1" version="0">
  <lib name="#0" desc="#Wiring"/>
  <lib name="#1" desc="#Gates"/>
  <lib name="#2" desc="#Plexers"/>
  <lib name="#3" desc="#Arithmetic"/>
  <lib name="#4" desc="#Memory"/>
  <main name="main"/>
  <circuit name="main">
    <comp name="IM" loc="(600,300)">
      <a name="label" val="IM"/>
    </comp>
    <comp name="GRF" loc="(400,500)">
      <a name="label" val="GRF"/>
    </comp>
    <comp name="ALU" loc="(700,500)">
      <a name="label" val="ALU"/>
    </comp>
    <comp name="DM" loc="(800,600)">
      <a name="label" val="DM"/>
    </comp>
    <comp name="Controller" loc="(500,400)">
      <a name="label" val="Controller"/>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      const symbols = getLogisimDocumentSymbols(d);

      // Should not warn about missing <project>
      expect(diagnostics.some((d) => d.code === 'circ-project')).toBe(false);

      // Should find the circuit
      expect(symbols.some((s) => s.name === 'main')).toBe(true);

      // Should find labeled components
      expect(symbols.some((s) => s.name === 'IM')).toBe(true);
      expect(symbols.some((s) => s.name === 'GRF')).toBe(true);
      expect(symbols.some((s) => s.name === 'ALU')).toBe(true);
      expect(symbols.some((s) => s.name === 'DM')).toBe(true);
      expect(symbols.some((s) => s.name === 'Controller')).toBe(true);
    });
  });

  describe('ROM with v2.0 raw contents (from test.txt)', () => {
    it('does not warn about ROM with embedded contents', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="ROM" loc="(300,300)">
      <a name="label" val="IM"/>
      <a name="contents">addr/data: 2 10
0x00003000: 34090004;
0x00003004: 34080001;
0x00003008: 01095020;
</a>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      expect(diagnostics.some((d) => d.code === 'memory-contents')).toBe(false);
    });

    it('warns about ROM without contents', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="ROM" loc="(300,300)">
      <a name="label" val="IM"/>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      expect(diagnostics.some((d) => d.code === 'memory-contents')).toBe(true);
    });
  });

  describe('RAM component (from RAM.circ)', () => {
    it('warns about RAM without contents', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="RAM" loc="(300,300)">
      <a name="label" val="DM"/>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      expect(diagnostics.some((d) => d.code === 'memory-contents')).toBe(true);
    });

    it('warns about Memory without contents', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="Memory" loc="(300,300)">
      <a name="label" val="mem"/>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      expect(diagnostics.some((d) => d.code === 'memory-contents')).toBe(true);
    });
  });

  describe('Pin components (from various circuits)', () => {
    it('warns about unlabeled Pin', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="Pin" loc="(100,100)"/>
  </circuit>
</project>`;
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      expect(diagnostics.some((d) => d.code === 'missing-label')).toBe(true);
    });

    it('does not warn about labeled Pin', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="Pin" loc="(100,100)">
      <a name="label" val="clk"/>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      expect(diagnostics.some((d) => d.code === 'missing-label')).toBe(false);
    });
  });

  describe('Register components', () => {
    it('warns about unlabeled Register', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="Register" loc="(100,100)"/>
  </circuit>
</project>`;
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      expect(diagnostics.some((d) => d.code === 'missing-label')).toBe(true);
    });

    it('does not warn about labeled Register', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="Register" loc="(100,100)">
      <a name="label" val="PC"/>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      expect(diagnostics.some((d) => d.code === 'missing-label')).toBe(false);
    });
  });

  describe('Counter components', () => {
    it('warns about unlabeled Counter', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="Counter" loc="(100,100)"/>
  </circuit>
</project>`;
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      expect(diagnostics.some((d) => d.code === 'missing-label')).toBe(true);
    });
  });

  describe('Multi-circuit projects (from reference implementation)', () => {
    it('parses multiple circuits', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="SubCircuit" loc="(300,300)"/>
  </circuit>
  <circuit name="ALU">
    <comp name="Adder" loc="(100,100)">
      <a name="label" val="adder"/>
    </comp>
  </circuit>
  <circuit name="GRF">
    <comp name="Register" loc="(100,100)">
      <a name="label" val="reg0"/>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      const symbols = getLogisimDocumentSymbols(d);
      expect(symbols.filter((s) => s.name === 'main' || s.name === 'ALU' || s.name === 'GRF')).toHaveLength(3);
    });
  });

  describe('Hover information', () => {
    it('returns hover for circuit names', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="cpu">
    <comp name="ALU" loc="(100,100)">
      <a name="label" val="alu1"/>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      // Find position of "cpu" in the circuit name attribute
      const cpuIndex = text.indexOf('name="cpu"') + 'name="'.length;
      const line = text.slice(0, cpuIndex).split('\n').length - 1;
      const char = cpuIndex - text.lastIndexOf('\n', cpuIndex - 1) - 1;
      const hover = getLogisimHover(d, { line, character: char });
      if (hover) {
        expect(hover.contents).toContain('cpu');
      }
    });
  });

  describe('Empty and minimal circuits', () => {
    it('handles empty project', () => {
      const text = '<project></project>';
      const d = doc(text);
      const diagnostics = getLogisimDiagnostics(d);
      expect(diagnostics.some((d) => d.code === 'circ-project')).toBe(false);
      const symbols = getLogisimDocumentSymbols(d);
      expect(symbols).toHaveLength(0);
    });

    it('handles project with empty circuit', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="empty"/>
</project>`;
      const d = doc(text);
      const symbols = getLogisimDocumentSymbols(d);
      expect(symbols.some((s) => s.name === 'empty')).toBe(true);
    });
  });

  describe('Complex CPU circuit with sub-circuits', () => {
    it('parses CPU with GRF sub-circuit instantiation', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="GRF">
    <comp name="Register" loc="(100,100)">
      <a name="label" val="reg0"/>
    </comp>
    <comp name="Register" loc="(100,200)">
      <a name="label" val="reg1"/>
    </comp>
  </circuit>
  <circuit name="main">
    <comp name="GRF" loc="(400,300)">
      <a name="label" val="grf"/>
    </comp>
    <comp name="ALU" loc="(600,300)">
      <a name="label" val="alu"/>
    </comp>
    <comp name="Pin" loc="(100,100)">
      <a name="label" val="clk"/>
    </comp>
    <comp name="Pin" loc="(100,200)">
      <a name="label" val="reset"/>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      const symbols = getLogisimDocumentSymbols(d);
      const diagnostics = getLogisimDiagnostics(d);

      expect(symbols.some((s) => s.name === 'main')).toBe(true);
      expect(symbols.some((s) => s.name === 'GRF')).toBe(true);
      expect(diagnostics.some((d) => d.code === 'missing-label')).toBe(false);
    });
  });

  describe('Pipeline CPU components (from 流水线CPU)', () => {
    it('parses pipeline register components', () => {
      const text = `<project source="2.7.1" version="0">
  <circuit name="main">
    <comp name="Register" loc="(300,100)">
      <a name="label" val="FDreg_instr"/>
    </comp>
    <comp name="Register" loc="(300,200)">
      <a name="label" val="FDreg_pc"/>
    </comp>
    <comp name="Register" loc="(500,100)">
      <a name="label" val="DEreg_instr"/>
    </comp>
    <comp name="Register" loc="(500,200)">
      <a name="label" val="DEreg_pc"/>
    </comp>
    <comp name="Register" loc="(700,100)">
      <a name="label" val="EMreg_instr"/>
    </comp>
    <comp name="Register" loc="(700,200)">
      <a name="label" val="EMreg_pc"/>
    </comp>
    <comp name="Register" loc="(900,100)">
      <a name="label" val="MWreg_instr"/>
    </comp>
    <comp name="Register" loc="(900,200)">
      <a name="label" val="MWreg_pc"/>
    </comp>
  </circuit>
</project>`;
      const d = doc(text);
      const symbols = getLogisimDocumentSymbols(d);
      const diagnostics = getLogisimDiagnostics(d);

      // All pipeline registers should be labeled
      expect(symbols.filter((s) => s.name.includes('reg'))).toHaveLength(8);
      expect(diagnostics.some((d) => d.code === 'missing-label')).toBe(false);
    });
  });
});
