export function extractVerilogDisplayFormats(text: string): string[] {
  const clean = stripVerilogComments(text);
  const formats: string[] = [];
  const display = /\$display\s*\(\s*"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = display.exec(clean)) !== null) {
    formats.push(unescapeVerilogString(match[1]));
  }
  return formats;
}

function stripVerilogComments(text: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') {
        result += ' ';
        index++;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      result += '  ';
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        result += text[index] === '\n' ? '\n' : ' ';
        index++;
      }
      if (index < text.length) {
        result += '  ';
        index += 2;
      }
      continue;
    }
    result += char;
    index++;
  }
  return result;
}

function unescapeVerilogString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}
