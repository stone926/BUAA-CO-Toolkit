// @index hazard-machine-code — 纯文本 Hex/Logisim/COE 到有界 ProgramImage
import type { ProgramImage } from '../mips/core/api';
import { buildProgramImage } from '../mips/core/programImage';
import { sha256Text } from '../mips/core/digest';
import type { HazardProfile } from './reportTypes';

const maxWords = 4096;
const maxCharacters = 262144;

export class HazardMachineCodeError extends Error {
  constructor(message: string, readonly line: number) {
    super(`第 ${line} 行：${message}`);
    this.name = 'HazardMachineCodeError';
  }
}

/** Accepts one hex word per line, Logisim v2 raw (including N*WORD), or COE. */
export function parseHazardMachineCode(text: string, _profile: HazardProfile): ProgramImage {
  if (text.length > maxCharacters) throw new HazardMachineCodeError(`文本超过 ${maxCharacters} 字符上限`, 1);
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const first = lines.findIndex((line) => line.trim() && !isComment(line));
  if (first < 0) throw new HazardMachineCodeError('机器码为空', 1);
  const head = lines[first].trim();
  const words = /^v2\.0\s+raw\s*$/i.test(head)
    ? parseLogisim(lines, first + 1)
    : /^memory_initialization_/i.test(head)
      ? parseCoe(lines, first)
      : parsePlain(lines);
  if (!words.length) throw new HazardMachineCodeError('没有机器码字', first + 1);
  return buildProgramImage({
    entryPc: 0x3000,
    segments: [{ name: 'text', baseAddress: 0x3000, words }],
    inputGraph: [{ id: 'hazard-machine-code', contentHash: sha256Text(text) }]
  });
}

function isComment(line: string): boolean {
  return /^\s*(?:#|\/\/|;|$)/.test(line);
}

function withoutComment(line: string): string {
  return line.replace(/(?:#|\/\/).*$/, '').trim();
}

function addWord(words: number[], token: string, line: number, radix: number, count = 1): void {
  const digits = radix === 16 ? /^(?:0x)?[0-9a-f]{1,8}$/i : radix === 2 ? /^[01]{1,32}$/ : /^(?:0|[1-9][0-9]{0,9})$/;
  if (!digits.test(token)) throw new HazardMachineCodeError(`非法 ${radix} 进制机器码「${token}」`, line);
  const value = Number.parseInt(token.replace(/^0x/i, ''), radix);
  if (!Number.isSafeInteger(value) || value > 0xffffffff) throw new HazardMachineCodeError('机器码超出 32 位', line);
  if (!Number.isSafeInteger(count) || count < 1 || words.length + count > maxWords) {
    throw new HazardMachineCodeError(`机器码超过 ${maxWords} 字上限`, line);
  }
  for (let index = 0; index < count; index++) words.push(value >>> 0);
}

function parsePlain(lines: readonly string[]): number[] {
  const words: number[] = [];
  lines.forEach((line, index) => {
    const body = withoutComment(line);
    if (!body || /^;/.test(body)) return;
    const tokens = body.split(/\s+/);
    if (tokens.length !== 1) throw new HazardMachineCodeError('每行只能包含一个 32 位十六进制字', index + 1);
    addWord(words, tokens[0], index + 1, 16);
  });
  return words;
}

function parseLogisim(lines: readonly string[], start: number): number[] {
  const words: number[] = [];
  for (let index = start; index < lines.length; index++) {
    const body = withoutComment(lines[index]);
    if (!body || body.startsWith(';')) continue;
    for (const token of body.split(/\s+/)) {
      const compressed = /^(\d+)\*(.+)$/.exec(token);
      addWord(words, compressed?.[2] ?? token, index + 1, 16, compressed ? Number(compressed[1]) : 1);
    }
  }
  return words;
}

function parseCoe(lines: readonly string[], start: number): number[] {
  const words: number[] = [];
  let radix: number | undefined;
  let vector = false;
  let finished = false;
  for (let index = start; index < lines.length; index++) {
    const body = withoutComment(lines[index]);
    if (!body || body.startsWith(';')) continue;
    if (finished) throw new HazardMachineCodeError('向量结束后存在多余内容', index + 1);
    if (!vector) {
      const declaration = /^memory_initialization_(radix|vector)\s*=\s*(.*)$/i.exec(body);
      if (!declaration) throw new HazardMachineCodeError('COE 声明格式错误', index + 1);
      if (declaration[1].toLowerCase() === 'radix') {
        if (radix !== undefined) throw new HazardMachineCodeError('重复的 radix 声明', index + 1);
        const match = /^(2|10|16)\s*;\s*$/.exec(declaration[2]);
        if (!match) throw new HazardMachineCodeError('radix 仅支持 2、10、16', index + 1);
        radix = Number(match[1]);
        continue;
      }
      if (radix === undefined) throw new HazardMachineCodeError('vector 前缺少 radix 声明', index + 1);
      vector = true;
      parseVectorPart(declaration[2], index + 1);
    } else {
      parseVectorPart(body, index + 1);
    }
  }
  if (!vector || !finished) throw new HazardMachineCodeError('COE 向量必须以分号结束', lines.length);
  return words;

  function parseVectorPart(body: string, line: number): void {
    if (!body.trim()) return;
    const semicolon = body.indexOf(';');
    if (semicolon >= 0) {
      if (body.slice(semicolon + 1).trim()) throw new HazardMachineCodeError('分号后存在多余内容', line);
      finished = true;
      body = body.slice(0, semicolon);
    }
    const tokens = body.split(',');
    if (tokens.at(-1)?.trim() === '') tokens.pop();
    for (const token of tokens) {
      if (!token.trim()) throw new HazardMachineCodeError('COE 向量存在空机器码', line);
      addWord(words, token.trim(), line, radix!);
    }
  }
}
