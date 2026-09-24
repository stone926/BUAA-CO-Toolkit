// @index waveform-builder — VcdHandler 实现：scope 按完整路径合并、var/别名 track、值去重与同刻覆盖，最终打包为列式 WaveformData

import { defaultTimeScale, parseTimeScale, TimeScale } from '../model/timeScale';
import {
  TrackEncoding,
  WaveDiagnostic,
  WaveformData,
  WaveScope,
  WaveTracks,
  WaveVar
} from '../model/waveformData';
import type { VcdHandler, VcdParseSummary } from './vcdParser';

/** Upper bound on stored value changes; beyond it recording stops with a warning. */
export const defaultMaximumChanges = 16_000_000;
const maximumDiagnostics = 50;
const discardedTrack = -1;

export interface WaveformBuilderOptions {
  maximumChanges?: number;
}

class GrowableFloat64 {
  data: Float64Array;
  length = 0;
  constructor(capacity: number) {
    this.data = new Float64Array(capacity);
  }
  push(value: number): void {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = value;
  }
}

class GrowableUint32 {
  data: Uint32Array;
  length = 0;
  constructor(capacity: number) {
    this.data = new Uint32Array(capacity);
  }
  reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed > this.data.length) {
      let capacity = this.data.length * 2;
      while (capacity < needed) {
        capacity *= 2;
      }
      const next = new Uint32Array(capacity);
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
  }
}

class TrackBuilder {
  readonly words: number;
  readonly times = new GrowableFloat64(8);
  readonly aval: GrowableUint32;
  bval: GrowableUint32 | undefined;
  reals: GrowableFloat64 | undefined;
  texts: string[] | undefined;
  count = 0;

  constructor(readonly width: number, readonly encoding: TrackEncoding) {
    this.words = encoding === TrackEncoding.Bits ? Math.max(1, Math.ceil(width / 32)) : 0;
    this.aval = new GrowableUint32(encoding === TrackEncoding.Bits ? 8 * this.words : 0);
    if (encoding === TrackEncoding.Real) {
      this.reals = new GrowableFloat64(8);
    } else if (encoding === TrackEncoding.Text) {
      this.texts = [];
    }
  }

  get lastTime(): number {
    return this.times.data[this.count - 1];
  }

  /** Append a bit value; returns the change-count delta (−1, 0 or +1). */
  appendBits(time: number, a: Uint32Array, b: Uint32Array, hasUnknown: boolean): number {
    const words = this.words;
    if (this.count > 0) {
      const last = (this.count - 1) * words;
      if (this.bitsEqualAt(last, a, b, hasUnknown)) {
        return 0;
      }
      if (this.lastTime === time) {
        this.writeBits(last, a, b, hasUnknown);
        if (this.count > 1 && this.bitsEqualAt(last - words, a, b, hasUnknown)) {
          this.pop();
          return -1;
        }
        return 0;
      }
    }
    this.times.push(time);
    this.aval.reserve(words);
    this.aval.length += words;
    if (hasUnknown && !this.bval) {
      this.bval = new GrowableUint32(Math.max(8 * words, this.aval.data.length));
      this.bval.length = this.aval.length - words;
    }
    if (this.bval) {
      this.bval.reserve(words);
      this.bval.length += words;
    }
    this.writeBits(this.count * words, a, b, hasUnknown);
    this.count++;
    return 1;
  }

  appendReal(time: number, value: number): number {
    const reals = this.reals!;
    if (this.count > 0) {
      const last = reals.data[this.count - 1];
      if (Object.is(last, value)) {
        return 0;
      }
      if (this.lastTime === time) {
        reals.data[this.count - 1] = value;
        if (this.count > 1 && Object.is(reals.data[this.count - 2], value)) {
          this.pop();
          return -1;
        }
        return 0;
      }
    }
    this.times.push(time);
    reals.push(value);
    this.count++;
    return 1;
  }

  appendText(time: number, value: string): number {
    const texts = this.texts!;
    if (this.count > 0) {
      if (texts[this.count - 1] === value) {
        return 0;
      }
      if (this.lastTime === time) {
        texts[this.count - 1] = value;
        if (this.count > 1 && texts[this.count - 2] === value) {
          this.pop();
          return -1;
        }
        return 0;
      }
    }
    this.times.push(time);
    texts.push(value);
    this.count++;
    return 1;
  }

  private pop(): void {
    this.count--;
    this.times.length--;
    if (this.encoding === TrackEncoding.Bits) {
      this.aval.length -= this.words;
      if (this.bval) {
        this.bval.length -= this.words;
      }
    } else if (this.reals) {
      this.reals.length--;
    } else if (this.texts) {
      this.texts.length--;
    }
  }

