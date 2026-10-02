// @index mips-host — MARS 系统调用宿主：有界控制台输入输出、异步文件与时钟
import * as fs from 'fs/promises';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import type { MarsIoRequest, MarsIoResponse } from '../core/mars/api';

export interface MarsConsole {
  write(text: string): void | Promise<void>;
  /** A line including its line terminator, or undefined for EOF. */
  readLine?(): Promise<string | undefined>;
}

export class MarsHostIo {
  private readonly files = new Map<number, fs.FileHandle>();
  private nextFd = 3;
  private input: Buffer;
  private outputBytes = 0;
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');
  private disposed = false;
  constructor(private readonly options: {
    cwd: string; stdin?: string | Uint8Array; console: MarsConsole; signal: AbortSignal; maximumBytes?: number;
  }) { this.input = typeof options.stdin === 'string' ? Buffer.from(options.stdin, 'utf8') : Buffer.from(options.stdin ?? []); }

  async respond(request: MarsIoRequest): Promise<MarsIoResponse> {
    this.checkActive();
    const response: MarsIoResponse = { id: request.id };
    switch (request.kind) {
      case 'write': await this.write(this.stdoutDecoder.end()); await this.write(request.text); return response;
      case 'read-int': case 'read-float': case 'read-double': return { ...response, text: await this.line() ?? '' };
      case 'read-char': {
        await this.fill();
        const value = this.input.length ? this.input[0] : -1;
        this.input = this.input.subarray(1);
        return { ...response, value };
      }
      case 'read-string': return { ...response, text: await this.line() ?? '' };
      case 'open': {
        if (this.files.size >= 64 || ![0, 1, 9].includes(request.flags)) return { ...response, value: -1 };
        try {
          const file = await fs.open(path.resolve(this.options.cwd, request.path),
            request.flags === 0 ? 'r' : request.flags === 9 ? 'a' : 'w');
          if (this.disposed || this.options.signal.aborted) { await file.close(); this.checkActive(); }
          const fd = this.nextFd++;
          this.files.set(fd, file);
          return { ...response, value: fd };
        } catch { this.checkActive(); return { ...response, value: -1 }; }
      }
      case 'read-file': {
        this.checkLength(request.length);
        if (request.fd === 0) {
          if (request.length === 0) return { ...response, bytes: [] };
          await this.fill();
          const taken = this.input.subarray(0, request.length);
          this.input = this.input.subarray(taken.length);
          return { ...response, bytes: [...taken] };
        }
        const file = this.files.get(request.fd);
        if (!file) return { ...response, value: -1 };
        try {
          const buffer = Buffer.alloc(request.length);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          return { ...response, bytes: [...buffer.subarray(0, bytesRead)] };
        } catch { return { ...response, value: -1 }; }
      }
      case 'write-file': {
        this.checkLength(request.bytes.length);
        const bytes = Buffer.from(request.bytes);
        if (request.fd === 1 || request.fd === 2) {
          await this.write((request.fd === 1 ? this.stdoutDecoder : this.stderrDecoder).write(bytes));
          return { ...response, value: bytes.length };
        }
        const file = this.files.get(request.fd);
        if (!file) return { ...response, value: -1 };
        try {
          let written = 0;
          while (written < bytes.length) {
            this.checkActive();
            const result = await file.write(bytes, written, bytes.length - written, null);
            if (result.bytesWritten === 0) break;
            written += result.bytesWritten;
          }
          return { ...response, value: written };
        } catch { return { ...response, value: -1 }; }
      }
      case 'close': {
        const file = this.files.get(request.fd);
        this.files.delete(request.fd);
        await file?.close().catch(() => undefined);
        return response;
      }
      case 'time': return { ...response, time: Date.now() };
      case 'sleep': {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
          const timer = setTimeout(() => { this.options.signal.removeEventListener('abort', abort); resolve(); }, request.milliseconds);
          this.options.signal.addEventListener('abort', abort, { once: true });
          if (this.options.signal.aborted) abort();
        });
        return response;
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.files.values()].map((file) => file.close()));
    this.files.clear();
  }
  async finishOutput(): Promise<void> {
    await this.write(this.stdoutDecoder.end());
    await this.write(this.stderrDecoder.end());
  }
  private checkActive(): void {
    if (this.disposed || this.options.signal.aborted) throw new Error('cancelled');
  }
  private checkLength(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024) throw new Error('MARS I/O request exceeds 1 MiB');
  }
  private async write(text: string): Promise<void> {
    if (!text) return;
    this.outputBytes += Buffer.byteLength(text, 'utf8');
    if (this.outputBytes > (this.options.maximumBytes ?? 16 * 1024 * 1024)) throw new Error('MARS 输出超过 16 MiB 上限');
    await this.options.console.write(text);
  }
  private async fill(): Promise<void> {
    if (!this.input.length && this.options.stdin === undefined && this.options.console.readLine) {
      const signal = this.options.signal;
      let abort: () => void = () => undefined;
      try {
        const input = await Promise.race([
          this.options.console.readLine(),
          new Promise<never>((_, reject) => {
            abort = () => reject(new Error('cancelled'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          })
        ]) ?? '';
        this.input = Buffer.from(input, 'utf8');
      } finally { signal.removeEventListener('abort', abort); }
      this.checkActive();
      this.checkLength(this.input.length);
    }
  }
  private async line(): Promise<string | undefined> {
    await this.fill();
    if (!this.input.length) return undefined;
    const newline = this.input.indexOf(10);
    const end = newline < 0 ? this.input.length : newline + 1;
    const line = this.input.subarray(0, end).toString('utf8');
    this.input = this.input.subarray(end);
    return line.replace(/\r\n$/, '\n');
  }
}
