export interface TextSpan {
  text: string;
  start: number;
  end: number;
}

export interface IdentifierToken {
  value: string;
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

export function topLevelAssignmentEquals(text: string): number {
  let depth = 0;
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
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === '=' && depth === 0) {
      const previous = text[index - 1] ?? '';
      const next = text[index + 1] ?? '';
      if (previous !== '<' && previous !== '>' && previous !== '!' && previous !== '=' && next !== '=' && next !== '>') {
        return index;
      }
    }
  }
  return -1;
}

export function splitSemicolonStatementSpans(text: string): TextSpan[] {
  const statements: TextSpan[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') {
      depth++;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char !== ';' || depth !== 0) {
      continue;
    }
    statements.push({ text: text.slice(start, index), start, end: index });
    start = index + 1;
  }
  if (start < text.length) {
    statements.push({ text: text.slice(start), start, end: text.length });
  }
  return statements;
}

export function isInsideForControl(text: string, offset: number): boolean {
  const prefix = text.slice(0, offset);
  const forMatch = /\bfor\s*\([^()]*$/m.exec(prefix);
  if (!forMatch) {
    return false;
  }
  const openOffset = prefix.lastIndexOf('(');
  if (openOffset < 0) {
    return false;
  }
  const closeOffset = findMatchingParen(text, openOffset);
  return closeOffset !== undefined && offset < closeOffset;
}

export function isWrappedByParens(text: string): boolean {
  if (!text.startsWith('(') || !text.endsWith(')')) {
    return false;
  }
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0 && index < text.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

export function splitTernary(text: string): { condition: string; whenTrue: string; whenFalse: string } | undefined {
  let depth = 0;
  let question = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === '?' && depth === 0) {
      question = index;
      break;
    }
  }
  if (question < 0) {
    return undefined;
  }
  depth = 0;
  for (let index = question + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{' || char === '?') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === ':' && depth === 0) {
      return {
        condition: text.slice(0, question),
        whenTrue: text.slice(question + 1, index),
        whenFalse: text.slice(index + 1)
      };
    }
  }
  return undefined;
}

export function splitTopLevelOperator(text: string, operators: string[]): { left: string; operator: string; right: string } | undefined {
  let depth = 0;
  for (let index = text.length - 1; index >= 0; index--) {
    const char = text[index];
    if (char === ')' || char === ']' || char === '}') {
      depth++;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    for (const operator of operators) {
      const start = index - operator.length + 1;
      if (start <= 0 || text.slice(start, index + 1) !== operator) {
        continue;
      }
      const left = text.slice(0, start).trim();
      const right = text.slice(index + 1).trim();
      if (left && right) {
        return { left, operator, right };
      }
    }
  }
  return undefined;
}

export function readIdentifier(text: string, start: number): IdentifierToken | undefined {
  const match = /^[A-Za-z_]\w*/.exec(text.slice(start));
  if (!match) {
    return undefined;
  }
  return {
    value: match[0],
    start,
    end: start + match[0].length
  };
}

export function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index++;
  }
  return index;
}

export function findMatchingParen(text: string, openIndex: number): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    const char = text[index];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

export function leadingWhitespaceLength(text: string): number {
  return text.length - text.trimStart().length;
}

export function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}
