// @index waveform-loader — 宿主侧 VCD 读取：Node 流式分块解析（可取消、进度回调、块间让出事件循环），非 file 方案按内存切片解析

import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { setImmediate as yieldToEventLoop } from 'timers/promises';
import type { WaveformData } from '../model/waveformData';
import { VcdReader } from '../vcd/vcdReader';

/** Chunk size keeps each synchronous parse slice to a few milliseconds. */
const chunkBytes = 256 * 1024;
const progressIntervalBytes = 4 * 1024 * 1024;

export interface WaveformLoadOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (loadedBytes: number, totalBytes: number) => void;
  readonly maximumChanges?: number;
}

export async function waveformFileSize(fsPath: string): Promise<number> {
  return (await stat(fsPath)).size;
}

/** Stream-parse a local VCD file. */
export async function parseVcdFile(fsPath: string, options: WaveformLoadOptions = {}): Promise<WaveformData> {
  const totalBytes = await waveformFileSize(fsPath);
  const reader = new VcdReader({ maximumChanges: options.maximumChanges });
  const stream = createReadStream(fsPath, { highWaterMark: chunkBytes, signal: options.signal });
  let loaded = 0;
  let reported = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    reader.push(chunk);
    loaded += chunk.length;
    if (options.onProgress && loaded - reported >= progressIntervalBytes) {
      reported = loaded;
      options.onProgress(loaded, Math.max(totalBytes, loaded));
    }
  }
  options.signal?.throwIfAborted();
  return reader.finish();
}

/** Parse bytes already in memory (virtual file systems), yielding between slices. */
export async function parseVcdBytes(bytes: Uint8Array, options: WaveformLoadOptions = {}): Promise<WaveformData> {
  const reader = new VcdReader({ maximumChanges: options.maximumChanges });
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    options.signal?.throwIfAborted();
    reader.push(bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes)));
    if ((offset / chunkBytes) % 16 === 15) {
      options.onProgress?.(offset + chunkBytes, bytes.length);
      await yieldToEventLoop();
    }
  }
  return reader.finish();
}
