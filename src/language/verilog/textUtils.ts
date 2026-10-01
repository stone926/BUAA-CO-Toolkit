export interface TextSpan {
  text: string;
  start: number;
  end: number;
}

export function normalizeWidth(width?: string): string | undefined {
  return width?.replace(/\s+/g, '');
}

export function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
    .replace(/\/\/.*$/gm, (match) => ' '.repeat(match.length))
    .replace(/"([^"\\]|\\.)*"/g, (match) => ' '.repeat(match.length));
}

export function splitTopLevelCommas(text: string): string[] {
  return splitTopLevelCommaSpans(text).map((span) => span.text);
}

export function splitTopLevelCommaSpans(text: string): TextSpan[] {
  const parts: TextSpan[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      escaped = char === '\\' && !escaped;
      if (char === '"' && !escaped) {
        inString = false;
      } else if (char !== '\\') {
        escaped = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      parts.push({ text: text.slice(start, index), start, end: index });
      start = index + 1;
    }
  }
  parts.push({ text: text.slice(start), start, end: text.length });
  return parts;
}

export function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}
