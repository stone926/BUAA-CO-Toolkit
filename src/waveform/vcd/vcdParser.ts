// @index waveform-vcd — 流式 VCD 词法/语法状态机：跨 chunk 分词、头部命令、值变化与注释块，事件交给 VcdHandler

/** Receiver of parsed VCD content; ids are the dump's identifier codes. */
export interface VcdHandler {
  headerCommand(command: string, body: readonly string[]): void;
  endDefinitions(): void;
  time(value: number): void;
  /** Vector (or scalar, as a one-character vector) value: `bits[start..end)` holds 0/1/x/z-like characters. */
  vector(id: string, bits: Uint8Array, start: number, end: number): void;
  real(id: string, value: number): void;
  text(id: string, value: string): void;
  diagnostic(message: string): void;
}

export interface VcdParseSummary {
  /** Input ended inside the header, inside a command, or between a value and its id. */
  readonly incomplete: boolean;
  readonly headerComplete: boolean;
}

const enum PendingValue {
  None,
  Vector,
  Real,
  Text
}

const maximumReportedTokenErrors = 5;
const utf8 = new TextDecoder('utf-8');

/**
 * Incremental VCD parser. Feed arbitrary byte chunks with `push`, then call `end`.
 * Tokens may straddle chunk boundaries; whitespace (any byte ≤ 0x20) separates tokens.
 */
export class VcdParser {
  private token = new Uint8Array(256);
  private tokenLength = 0;
  private inHeader = true;
  private headerCommand: string | undefined;
  private headerBody: string[] = [];
  private skippingCommand = false;
  private pending = PendingValue.None;
  private pendingBytes = new Uint8Array(256);
  private pendingLength = 0;
  private tokenErrors = 0;
  private finished = false;

  constructor(private readonly handler: VcdHandler) {}

