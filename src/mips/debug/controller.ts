// @index mips-debug — Workbench lifecycle: capture, shared assembly, Worker debugging and bounded view state
import * as path from 'path';
import type { ProgramImage, SourceUnit } from '../core/api';
import type { AssemblerDiagnostic } from '../core/assembler/diagnostics';
import type { AssemblerServiceResult } from '../core/assembler/assemblyService';
import type { DebugMode, DebugSnapshot } from '../core/debug/api';
import { DebugListing } from '../core/debug/listing';
import { isCourseProfile } from '../core/profiles/profileIds';
import { MarsDebugClient } from '../host/debugClient';
import type { MarsRuntimeHost } from '../host/marsService';
import type { captureAssemblyInput } from '../host/sourceInput';
import type { WorkbenchRequest, WorkbenchState } from './protocol';
import { initialWorkbenchState, projectSnapshot } from './state';

export interface WorkbenchControllerOptions {
  sourcePath: string;
  mode: DebugMode;
  ordinaryMode: Extract<DebugMode, { kind: 'mars' }>;
  runtime: MarsRuntimeHost;
  capture(): ReturnType<typeof captureAssemblyInput>;
  sourcesCurrent?(sources: readonly SourceUnit[]): Promise<boolean>;
  changed(state: WorkbenchState): void;
  diagnostics(items: readonly AssemblerDiagnostic[], sources: readonly SourceUnit[]): void;
}

export class MarsWorkbenchController {
  state: WorkbenchState;
  image?: ProgramImage;
  sources: readonly SourceUnit[] = [];
  private mode: DebugMode;
  private listing?: DebugListing;
  private client?: MarsDebugClient;
  private snapshot?: DebugSnapshot;
  private generation = 0;
  private assemblyAbort?: AbortController;
  private pendingInput?: (value: string | undefined) => void;
  private closed = false;
  private staleRevision = 0;

  constructor(private readonly options: WorkbenchControllerOptions) {
    this.mode = options.mode;
    this.state = initialWorkbenchState(path.basename(options.sourcePath), this.mode);
  }

  publish(): void { if (!this.closed) this.options.changed(this.state); }
  markSourceChanged(): void {
    this.staleRevision++;
    if (this.image || this.state.status === 'assembling') { this.state = { ...this.state, sourceChanged: true }; this.publish(); }
  }

  async handle(request: WorkbenchRequest): Promise<void> {
    if (this.closed) return;
    switch (request.type) {
      case 'ready': this.publish(); return;
      case 'assemble': await this.assemble(); return;
      case 'reset': if (this.image && !this.state.sourceChanged) this.start(); else await this.assemble(); return;
      case 'mode': {
        if (request.mode !== 'mars' && !isCourseProfile(request.mode)) return;
        this.stop(); this.image = undefined; this.listing = undefined; this.sources = [];
        this.mode = request.mode === 'mars' ? this.options.ordinaryMode : { kind: 'course', profile: request.mode };
        this.state = initialWorkbenchState(this.state.title, this.mode);
        this.options.diagnostics([], []); this.publish(); return;
      }
      case 'run': case 'step':
        if (this.state.sourceChanged) { this.state = { ...this.state, message: '源文件已修改，请先重新汇编。' }; this.publish(); return; }
        if (!this.image) { await this.assemble(); return; }
        if (this.state.status !== 'paused') return;
        this.client?.command({ kind: request.type === 'run' ? 'continue' : 'step' }); return;
      case 'pause': this.client?.command({ kind: 'pause' }); return;
      case 'stop': this.stop(); this.state = { ...this.state, status: 'stopped', inputPrompt: undefined, message: '已停止。点击「复位」从入口重新开始。' }; this.publish(); return;
      case 'clearConsole': this.state = { ...this.state, console: '' }; this.publish(); return;
      case 'input': case 'eof': {
        const input = this.pendingInput; this.pendingInput = undefined;
        if (!input) return;
        if (request.type === 'input') this.appendOutput(`${request.text}\n`);
        this.state = { ...this.state, status: 'running', inputPrompt: undefined };
        input(request.type === 'input' ? `${request.text}\n` : undefined); this.publish(); return;
      }
      case 'breakpoint': {
        if (!this.listing || this.listing.indexOfAddress(request.address) < 0) return;
        const addresses = new Set(this.state.breakpoints);
        if (addresses.has(request.address)) addresses.delete(request.address);
        else if (addresses.size < 4096) addresses.add(request.address);
        this.state = { ...this.state, breakpoints: [...addresses].sort((a, b) => a - b) };
        this.client?.command({ kind: 'set-breakpoints', addresses: this.state.breakpoints }); this.publish(); return;
      }
      case 'memory': this.client?.command({ kind: 'memory', address: request.address, words: 64 }); return;
      case 'listing': {
        const index = request.address === undefined ? request.offset : this.listing?.indexOfAddress(request.address) ?? -1;
        if (index >= 0) this.showListing(Math.floor(index / 256) * 256);
        this.publish(); return;
      }
    }
  }

