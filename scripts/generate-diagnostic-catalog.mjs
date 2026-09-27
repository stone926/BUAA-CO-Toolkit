import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const root = process.cwd();
const checkOnly = process.argv.includes('--check');
const docPath = path.join(root, 'docs', 'diagnostic-catalog.md');
const generatedStart = '<!-- generated:diagnostic-codes:start -->';
const generatedEnd = '<!-- generated:diagnostic-codes:end -->';
const languageDirectories = ['mips', 'verilog', 'logisim'];

function markdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filePath);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [filePath] : [];
  });
}

function sourceLabel(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function templatePattern(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return undefined;
  return node.templateSpans.reduce((result, span) => `${result}<${dynamicLabel(span.expression)}>${span.literal.text}`, node.head.text);
}

function dynamicLabel(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isCallExpression(node)) return ts.isPropertyAccessExpression(node.expression)
    ? dynamicLabel(node.expression.expression)
    : dynamicLabel(node.expression);
  if (ts.isElementAccessExpression(node)) return dynamicLabel(node.expression);
  return 'value';
}

function propertyName(node) {
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function collectDiagnosticCodes(filePath, language) {
  const text = fs.readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Set();
  const localConstants = new Map();

  function record(node, context) {
    const pattern = templatePattern(node);
    if (pattern !== undefined) {
      found.add(pattern);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      record(node.whenTrue, context);
      record(node.whenFalse, context);
      return;
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      record(node.expression, context);
      return;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'code' && ts.isIdentifier(node.expression)
      && ['issue', 'diagnostic'].includes(node.expression.text)) {
      // The issue objects are collected below from their `code` properties.
      return;
    }
    if (ts.isIdentifier(node)) {
      const constant = localConstants.get(node.text);
      if (constant) {
        record(constant, `${context} via const ${node.text}`);
        return;
      }
      let owner = node.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      if (owner && owner.name && ts.isIdentifier(owner.name)) {
        const index = owner.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === node.text);
        if (index >= 0) {
          let resolved = false;
          function findCalls(current) {
            if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === owner.name.text) {
              const arg = current.arguments[index];
              if (arg) {
                record(arg, `${context} via ${owner.name.text}()`);
                resolved = true;
              }
            }
            ts.forEachChild(current, findCalls);
          }
          findCalls(source);
          if (resolved) return;
        }
      }
    }
    throw new Error(`Cannot statically catalog diagnostic code in ${sourceLabel(filePath)} (${context}): ${node.getText(source)}`);
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      localConstants.set(node.name.text, node.initializer);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'makeDiagnostic') {
      const code = node.arguments[3];
      if (code) record(code, 'makeDiagnostic code argument');
      else throw new Error(`makeDiagnostic call without code in ${sourceLabel(filePath)}.`);
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'code'
      && ts.isObjectLiteralExpression(node.parent)
      && node.parent.properties.some((property) => propertyName(property.name ?? property) === 'message')
      && node.parent.properties.some((property) => propertyName(property.name ?? property) === 'range')) {
      // DiagnosticIssue records are forwarded to makeDiagnostic by a small number of adapters.
      record(node.initializer, 'code property');
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  if (source.parseDiagnostics.length) {
    throw new Error(`Unable to parse ${sourceLabel(filePath)} with TypeScript.`);
  }
  return [...found].map((code) => ({ code, source: sourceLabel(filePath), language }));
}

function collectCatalog() {
  const entries = new Map();
  for (const language of languageDirectories) {
    const directory = path.join(root, 'src', 'language', language);
    for (const filePath of sourceFiles(directory)) {
      for (const entry of collectDiagnosticCodes(filePath, language)) addEntry(entries, entry);
    }
  }
  return [...entries.values()].sort((left, right) =>
    left.language < right.language ? -1 : left.language > right.language ? 1
      : left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
}

function addEntry(entries, entry) {
  const key = `${entry.language}\0${entry.code}`;
  const existing = entries.get(key);
  if (existing) existing.sources.add(entry.source);
  else entries.set(key, { ...entry, sources: new Set([entry.source]) });
}

function generatedCodeInventory(entries) {
  const rows = entries.map((entry) => `| ${entry.language} | \`${markdownCell(entry.code)}\` | ${[...entry.sources].sort().map((source) => `\`${source}\``).join(', ')} |`);
  return [
    generatedStart,
    '',
    '此清单由 MIPS、Verilog 和 Logisim 诊断生产代码生成。新增诊断码、动态码模式或遗漏更新都会使 `check:diagnostic-catalog` 失败。',
    '',
    '| 语言 | 发出的代码或动态模式 | 来源 |',
    '| --- | --- | --- |',
    ...rows,
    '',
    generatedEnd
  ].join('\n');
}

function replaceSection(documentText, startMarker, endMarker, generated) {
  const start = documentText.indexOf(startMarker);
  const end = documentText.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) throw new Error(`Missing or invalid generated catalog markers: ${startMarker}.`);
  return `${documentText.slice(0, start)}${generated}${documentText.slice(end + endMarker.length)}`;
}

function main() {
  const entries = collectCatalog();
  let previous = fs.readFileSync(docPath, 'utf8');
  let next = replaceSection(previous, generatedStart, generatedEnd, generatedCodeInventory(entries));
  if (previous.replace(/\r\n/g, '\n') === next.replace(/\r\n/g, '\n')) return;
  if (checkOnly) throw new Error(`${path.relative(root, docPath)} is not generated from diagnostic producers.`);
  fs.writeFileSync(docPath, next);
  console.log('Generated docs/diagnostic-catalog.md diagnostic inventory.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
