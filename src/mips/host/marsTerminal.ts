// @index mips-host — 内部 MARS 伪终端：行输入、回显、EOF 与取消
import * as vscode from 'vscode';
import type { MarsConsole } from './marsIo';
import type { RunResult } from '../../types';

export class MarsTerminal implements vscode.Pseudoterminal, MarsConsole {
  private readonly writes = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writes.event;
  private readonly controller = new AbortController();
  private readonly lines: string[] = [];
  private queuedBytes = 0;
  private inputBytes = 0;
  private input = '';
  private pending?: (line: string | undefined) => void;
  private eof = false;
  private finished = false;
  constructor(private readonly run: (console: MarsConsole, signal: AbortSignal) => Promise<RunResult>) {}
  open(): void {
    void this.run(this, this.controller.signal).then((result) => {
      this.finished = true;
      this.write(`\n[${result.ok ? `程序结束，退出码 ${result.exitCode ?? 0}` : result.stderr}]\n`);
    }, (error: unknown) => {
      this.finished = true;
      this.write(`\n[运行失败：${error instanceof Error ? error.message : String(error)}]\n`);
    }).finally(() => { this.eof = true; this.pending?.(undefined); this.pending = undefined; });
  }
  close(): void {
    this.controller.abort(); this.eof = true; this.pending?.(undefined); this.pending = undefined; this.writes.dispose();
  }
  write(text: string): void { this.writes.fire(text.replace(/\r?\n/g, '\r\n')); }
  readLine = async (): Promise<string | undefined> => {
    if (this.lines.length) {
      const line = this.lines.shift()!;
      this.queuedBytes -= Buffer.byteLength(line, 'utf8');
      return line;
    }
    if (this.eof || this.controller.signal.aborted) return undefined;
    return new Promise<string | undefined>((resolve) => { this.pending = resolve; });
  };
  handleInput(data: string): void {
    if (this.finished || this.eof) return;
    for (const char of data.replace(/\r\n/g, '\r')) {
      if (char === '\x03') { this.write('^C\n'); this.controller.abort(); this.eof = true; this.pending?.(undefined); this.pending = undefined; return; }
      if (char === '\x04' || char === '\x1a') { this.eof = true; this.pending?.(undefined); this.pending = undefined; return; }
      if (char === '\r' || char === '\n') {
        if (!this.pending && (this.lines.length >= 1024 || this.queuedBytes + this.inputBytes + 1 > 1024 * 1024)) {
          this.write('\x07'); continue;
        }
        this.write('\n'); const line = this.input + '\n'; this.input = ''; this.inputBytes = 0;
        if (this.pending) { const resolve = this.pending; this.pending = undefined; resolve(line); }
        else { this.lines.push(line); this.queuedBytes += Buffer.byteLength(line, 'utf8'); }
      } else if (char === '\x7f' || char === '\b') {
        if (this.input) {
          const width = /[\uDC00-\uDFFF]$/.test(this.input) && this.input.length > 1 ? 2 : 1;
          this.inputBytes -= Buffer.byteLength(this.input.slice(-width), 'utf8');
          this.input = this.input.slice(0, -width); this.write('\b \b');
        }
      } else if (char >= ' ') {
        const bytes = Buffer.byteLength(char, 'utf8');
        if (this.queuedBytes + this.inputBytes + bytes >= 1024 * 1024 || this.lines.length >= 1024) continue;
        this.input += char; this.inputBytes += bytes; this.write(char);
      }
    }
  }
}