  private bitsEqualAt(offset: number, a: Uint32Array, b: Uint32Array, hasUnknown: boolean): boolean {
    const aval = this.aval.data;
    const bval = this.bval?.data;
    for (let word = 0; word < this.words; word++) {
      if (aval[offset + word] !== a[word]) {
        return false;
      }
      const storedB = bval ? bval[offset + word] : 0;
      if (storedB !== (hasUnknown ? b[word] : 0)) {
        return false;
      }
    }
    return true;
  }

  private writeBits(offset: number, a: Uint32Array, b: Uint32Array, hasUnknown: boolean): void {
    if (hasUnknown && !this.bval) {
      this.bval = new GrowableUint32(Math.max(8 * this.words, this.aval.data.length));
      this.bval.length = this.aval.length;
    }
    for (let word = 0; word < this.words; word++) {
      this.aval.data[offset + word] = a[word];
      if (this.bval) {
        this.bval.data[offset + word] = hasUnknown ? b[word] : 0;
      }
    }
  }
}

interface VarReference {
  name: string;
  range?: string;
  msb?: number;
  lsb?: number;
}

/** Builds a WaveformData model from VCD parser events. */
export class WaveformBuilder implements VcdHandler {
  private readonly scopes: WaveScope[] = [];
  private readonly scopeByPath = new Map<string, number>();
  private readonly scopeStack: number[] = [];
  private readonly vars: WaveVar[] = [];
  private readonly varPaths = new Set<string>();
  private readonly trackById = new Map<string, number>();
  private readonly tracks: TrackBuilder[] = [];
  private readonly diagnostics: WaveDiagnostic[] = [];
  private readonly unknownIds = new Set<string>();
  private readonly maximumChanges: number;
  private timescale: TimeScale = defaultTimeScale;
  private timescaleSeen = false;
  private date: string | undefined;
  private version: string | undefined;
  private currentTime = 0;
  private startTime: number | undefined;
  private changeCount = 0;
  private limitReached = false;
  private backwardsTimeReported = false;
  private scratchA = new Uint32Array(1);
  private scratchB = new Uint32Array(1);

  constructor(options: WaveformBuilderOptions = {}) {
    this.maximumChanges = options.maximumChanges ?? defaultMaximumChanges;
  }

  headerCommand(command: string, body: readonly string[]): void {
    switch (command) {
      case '$date':
        this.date = body.join(' ');
        return;
      case '$version':
        this.version = body.join(' ');
        return;
      case '$timescale': {
        const parsed = parseTimeScale(body.join(''));
        if (parsed) {
          this.timescale = parsed;
          this.timescaleSeen = true;
        } else {
          this.warn(`无法识别的 $timescale “${body.join(' ')}”，按 1ps 处理`);
        }
        return;
      }
      case '$scope':
        this.enterScope(body[0] ?? 'module', body[1] ?? body[0] ?? '?');
        return;
      case '$upscope':
        if (this.scopeStack.length === 0) {
          this.warn('多余的 $upscope 已忽略');
        } else {
          this.scopeStack.pop();
        }
        return;
      case '$var':
        this.declareVar(body);
        return;
      default:
        // $comment and vendor extensions carry no model information.
        return;
    }
  }

  endDefinitions(): void {
    if (this.scopeStack.length > 0) {
      this.warn('头部结束时仍有未关闭的 $scope');
      this.scopeStack.length = 0;
    }
    if (!this.timescaleSeen) {
      this.warn('缺少 $timescale，按 1ps 处理');
    }
  }

  time(value: number): void {
    if (value < this.currentTime) {
      if (!this.backwardsTimeReported) {
        this.backwardsTimeReported = true;
        this.warn(`时间戳倒退（#${value} 早于 #${this.currentTime}），后续变化按当前时刻记录`);
      }
      return;
    }
    if (!Number.isSafeInteger(value)) {
      this.warn(`时间戳 #${value} 超出精确整数范围，后续内容已忽略`);
      this.limitReached = true;
      return;
    }
    this.currentTime = value;
    this.startTime ??= value;
  }

  vector(id: string, bits: Uint8Array, start: number, end: number): void {
    const track = this.lookup(id);
    if (track < 0 || this.limitReached) {
      return;
    }
    const builder = this.tracks[track];
    if (builder.encoding !== TrackEncoding.Bits) {
      this.warnOnce(`type:${id}`, `信号 ${id} 的值类型与声明不符，已忽略`);
      return;
    }
    const hasUnknown = this.decodeBits(builder.width, builder.words, bits, start, end);
    this.record(builder.appendBits(this.currentTime, this.scratchA, this.scratchB, hasUnknown));
  }

