// @index mips-host — Resumable debugger transport and ordinary syscall IO with bounded command queues
import * as path from 'path';
import type { DebugCommand, DebugSessionOptions, DebugSnapshot } from '../core/debug/api';
import type { MarsIoRequest } from '../core/mars/api';
import { MarsHostIo } from './marsIo';
import type { MarsRuntimeHost } from './marsService';

export interface DebugClientCallbacks {
  snapshot(snapshot: DebugSnapshot): void;
  output(text: string): void;
  input(): Promise<string | undefined>;
}

/** One Worker job owns the machine until it exits; no replay is used for stepping. */
export class MarsDebugClient {
  private readonly abort = new AbortController();
  private readonly queue: DebugCommand[] = [];
  private waiting?: (command: DebugCommand | undefined) => void;
  private timer?: ReturnType<typeof setImmediate>;
  private readonly io: MarsHostIo;
  private finished = false;

  constructor(private readonly runtime: MarsRuntimeHost, sourcePath: string, private readonly callbacks: DebugClientCallbacks) {
    this.io = new MarsHostIo({
      cwd: path.dirname(sourcePath), signal: this.abort.signal,
      console: { write: text => callbacks.output(text), readLine: () => callbacks.input() }
    });
  }

  command(command: DebugCommand): void {
    if (this.finished || this.abort.signal.aborted) return;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      if (this.timer) clearImmediate(this.timer);
      this.timer = undefined;
      waiting(command);
      return;
    }
    // Latest memory/breakpoint/control intent wins, bounding rapid UI interaction.
    const group = (value: DebugCommand) => value.kind === 'memory' || value.kind === 'set-breakpoints' ? value.kind : 'execution';
    const index = this.queue.findIndex(item => group(item) === group(command));
    if (index >= 0) this.queue.splice(index, 1);
    this.queue.push(command);
  }

  async run(options: DebugSessionOptions): Promise<void> {
    try {
      const result = await this.runtime.runJob({ kind: 'mars-debug', payload: options }, {
        signal: this.abort.signal,
        onProgress: async batch => {
          if (this.abort.signal.aborted) return undefined;
          if (batch.length !== 1 || !batch[0] || typeof batch[0] !== 'object') throw new Error('Invalid debug progress');
          const item = batch[0] as { kind: string; snapshot?: DebugSnapshot; request?: MarsIoRequest };
          if (item.kind === 'mars-io' && item.request) {
            if (item.snapshot) this.callbacks.snapshot(item.snapshot);
            return this.io.respond(item.request);
          }
          if (item.kind !== 'mars-debug' || !item.snapshot) throw new Error('Invalid debug snapshot');
          this.callbacks.snapshot(item.snapshot);
          if (item.snapshot.status === 'stopped') return undefined;
          if (this.abort.signal.aborted) return undefined;
          if (this.queue.length) return this.queue.shift();
          return await new Promise<DebugCommand | undefined>(resolve => {
            this.waiting = resolve;
            if (item.snapshot!.status === 'running') {
              // Yield for control events; the view independently coalesces rendering.
              this.timer = setImmediate(() => { this.waiting = undefined; this.timer = undefined; resolve(undefined); });
            }
          });
        }
      });
      if (result.kind !== 'result' || !result.ok) {
        if (!this.abort.signal.aborted) throw new Error(result.kind === 'result' ? result.error : 'Invalid debug result');
      }
    } finally {
      this.finished = true;
      this.release();
      await this.io.finishOutput().catch(() => undefined);
      await this.io.dispose();
    }
  }

  dispose(): void { this.abort.abort(); this.release(); }

  private release(): void {
    if (this.timer) clearImmediate(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    this.waiting?.(undefined);
    this.waiting = undefined;
  }
}
