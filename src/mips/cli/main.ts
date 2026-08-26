#!/usr/bin/env node
// @index mips-cli — 独立 conformance 使用的版本化 JSONL 进程入口
import {
  handleMipsEngineCliValue,
  mipsEngineCliProtocolVersion,
  MipsEngineCliResponse
} from './protocol';

export const mipsEngineCliMaximumLineBytes = 4 * 1024 * 1024;

export async function runMipsEngineCli(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr
): Promise<number> {
  let failures = 0;
  let lineNumber = 0;
  let requests = 0;
  for await (const item of boundedJsonLines(input, mipsEngineCliMaximumLineBytes)) {
    lineNumber++;
    if (item.tooLarge) {
      requests++;
      failures++;
      await writeWithBackpressure(output, `${JSON.stringify(failureResponse(
        `line-${lineNumber}`,
        'request-too-large',
        `JSONL line exceeds ${mipsEngineCliMaximumLineBytes} bytes`
      ))}\n`);
      continue;
    }
    if (item.invalidUtf8) {
      requests++;
      failures++;
      await writeWithBackpressure(output, `${JSON.stringify(failureResponse(
        `line-${lineNumber}`,
        'invalid-utf8',
        'JSONL request is not lossless UTF-8'
      ))}\n`);
      continue;
    }
    const line = item.line;
    if (!line.trim()) {
      continue;
    }
    requests++;
    let response: MipsEngineCliResponse;
    try {
      response = handleMipsEngineCliValue(JSON.parse(line));
    } catch (error) {
      response = failureResponse(
        `line-${lineNumber}`,
        'invalid-json',
        error instanceof Error ? error.message : String(error)
      );
    }
    if (!response.ok) {
      failures++;
    }
    await writeWithBackpressure(output, `${JSON.stringify(response)}\n`);
  }
  if (requests === 0) {
    errorOutput.write('mips-engine-cli: expected JSONL requests on stdin\n');
    return 2;
  }
  return failures === 0 ? 0 : 1;
}

interface BoundedJsonLine {
  line: string;
  tooLarge: boolean;
  invalidUtf8: boolean;
}

/** Split on LF while discarding an oversized line as soon as the byte cap is crossed. */
async function* boundedJsonLines(
  input: NodeJS.ReadableStream,
  maximumBytes: number
): AsyncGenerator<BoundedJsonLine> {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  let sawBytes = false;

  const append = (part: Buffer): void => {
    if (!part.length || tooLarge) return;
    if (bytes + part.length > maximumBytes) {
      chunks = [];
      bytes = 0;
      tooLarge = true;
      return;
    }
    chunks.push(part);
    bytes += part.length;
  };

  for await (const raw of input as AsyncIterable<Buffer | string>) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (chunk.length) sawBytes = true;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        append(chunk.subarray(offset));
        break;
      }
      append(chunk.subarray(offset, newline));
      if (tooLarge) {
        yield { line: '', tooLarge: true, invalidUtf8: false };
      } else {
        const lineBytes = Buffer.concat(chunks, bytes);
        const content = lineBytes.length && lineBytes[lineBytes.length - 1] === 0x0d
          ? lineBytes.subarray(0, lineBytes.length - 1)
          : lineBytes;
        yield decodedJsonLine(content);
      }
      chunks = [];
      bytes = 0;
      tooLarge = false;
      offset = newline + 1;
    }
  }
  if (tooLarge) {
    yield { line: '', tooLarge: true, invalidUtf8: false };
  } else if (bytes > 0 || chunks.length > 0 || sawBytes) {
    const lineBytes = Buffer.concat(chunks, bytes);
    const content = lineBytes.length && lineBytes[lineBytes.length - 1] === 0x0d
      ? lineBytes.subarray(0, lineBytes.length - 1)
      : lineBytes;
    // A stream ending immediately after LF has no additional logical line.
    if (content.length > 0) yield decodedJsonLine(content);
  }
}

function decodedJsonLine(bytes: Buffer): BoundedJsonLine {
  const line = bytes.toString('utf8');
  return {
    line,
    tooLarge: false,
    invalidUtf8: !Buffer.from(line, 'utf8').equals(bytes)
  };
}

async function writeWithBackpressure(output: NodeJS.WritableStream, value: string): Promise<void> {
  if (output.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      output.removeListener('drain', onDrain);
      output.removeListener('error', onError);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    output.once('drain', onDrain);
    output.once('error', onError);
  });
}

function failureResponse(requestId: string, code: string, message: string): MipsEngineCliResponse {
  return {
    protocolVersion: mipsEngineCliProtocolVersion,
    requestId,
    ok: false,
    error: { code, message }
  };
}

if (require.main === module) {
  runMipsEngineCli().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`mips-engine-cli: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  );
}
