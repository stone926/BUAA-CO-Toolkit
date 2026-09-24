// @index waveform-reader — VCD 解析会话门面：逐 chunk 推入、统计字节数并产出 WaveformData；另含一次性整段解析入口

import type { WaveformData } from '../model/waveformData';
import { VcdParser } from './vcdParser';
import { WaveformBuilder, WaveformBuilderOptions } from './waveformBuilder';

export class VcdReader {
  private readonly builder: WaveformBuilder;
  private readonly parser: VcdParser;
  private byteLength = 0;

  constructor(options: WaveformBuilderOptions = {}) {
    this.builder = new WaveformBuilder(options);
    this.parser = new VcdParser(this.builder);
  }

  push(chunk: Uint8Array): void {
    this.byteLength += chunk.length;
    this.parser.push(chunk);
  }

  finish(): WaveformData {
    return this.builder.build(this.parser.end(), this.byteLength);
  }
}

export function parseVcd(input: Uint8Array | string, options: WaveformBuilderOptions = {}): WaveformData {
  const reader = new VcdReader(options);
  reader.push(typeof input === 'string' ? new TextEncoder().encode(input) : input);
  return reader.finish();
}