  real(id: string, value: number): void {
    const track = this.lookup(id);
    if (track < 0 || this.limitReached) {
      return;
    }
    const builder = this.tracks[track];
    if (builder.encoding !== TrackEncoding.Real) {
      this.warnOnce(`type:${id}`, `信号 ${id} 的值类型与声明不符，已忽略`);
      return;
    }
    this.record(builder.appendReal(this.currentTime, value));
  }

  text(id: string, value: string): void {
    const track = this.lookup(id);
    if (track < 0 || this.limitReached) {
      return;
    }
    const builder = this.tracks[track];
    if (builder.encoding !== TrackEncoding.Text) {
      this.warnOnce(`type:${id}`, `信号 ${id} 的值类型与声明不符，已忽略`);
      return;
    }
    this.record(builder.appendText(this.currentTime, value));
  }

  diagnostic(message: string): void {
    this.warn(message);
  }

  build(summary: VcdParseSummary, byteLength: number): WaveformData {
    if (!summary.headerComplete) {
      this.warn('文件在头部定义结束前截止（$enddefinitions 缺失）');
    } else if (summary.incomplete) {
      this.warn('文件末尾不完整，可能仍在写入；最后一个值变化已忽略');
    }
    const tracks = this.packTracks();
    let endTime = this.currentTime;
    for (let track = 0; track < tracks.count; track++) {
      const last = tracks.changeStart[track + 1] - 1;
      if (last >= tracks.changeStart[track] && tracks.times[last] > endTime) {
        endTime = tracks.times[last];
      }
    }
    let startTime = this.startTime ?? this.currentTime;
    for (let track = 0; track < tracks.count; track++) {
      const first = tracks.changeStart[track];
      if (first < tracks.changeStart[track + 1] && tracks.times[first] < startTime) {
        startTime = tracks.times[first];
      }
    }
    return {
      timescale: this.timescale,
      startTime,
      endTime,
      scopes: this.scopes,
      vars: this.vars,
      tracks,
      diagnostics: this.diagnostics,
      metadata: {
        ...(this.date ? { date: this.date } : {}),
        ...(this.version ? { version: this.version } : {}),
        byteLength,
        changeCount: tracks.times.length,
        incomplete: summary.incomplete
      }
    };
  }

  private enterScope(kind: string, name: string): void {
    const parent = this.scopeStack.length ? this.scopeStack[this.scopeStack.length - 1] : -1;
    const cleanName = unescapeIdentifier(name);
    const path = parent < 0 ? cleanName : `${this.scopes[parent].path}.${cleanName}`;
    let index = this.scopeByPath.get(path);
    if (index === undefined) {
      index = this.scopes.length;
      this.scopes.push({ name: cleanName, kind, parent, path });
      this.scopeByPath.set(path, index);
    }
    this.scopeStack.push(index);
  }

  private declareVar(body: readonly string[]): void {
    if (body.length < 4) {
      this.warn(`无法解析的 $var 声明 “${body.join(' ')}”`);
      return;
    }
    const [kind, sizeText, id, ...referenceTokens] = body;
    const scope = this.scopeStack.length ? this.scopeStack[this.scopeStack.length - 1] : -1;
    if (scope < 0) {
      this.warn(`$var ${referenceTokens.join(' ')} 不在任何 $scope 内，已忽略`);
      return;
    }
    const reference = parseReference(referenceTokens);
    const encoding = kind === 'real' || kind === 'realtime' || kind === 'shortreal'
      ? TrackEncoding.Real
      : kind === 'string' ? TrackEncoding.Text : TrackEncoding.Bits;
    let width = Number.parseInt(sizeText, 10);
    if (!Number.isSafeInteger(width) || width <= 0) {
      width = reference.msb !== undefined && reference.lsb !== undefined
        ? Math.abs(reference.msb - reference.lsb) + 1
        : 1;
    }
    const scopePath = this.scopes[scope].path;
    let path = `${scopePath}.${reference.name}`;
    if (reference.range && !reference.range.includes(':') && !reference.name.endsWith(']')) {
      // Bit-blasted dumps declare each bit as `name [i]`.
      path = `${path}${reference.range}`;
    }
    if (this.varPaths.has(path)) {
      // Repeated $dumpvars coverage or duplicate scope blocks: keep the first declaration.
      if (!this.trackById.has(id)) {
        this.trackById.set(id, discardedTrack);
      }
      return;
    }
    let track = this.trackById.get(id);
    if (track === undefined || track === discardedTrack) {
      track = this.tracks.length;
      this.tracks.push(new TrackBuilder(encoding === TrackEncoding.Real ? 64 : width, encoding));
      this.trackById.set(id, track);
    } else if (this.tracks[track].encoding !== encoding || this.tracks[track].width !== width) {
      this.warn(`别名信号 ${path} 与同 id 的其他信号类型或位宽不同，按首次声明显示`);
      width = this.tracks[track].width;
    }
    this.varPaths.add(path);
    this.vars.push({
      name: reference.name,
      path,
      scope,
      kind,
      width: encoding === TrackEncoding.Bits ? width : this.tracks[track].width,
      ...(reference.range ? { range: reference.range } : {}),
      ...(reference.msb !== undefined ? { msb: reference.msb } : {}),
      ...(reference.lsb !== undefined ? { lsb: reference.lsb } : {}),
      track
    });
  }

