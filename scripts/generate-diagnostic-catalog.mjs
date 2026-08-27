import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const docPath = path.join(root, 'docs', 'diagnostic-catalog.md');
const lintRulesPath = path.join(root, 'resources', 'verilog', 'lintRules.json');

const startMarker = '<!-- generated:verilog-lint-rules:start -->';
const endMarker = '<!-- generated:verilog-lint-rules:end -->';

function markdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function enabledLabel(rule) {
  return rule.enabledByDefault ? '启用' : '禁用';
}

function configurableLabel(rule) {
  return rule.configurable ? '是' : '否';
}

function severityLabel(value) {
  switch (value) {
    case 'error':
      return '错误';
    case 'warning':
      return '警告';
    case 'information':
      return '信息';
    case 'hint':
      return '提示';
    default:
      return value;
  }
}

function generatedLintCatalog(rules) {
  const configurableIds = rules.filter((rule) => rule.configurable).map((rule) => `\`${rule.id}\``).join(', ');
  const rows = rules.map((rule) => [
    `\`${rule.id}\``,
    severityLabel(rule.severity),
    enabledLabel(rule),
    configurableLabel(rule),
    markdownCell(rule.title),
    markdownCell(rule.description)
  ]);
  return [
    startMarker,
    '',
    '可配置 VC 规则和可综合性提示规则由 `resources/verilog/lintRules.json` 生成。',
    '',
    `可配置规则 ID：${configurableIds}。`,
    '',
    '| 代码 | 严重级别 | 默认 | 可配置 | 标题 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    endMarker
  ].join('\n');
}

function replaceGeneratedSection(documentText, generated) {
  const start = documentText.indexOf(startMarker);
  const end = documentText.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`Missing generated lint catalog markers in ${path.relative(root, docPath)}.`);
  }
  return `${documentText.slice(0, start)}${generated}${documentText.slice(end + endMarker.length)}`;
}

function main() {
  const rules = JSON.parse(fs.readFileSync(lintRulesPath, 'utf8'));
  if (!Array.isArray(rules)) {
    throw new Error('resources/verilog/lintRules.json must contain an array.');
  }
  const previous = fs.readFileSync(docPath, 'utf8');
  const next = replaceGeneratedSection(previous, generatedLintCatalog(rules));
  // The generated section is written with LF; a CRLF checkout must still
  // compare equal, otherwise `--check` can only pass on one platform.
  if (previous.replace(/\r\n/g, '\n') === next.replace(/\r\n/g, '\n')) {
    return;
  }
  if (checkOnly) {
    throw new Error(`${path.relative(root, docPath)} is not generated from resources/verilog/lintRules.json.`);
  }
  fs.writeFileSync(docPath, next);
  console.log('Generated docs/diagnostic-catalog.md Verilog lint catalog.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
