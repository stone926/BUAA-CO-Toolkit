export interface LogisimRomTarget {
  index: number;
  label?: string;
  loc?: string;
  addrWidth?: number;
  dataWidth?: number;
  hasContents: boolean;
  start: number;
  end: number;
}

export interface LogisimRomInjectionResult {
  text: string;
  target: LogisimRomTarget;
  wordCount: number;
}

interface InternalRomTarget extends LogisimRomTarget {
  block: string;
}

const romComponentPattern = /<comp\b[^>]*\bname="ROM"[^>]*(?:\/>|>[\s\S]*?<\/comp>)/g;
const attrTagPattern = /<a\b[^>]*>/g;

export function parseMachineCodeWords(text: string): string[] {
  const words: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const clean = line
      .replace(/#.*$/, '')
      .replace(/\/\/.*$/, '')
      .trim();
    if (!clean || /^v2\.0\s+raw$/i.test(clean) || /^addr\/data:/i.test(clean)) {
      continue;
    }
    const tokens = clean.split(/[\s,;]+/).filter(Boolean);
    for (const token of tokens) {
      const normalized = normalizeWord(token);
      if (normalized) {
        words.push(normalized);
      }
    }
  }
  return words;
}

export function formatLogisimMemoryContents(words: readonly string[], addrWidth: number, dataWidth = 32): string {
  const normalizedWords = words.map((word) => normalizeWord(word)).filter((word): word is string => Boolean(word));
  const body = normalizedWords.length ? normalizedWords.join('\n') : '0';
  return `addr/data: ${addrWidth} ${dataWidth}\n${body}\n`;
}

export function findLogisimRomTargets(circuitText: string): LogisimRomTarget[] {
  return internalRomTargets(circuitText).map(({ block: _block, ...target }) => target);
}

export function injectMachineCodeIntoLogisimRom(
  circuitText: string,
  machineCodeText: string,
  targetIndex: number
): LogisimRomInjectionResult {
  const words = parseMachineCodeWords(machineCodeText);
  if (!words.length) {
    throw new Error('Machine code file contains no 32-bit HexText words.');
  }

  const targets = internalRomTargets(circuitText);
  const target = targets.find((item) => item.index === targetIndex);
  if (!target) {
    throw new Error(`Cannot find Logisim ROM target #${targetIndex}.`);
  }
  if (target.dataWidth !== undefined && target.dataWidth !== 32) {
    throw new Error(`Selected ROM data width is ${target.dataWidth}, expected 32.`);
  }

  const addrWidth = target.addrWidth ?? recommendedAddrWidth(words.length);
  const dataWidth = target.dataWidth ?? 32;
  const contents = formatLogisimMemoryContents(words, addrWidth, dataWidth);
  const updatedBlock = replaceRomBlockContents(target.block, contents, addrWidth, dataWidth);
  return {
    text: circuitText.slice(0, target.start) + updatedBlock + circuitText.slice(target.end),
    target,
    wordCount: words.length
  };
}

function internalRomTargets(circuitText: string): InternalRomTarget[] {
  const targets: InternalRomTarget[] = [];
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = romComponentPattern.exec(circuitText))) {
    const block = match[0];
    targets.push({
      index,
      block,
      label: attributeValue(block, 'label'),
      loc: componentLoc(block),
      addrWidth: numericAttributeValue(block, 'addrWidth'),
      dataWidth: numericAttributeValue(block, 'dataWidth'),
      hasContents: /<a\b[^>]*\bname="contents"/.test(block),
      start: match.index,
      end: match.index + block.length
    });
    index++;
  }
  return targets;
}

function replaceRomBlockContents(block: string, contents: string, addrWidth: number, dataWidth: number): string {
  const normalizedContents = `<a name="contents">${contents}</a>`;
  const withWidths = ensureWidthAttributes(block, addrWidth, dataWidth);
  const contentsPattern = /<a\b[^>]*\bname="contents"[^>]*(?:\/>|>[\s\S]*?<\/a>)/;
  if (contentsPattern.test(withWidths)) {
    return withWidths.replace(contentsPattern, normalizedContents);
  }
  if (withWidths.endsWith('/>')) {
    return `${withWidths.slice(0, -2)}>\n      ${normalizedContents}\n    </comp>`;
  }
  return withWidths.replace(/<\/comp>\s*$/, `  ${normalizedContents}\n    </comp>`);
}

function ensureWidthAttributes(block: string, addrWidth: number, dataWidth: number): string {
  let updated = ensureAttribute(block, 'addrWidth', String(addrWidth));
  updated = ensureAttribute(updated, 'dataWidth', String(dataWidth));
  return updated;
}

function ensureAttribute(block: string, name: string, value: string): string {
  if (new RegExp(`<a\\b[^>]*\\bname="${escapeRegExp(name)}"`).test(block)) {
    return block;
  }
  if (block.endsWith('/>')) {
    return `${block.slice(0, -2)}>\n      <a name="${name}" val="${value}"/>\n    </comp>`;
  }
  return block.replace(/<\/comp>\s*$/, `  <a name="${name}" val="${value}"/>\n    </comp>`);
}

function attributeValue(block: string, name: string): string | undefined {
  let match: RegExpExecArray | null;
  attrTagPattern.lastIndex = 0;
  while ((match = attrTagPattern.exec(block))) {
    const tag = match[0];
    if (tag.match(/\bname="([^"]+)"/)?.[1] === name) {
      return tag.match(/\bval="([^"]*)"/)?.[1];
    }
  }
  return undefined;
}

function numericAttributeValue(block: string, name: string): number | undefined {
  const value = attributeValue(block, name);
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

function componentLoc(block: string): string | undefined {
  return block.match(/\bloc="([^"]+)"/)?.[1];
}

function normalizeWord(token: string): string | undefined {
  const clean = token.replace(/^0x/i, '').trim();
  if (!/^[0-9a-fA-F]{1,8}$/.test(clean)) {
    return undefined;
  }
  return clean.toUpperCase().padStart(8, '0').slice(-8);
}

function recommendedAddrWidth(wordCount: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, wordCount))));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