  private lookup(id: string): number {
    const track = this.trackById.get(id);
    if (track !== undefined) {
      return track;
    }
    if (!this.unknownIds.has(id)) {
      this.unknownIds.add(id);
      if (this.unknownIds.size <= 5) {
        this.warn(`值变化引用了未声明的 id “${id}”，已忽略`);
      }
    }
    return discardedTrack;
  }

  /**
   * Decode `bits` into scratch aval/bval words, left-extending short values per
   * IEEE 1364 (a leading x or z extends with itself, otherwise with 0). Characters
   * beyond the declared width are dropped from the most significant end.
   */
  private decodeBits(width: number, words: number, bits: Uint8Array, start: number, end: number): boolean {
    if (this.scratchA.length < words) {
      this.scratchA = new Uint32Array(words);
      this.scratchB = new Uint32Array(words);
    }
    const a = this.scratchA;
    const b = this.scratchB;
    const given = end - start;
    if (given > width) {
      this.warnOnce(`wide:${width}`, `有值变化的位数超过其 ${width} 位声明，高位已截断`);
    }
    const used = Math.min(given, width);
    const first = given > 0 ? levelOf(bits[start]) : 0;
    if (width <= 32) {
      let av = 0;
      let bv = 0;
      for (let index = end - used; index < end; index++) {
        const byte = bits[index];
        if (byte === 0x30 || byte === 0x31) {
          av = (av << 1) | (byte & 1);
          bv <<= 1;
        } else {
          const level = levelOf(byte);
          av = (av << 1) | (level === 1 || level === 2 ? 1 : 0);
          bv = (bv << 1) | (level >= 2 ? 1 : 0);
        }
      }
      if (used < width && first >= 2) {
        const pad = (width === 32 ? 0xffffffff : (1 << width) - 1) & ~((1 << used) - 1);
        bv |= pad;
        if (first === 2) {
          av |= pad;
        }
      }
      a[0] = av >>> 0;
      b[0] = bv >>> 0;
      return b[0] !== 0;
    }
    a.fill(0, 0, words);
    b.fill(0, 0, words);
    const padA = first === 2 ? 1 : 0;
    const padB = first >= 2 ? 1 : 0;
    let hasUnknown = false;
    for (let bit = 0; bit < width; bit++) {
      let levelA = padA;
      let levelB = padB;
      if (bit < used) {
        const level = levelOf(bits[end - 1 - bit]);
        levelA = level === 1 || level === 2 ? 1 : 0;
        levelB = level >= 2 ? 1 : 0;
      }
      if (levelA) {
        a[bit >>> 5] |= 1 << (bit & 31);
      }
      if (levelB) {
        b[bit >>> 5] |= 1 << (bit & 31);
        hasUnknown = true;
      }
    }
    return hasUnknown;
  }

  private record(delta: number): void {
    this.changeCount += delta;
    if (this.changeCount >= this.maximumChanges && !this.limitReached) {
      this.limitReached = true;
      this.warn(`值变化数量超过 ${this.maximumChanges.toLocaleString()} 条上限，之后的波形已截断`);
    }
  }

