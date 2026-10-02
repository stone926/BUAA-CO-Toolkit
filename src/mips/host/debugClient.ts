// @index mips-host — Resumable debugger transport and ordinary syscall IO with bounded command queues
import * as path from 'path';
import type { DebugCommand, DebugSessionOptions, DebugSnapshot } from '../core/debug/api';
import type { MarsIoRequest, MarsIoResponse } from '../core/mars/api';
import { isDebugInspectionCommand, type DebugIoCommand } from './debugProtocol';
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
  private inspectionOnly = false;
  private pendingIo?: { id: number; response: Promise<{ response: MarsIoResponse } | { error: unknown }> };
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
    if (this.waiting && (!this.inspectionOnly || isDebugInspectionCommand(command))) {
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
            return this.respondToIo(item.request);
          }
          if (item.kind !== 'mars-debug' || !item.snapshot) throw new Error('Invalid debug snapshot');
          this.callbacks.snapshot(item.snapshot);
          if (item.snapshot.status === 'stopped') return undefined;
          if (this.abort.signal.aborted) return undefined;
          if (this.queue.length) return this.queue.shift();
          return await new Promise<DebugCommand | undefined>(resolve => {
            this.waiting = resolve;
            this.inspectionOnly = false;
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

  private async respondToIo(request: MarsIoRequest): Promise<MarsIoResponse | DebugIoCommand | undefined> {
    // Repeated progress snapshots describe the same suspended syscall. Its host
    // service runs once, even if inspection releases several Worker ACKs first.
    const pending = this.pendingIo ??= { id: request.id, response: this.io.respond(request).then(
      response => ({ response }), error => ({ error })) };
    if (pending.id !== request.id) throw new Error('Unexpected debugger IO request');
    const index = this.queue.findIndex(isDebugInspectionCommand);
    if (index >= 0) return { kind: 'mars-debug-command', command: this.queue.splice(index, 1)[0] as DebugIoCommand['command'] };
    let waiter!: (command: DebugCommand | undefined) => void;
    let received: DebugCommand | undefined;
    const command = new Promise<{ command: DebugCommand | undefined }>(resolve => {
      waiter = value => { received = value; resolve({ command: value }); };
      this.waiting = waiter;
      this.inspectionOnly = true;
    });
    const result = await Promise.race([pending.response, command]);
    if (this.waiting === waiter) this.waiting = undefined;
    // If input and a command settle in the same turn, honor the command before
    // returning the cached IO response on the next ACK instead of losing it.
    if (received || 'command' in result) {
      if (!received) return undefined;
      if (!isDebugInspectionCommand(received)) throw new Error('Invalid debugger IO inspection');
      return { kind: 'mars-debug-command', command: received };
    }
    this.pendingIo = undefined;
    if ('error' in result) throw result.error;
    return result.response;
  }

  private release(): void {
    if (this.timer) clearImmediate(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    this.waiting?.(undefined);
    this.waiting = undefined;
    this.pendingIo = undefined;
    this.inspectionOnly = false;
  }
}