  sourceAtAddress(address: number): { source: SourceUnit; line: number } | undefined {
    const location = this.listing?.sourceAtAddress(address);
    const source = location && this.sources.find(item => item.id === location.id);
    return source && location ? { source, line: location.line } : undefined;
  }

  async assemble(): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.image = undefined; this.listing = undefined; this.snapshot = undefined;
    this.state = { ...initialWorkbenchState(this.state.title, this.mode), status: 'assembling', message: '正在汇编源文件及 include…' };
    this.options.diagnostics([], []); this.publish();
    const abort = this.assemblyAbort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30_000);
    try {
      const revision = this.staleRevision;
      const input = await this.options.capture();
      if (generation !== this.generation || this.closed) return;
      this.sources = input.sources;
      const result = await this.options.runtime.runJob(this.mode.kind === 'mars'
        ? { kind: 'mars-assemble', payload: { ...input, memoryConfiguration: this.mode.memoryConfiguration, delayedBranching: this.mode.delayedBranching } }
        : { kind: 'assembler-assemble', payload: { ...input, profile: this.mode.profile } }, { signal: abort.signal });
      if (generation !== this.generation || this.closed) return;
      if (result.kind !== 'result' || !result.ok) throw new Error(abort.signal.aborted ? '汇编已取消或超过 30 秒' : result.kind === 'result' ? result.error : '汇编返回无效结果');
      const assembly = result.payload as AssemblerServiceResult;
      this.options.diagnostics(assembly.diagnostics, this.sources);
      if (!assembly.ok || !assembly.image) throw new Error(assembly.diagnostics.map(item => item.message).join('\n') || '汇编失败');
      const validationRevision = this.staleRevision;
      const sourcesCurrent = this.options.sourcesCurrent ? await this.options.sourcesCurrent(this.sources) : revision === this.staleRevision;
      if (generation !== this.generation || this.closed) return;
      this.image = assembly.image;
      this.listing = new DebugListing(this.image, this.sources, this.mode);
      this.state = { ...this.state, sourceChanged: !sourcesCurrent || validationRevision !== this.staleRevision, instructionCount: this.listing.count,
        symbols: this.image.symbols.filter(item => item.value !== undefined).slice(0, 4096)
          .map(item => ({ name: item.name, value: item.value!, segment: item.segment, kind: item.kind })) };
      this.start();
    } catch (error) {
      if (generation === this.generation && !this.closed) this.fail(error);
    } finally { clearTimeout(timeout); if (this.assemblyAbort === abort) this.assemblyAbort = undefined; }
  }

  dispose(): void { this.closed = true; this.stop(); }

  private start(): void {
    if (!this.image) return;
    this.stop(); const generation = this.generation;
    this.snapshot = undefined;
    this.state = { ...this.state, console: '', inputPrompt: undefined, steps: 0, status: 'assembling', message: '正在载入调试会话…' };
    this.publish();
    const client = this.client = new MarsDebugClient(this.options.runtime, this.options.sourcePath, {
      snapshot: snapshot => {
        if (generation !== this.generation || this.closed) return;
        const previousPc = this.snapshot?.pc;
        this.state = projectSnapshot(this.state, snapshot, this.snapshot); this.snapshot = snapshot;
        if (previousPc !== snapshot.pc) {
          const index = this.listing?.indexOfAddress(snapshot.pc) ?? -1;
          if (index >= 0) this.showListing(Math.floor(index / 256) * 256);
        }
        this.publish();
      },
      output: text => { if (generation === this.generation && !this.closed) this.appendOutput(text); },
      input: () => new Promise(resolve => {
        if (generation !== this.generation || this.closed) { resolve(undefined); return; }
        this.pendingInput = resolve;
        this.state = { ...this.state, status: 'input', inputPrompt: '程序正在等待输入，按 Enter 提交。', message: '等待控制台输入' };
        this.publish();
      })
    });
    void client.run({ image: this.image, mode: this.mode, maxSteps: 10_000_000,
      breakpoints: this.state.breakpoints, memory: { address: this.state.memoryAddress, words: 64 } })
      .catch(error => { if (generation === this.generation && !this.closed) this.fail(error); });
  }

  private stop(): void {
    this.generation++;
    this.assemblyAbort?.abort(); this.assemblyAbort = undefined;
    this.client?.dispose(); this.client = undefined;
    this.pendingInput?.(undefined); this.pendingInput = undefined;
  }
  private showListing(offset: number): void {
    if (!this.listing) return;
    const lastPage = Math.floor(Math.max(0, this.listing.count - 1) / 256) * 256;
    const start = Math.max(0, Math.min(offset, lastPage));
    this.state = { ...this.state, instructionOffset: start, instructions: this.listing.page(start, 256) };
  }
  private appendOutput(text: string): void {
    const output = this.state.console + text;
    this.state = { ...this.state, console: output.length > 65_536 ? `…（仅显示最近 64 KiB 输出）\n${output.slice(-65_536)}` : output };
    this.publish();
  }
  private fail(error: unknown): void {
    this.state = { ...this.state, status: 'error', inputPrompt: undefined, message: error instanceof Error ? error.message : String(error) };
    this.publish();
  }
}