  private packTracks(): WaveTracks {
    const count = this.tracks.length;
    const width = new Uint32Array(count);
    const encoding = new Uint8Array(count);
    const wordsPerValue = new Uint32Array(count);
    const changeStart = new Uint32Array(count + 1);
    const valueStart = new Uint32Array(count);
    const bvalStart = new Int32Array(count);
    let totalChanges = 0;
    let totalWords = 0;
    let totalBWords = 0;
    let totalReals = 0;
    let totalTexts = 0;
    for (let track = 0; track < count; track++) {
      const builder = this.tracks[track];
      totalChanges += builder.count;
      if (builder.encoding === TrackEncoding.Bits) {
        totalWords += builder.count * builder.words;
        if (builder.bval) {
          totalBWords += builder.count * builder.words;
        }
      } else if (builder.encoding === TrackEncoding.Real) {
        totalReals += builder.count;
      } else {
        totalTexts += builder.count;
      }
    }
    const times = new Float64Array(totalChanges);
    const aval = new Uint32Array(totalWords);
    const bval = new Uint32Array(totalBWords);
    const reals = new Float64Array(totalReals);
    const texts: string[] = [];
    let changeOffset = 0;
    let wordOffset = 0;
    let bWordOffset = 0;
    let realOffset = 0;
    for (let track = 0; track < count; track++) {
      const builder = this.tracks[track];
      width[track] = builder.width;
      encoding[track] = builder.encoding;
      wordsPerValue[track] = builder.words;
      changeStart[track] = changeOffset;
      times.set(builder.times.data.subarray(0, builder.count), changeOffset);
      changeOffset += builder.count;
      bvalStart[track] = -1;
      if (builder.encoding === TrackEncoding.Bits) {
        const words = builder.count * builder.words;
        valueStart[track] = wordOffset;
        aval.set(builder.aval.data.subarray(0, words), wordOffset);
        wordOffset += words;
        if (builder.bval) {
          bvalStart[track] = bWordOffset;
          bval.set(builder.bval.data.subarray(0, words), bWordOffset);
          bWordOffset += words;
        }
      } else if (builder.encoding === TrackEncoding.Real) {
        valueStart[track] = realOffset;
        reals.set(builder.reals!.data.subarray(0, builder.count), realOffset);
        realOffset += builder.count;
      } else {
        valueStart[track] = texts.length;
        // A loop, not push(...spread): text tracks may hold more changes than the call-argument limit.
        for (let index = 0; index < builder.count; index++) {
          texts.push(builder.texts![index]);
        }
      }
    }
    changeStart[count] = changeOffset;
    return { count, width, encoding, wordsPerValue, changeStart, times, valueStart, bvalStart, aval, bval, reals, texts };
  }

  private warn(message: string): void {
    if (this.diagnostics.length < maximumDiagnostics) {
      this.diagnostics.push({ severity: 'warning', message });
    }
  }

  private readonly reportedKeys = new Set<string>();
  private warnOnce(key: string, message: string): void {
    if (!this.reportedKeys.has(key)) {
      this.reportedKeys.add(key);
      this.warn(message);
    }
  }
}

/** 0, 1, 2 (x-like) or 3 (z) for a VCD value character. */
function levelOf(byte: number): number {
  switch (byte) {
    case 0x30: case 0x6c: case 0x4c: // 0 l L
      return 0;
    case 0x31: case 0x68: case 0x48: // 1 h H
      return 1;
    case 0x7a: case 0x5a: // z Z
      return 3;
    default: // x X u U w W - and anything unexpected
      return 2;
  }
}

function unescapeIdentifier(name: string): string {
  return name.startsWith('\\') ? name.slice(1) : name;
}

/**
 * Split a `$var` reference into its name and optional bit range. A separate range
 * token (`\register[0] [31:0]`) marks the name's own brackets as part of the name
 * (a memory word); a lone `data[7:0]` token carries its range inline.
 */
function parseReference(tokens: readonly string[]): VarReference {
  const escaped = tokens[0].startsWith('\\');
  let name = unescapeIdentifier(tokens[0]);
  let rangeText = tokens.slice(1).join('');
  if (!rangeText && !escaped) {
    const inline = /^(.+?)(\[\s*-?\d+\s*(?::\s*-?\d+\s*)?\])$/.exec(name);
    if (inline) {
      name = inline[1];
      rangeText = inline[2];
    }
  }
  const range = /^\[\s*(-?\d+)\s*(?::\s*(-?\d+)\s*)?\]$/.exec(rangeText);
  if (!range) {
    return rangeText ? { name, range: rangeText } : { name };
  }
  const msb = Number(range[1]);
  const lsb = range[2] === undefined ? msb : Number(range[2]);
  return { name, range: range[2] === undefined ? `[${msb}]` : `[${msb}:${lsb}]`, msb, lsb };
}
