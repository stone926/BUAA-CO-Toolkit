import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { URI } from 'vscode-uri';
import { createDesignModuleLookup, workspaceTestbenchSources } from '../../waveform/host/designModules';
import { parseVcdBytes, parseVcdFile } from '../../waveform/host/waveformFileLoader';
import { loadTraceForVcd, traceFileForVcd, traceFromSimulationOutput } from '../../waveform/host/waveformTraceSource';
import { WaveformViewStateStore } from '../../waveform/host/waveformViewStateStore';
import { parseTimeScale } from '../../waveform/model/timeScale';
import type { VerilogModuleProvider } from '../../language/verilog/moduleProvider';

const ps = parseTimeScale('1ps')!;
const vcd = '$timescale 1ps $end\n$scope module tb $end\n$var reg 1 ! clk $end\n$enddefinitions $end\n#0\n0!\n#5\n1!\n#10\n0!\n';

const simulationOutput = [
  'Time scale of (tb) is 1ns / 1ps',
  'VCD info: dumpfile ../wave/tb.vcd opened for output.',
  '                  38@00003004: *00000000 <= 00000001',
  '                  42@00003000: $16 <= 00001040',
  '@00003008: $ 5 <= 00000002',
  'co_iverilog_watchdog.v:10: $finish called at 200000000 (1ps)'
].join('\n');

describe('trace pairing', () => {
  it('places course trace events on the dump time axis', () => {
    const trace = traceFromSimulationOutput(simulationOutput, 'TB.vcd', ps, 'tb.sim.out');
    expect(trace?.source).toBe('tb.sim.out');
    expect(trace?.events).toEqual([
      { time: 38_000, kind: 'dm', pc: '00003004', target: '00000000', value: '00000001' },
      { time: 42_000, kind: 'grf', pc: '00003000', target: '16', value: '00001040' }
    ]);
    expect(trace?.note).toContain('1 行');
  });

  it('refuses traces that did not write this dump or cannot be timed', () => {
    expect(traceFromSimulationOutput(simulationOutput, 'other.vcd', ps, 'x')).toBeUndefined();
    expect(traceFromSimulationOutput('no dump here\n38@00003004: $1 <= 00000001', 'tb.vcd', ps, 'x')).toBeUndefined();
    const untimed = traceFromSimulationOutput('VCD info: dumpfile tb.vcd opened for output.\n38@00003004: $1 <= 00000001', 'tb.vcd', ps, 'x');
    expect(untimed?.events).toEqual([]);
    expect(untimed?.note).toContain('$printtimescale');
    const p4 = traceFromSimulationOutput('Time scale of (tb) is 1ns / 1ps\nVCD info: dumpfile tb.vcd opened for output.\n@00003000: $1 <= 00000001', 'tb.vcd', ps, 'x');
    expect(p4?.events).toEqual([]);
    expect(p4?.note).toContain('P4');
  });

  describe('on disk', () => {
    let directory: string;
    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'co wave 波形-'));
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    it('reads the sibling .sim.out unless it predates the dump', async () => {
      const dump = path.join(directory, 'tb.vcd');
      fs.writeFileSync(dump, vcd);
      expect(traceFileForVcd(dump)).toBe(path.join(directory, 'tb.sim.out'));
      expect(await loadTraceForVcd(dump, ps)).toBeUndefined();
      fs.writeFileSync(traceFileForVcd(dump), simulationOutput);
      expect((await loadTraceForVcd(dump, ps))?.events).toHaveLength(2);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(traceFileForVcd(dump), old, old);
      expect(await loadTraceForVcd(dump, ps)).toBeUndefined();
    });

    it('streams files with progress and honours cancellation', async () => {
      const dump = path.join(directory, 'big.vcd');
      const body = Array.from({ length: 420_000 }, (_, index) => `#${index * 5}\n${index % 2}!\n`).join('');
      fs.writeFileSync(dump, vcd.replace(/#0[\s\S]*$/, '') + body);
      // > 4 MiB so at least one progress report is due.
      const progress: number[] = [];
      const data = await parseVcdFile(dump, { onProgress: (loaded) => progress.push(loaded) });
      expect(data.metadata.changeCount).toBe(420_000);
      expect(data.metadata.byteLength).toBe(fs.statSync(dump).size);
      expect(progress.length).toBeGreaterThan(0);
      const controller = new AbortController();
      controller.abort();
      await expect(parseVcdFile(dump, { signal: controller.signal })).rejects.toThrow();
      const fromBytes = await parseVcdBytes(fs.readFileSync(dump));
      expect(fromBytes.metadata.changeCount).toBe(420_000);
    });

    it('parses .co testbenches that the module registry skips', async () => {
      fs.mkdirSync(path.join(directory, '.co', 'tb'), { recursive: true });
      fs.mkdirSync(path.join(directory, '.co', 'isim'), { recursive: true });
      fs.writeFileSync(path.join(directory, '.co', 'tb', 'alu_tb.v'), 'module alu_tb; alu uut(); endmodule\n');
      fs.writeFileSync(path.join(directory, '.co', 'isim', 'co_generated_tb.v'), 'module gen_tb; endmodule\n');
      fs.writeFileSync(path.join(directory, '.co', 'isim', 'co_iverilog_watchdog.v'), 'module w; endmodule\n');
      const sources = await workspaceTestbenchSources(directory);
      expect(sources.map((file) => path.basename(file))).toEqual(['alu_tb.v', 'co_generated_tb.v']);
      const registry: VerilogModuleProvider = {
        scanning: false,
        getModule: (name) => (name === 'alu' ? { name: 'alu' } as ReturnType<VerilogModuleProvider['getModule']> : undefined),
        getModules: () => [],
        allModules: () => []
      };
      const lookup = await createDesignModuleLookup(registry, [...sources, path.join(directory, 'missing.v')]);
      expect(lookup('alu_tb')?.instances.map((instance) => instance.instanceName)).toEqual(['uut']);
      expect(lookup('alu_tb')?.uri).toBe(URI.file(sources[0]).toString());
      expect(lookup('alu')?.name).toBe('alu');
      expect(lookup('gen_tb')).toBeDefined();
      expect(lookup('nothing')).toBeUndefined();
    });
  });
});