  push(chunk: Uint8Array): void {
    if (this.finished) {
      throw new Error('VcdParser.push called after end');
    }
    let token = this.token;
    let length = this.tokenLength;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (byte <= 0x20) {
        if (length > 0) {
          this.tokenLength = length;
          this.dispatch();
          length = 0;
          token = this.token;
        }
        continue;
      }
      if (length === token.length) {
        this.tokenLength = length;
        this.growToken();
        token = this.token;
      }
      token[length++] = byte;
    }
    this.tokenLength = length;
  }

  end(): VcdParseSummary {
    if (!this.finished) {
      if (this.tokenLength > 0) {
        this.dispatch();
      }
      this.finished = true;
    }
    return {
      incomplete: this.inHeader || this.headerCommand !== undefined || this.skippingCommand || this.pending !== PendingValue.None,
      headerComplete: !this.inHeader
    };
  }

  private growToken(): void {
    const next = new Uint8Array(this.token.length * 2);
    next.set(this.token);
    this.token = next;
  }

  private dispatch(): void {
    const length = this.tokenLength;
    this.tokenLength = 0;
    if (this.inHeader) {
      this.headerToken(utf8.decode(this.token.subarray(0, length)));
      return;
    }
    this.bodyToken(length);
  }

  private headerToken(text: string): void {
    if (this.headerCommand === undefined) {
      if (text.startsWith('$') && text !== '$end') {
        this.headerCommand = text;
        this.headerBody = [];
      } else {
        this.reportToken(`头部出现意外内容 “${truncate(text)}”`);
      }
      return;
    }
    if (text !== '$end') {
      this.headerBody.push(text);
      return;
    }
    const command = this.headerCommand;
    const body = this.headerBody;
    this.headerCommand = undefined;
    this.headerBody = [];
    if (command === '$enddefinitions') {
      this.inHeader = false;
      this.handler.endDefinitions();
      return;
    }
    this.handler.headerCommand(command, body);
  }

  private bodyToken(length: number): void {
    const token = this.token;
    if (this.skippingCommand) {
      if (isEndKeyword(token, length)) {
        this.skippingCommand = false;
      }
      return;
    }
    if (this.pending !== PendingValue.None) {
      this.completePending(latin1(token, 0, length));
      return;
    }
    const first = token[0];
    switch (first) {
      case 0x23: { // '#'
        const time = this.parseTime(token, length);
        if (!Number.isNaN(time)) {
          this.handler.time(time);
        }
        return;
      }
      case 0x24: // '$'
        this.keyword(latin1(token, 0, length));
        return;
      case 0x62: // 'b'
      case 0x42: // 'B'
        this.beginPending(PendingValue.Vector, token, 1, length);
        return;
      case 0x72: // 'r'
      case 0x52: // 'R'
        this.beginPending(PendingValue.Real, token, 1, length);
        return;
      case 0x73: // 's'
      case 0x53: // 'S'
        this.beginPending(PendingValue.Text, token, 1, length);
        return;
      default:
        if (isScalarLevel(first)) {
          if (length === 1) {
            // Tolerate a writer that separates the scalar from its id.
            this.beginPending(PendingValue.Vector, token, 0, 1);
            return;
          }
          this.handler.vector(latin1(token, 1, length), token, 0, 1);
          return;
        }
        this.reportToken(`无法识别的值变化 “${truncate(latin1(token, 0, length))}”`);
    }
  }

  private keyword(text: string): void {
    switch (text) {
      case '$dumpvars':
      case '$dumpall':
      case '$dumpon':
      case '$dumpoff':
      case '$end':
        return;
      default:
        // $comment and any unexpected command are skipped up to their $end.
        this.skippingCommand = true;
    }
  }

  private beginPending(kind: PendingValue, token: Uint8Array, start: number, end: number): void {
    const length = end - start;
    if (length > this.pendingBytes.length) {
      this.pendingBytes = new Uint8Array(Math.max(length, this.pendingBytes.length * 2));
    }
    this.pendingBytes.set(token.subarray(start, end));
    this.pendingLength = length;
    this.pending = kind;
  }

  private completePending(id: string): void {
    const kind = this.pending;
    this.pending = PendingValue.None;
    const bytes = this.pendingBytes;
    const length = this.pendingLength;
    switch (kind) {
      case PendingValue.Vector:
        this.handler.vector(id, bytes, 0, length);
        return;
      case PendingValue.Real: {
        const value = Number(latin1(bytes, 0, length));
        if (Number.isNaN(value) && latin1(bytes, 0, length).toLowerCase() !== 'nan') {
          this.reportToken(`无法解析实数值 “${truncate(latin1(bytes, 0, length))}”`);
          return;
        }
        this.handler.real(id, value);
        return;
      }
      case PendingValue.Text:
        this.handler.text(id, utf8.decode(bytes.subarray(0, length)));
        return;
      default:
        return;
    }
  }

  private parseTime(token: Uint8Array, length: number): number {
    let value = 0;
    for (let index = 1; index < length; index++) {
      const digit = token[index] - 0x30;
      if (digit < 0 || digit > 9) {
        this.reportToken(`无法解析时间 “${truncate(latin1(token, 0, length))}”`);
        return Number.NaN;
      }
      value = value * 10 + digit;
    }
    if (length === 1) {
      this.reportToken('时间戳缺少数值');
      return Number.NaN;
    }
    return value;
  }

  private reportToken(message: string): void {
    this.tokenErrors++;
    if (this.tokenErrors <= maximumReportedTokenErrors) {
      this.handler.diagnostic(message);
    } else if (this.tokenErrors === maximumReportedTokenErrors + 1) {
      this.handler.diagnostic('更多无法识别的内容已省略');
    }
  }
}

function isScalarLevel(byte: number): boolean {
  switch (byte) {
    case 0x30: case 0x31: // 0 1
    case 0x78: case 0x58: // x X
    case 0x7a: case 0x5a: // z Z
    case 0x75: case 0x55: // u U
    case 0x77: case 0x57: // w W
    case 0x6c: case 0x4c: // l L
    case 0x68: case 0x48: // h H
    case 0x2d: // -
      return true;
    default:
      return false;
  }
}

function isEndKeyword(token: Uint8Array, length: number): boolean {
  return length === 4 && token[0] === 0x24 && token[1] === 0x65 && token[2] === 0x6e && token[3] === 0x64;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  if (end - start === 1) {
    return String.fromCharCode(bytes[start]);
  }
  let text = '';
  for (let index = start; index < end; index++) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

function truncate(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