describe('view state store', () => {
  class Memento {
    readonly values = new Map<string, unknown>();
    keys(): readonly string[] {
      return [...this.values.keys()];
    }
    get<T>(key: string, fallback?: T): T | undefined {
      return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined;
    }
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        this.values.delete(key);
      } else {
        this.values.set(key, value);
      }
    }
  }

  it('persists sanitized state per file and evicts the least recently used', async () => {
    const memento = new Memento();
    const store = new WaveformViewStateStore(memento as never);
    const uri = (name: string) => URI.file(path.join(os.tmpdir(), name));
    await store.save(uri('a.vcd') as never, { version: 1, rows: [{ kind: 'signal', path: 'tb.a' }], cursor: 3 });
    expect(store.load(uri('a.vcd') as never)).toEqual({ version: 1, rows: [{ kind: 'signal', path: 'tb.a' }], cursor: 3 });
    expect(store.load(uri('b.vcd') as never)).toBeUndefined();
    for (let index = 0; index < 70; index++) {
      await store.save(uri(`f${index}.vcd`) as never, { version: 1, rows: [] });
    }
    expect(store.load(uri('a.vcd') as never)).toBeUndefined();
    expect(store.load(uri('f69.vcd') as never)).toEqual({ version: 1, rows: [] });
    expect(memento.values.size).toBe(64 + 1);
    await store.save(uri('bad.vcd') as never, { version: 9 } as never);
    expect(store.load(uri('bad.vcd') as never)).toBeUndefined();
  });
});
