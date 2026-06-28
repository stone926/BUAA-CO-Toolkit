// @index lint-catalog — 从 resources/verilog/lintRules.json 加载 Verilog lint 规则元数据
import * as fs from 'fs';
import * as path from 'path';

export interface VerilogLintRuleCatalogEntry {
  id: string;
  title: string;
  severity: 'error' | 'warning' | 'information' | 'hint';
  enabledByDefault: boolean;
  configurable: boolean;
  description: string;
  quickFixCommand?: string;
}

export const verilogLintRuleCatalog = loadVerilogLintRuleCatalog();
export const configurableVerilogLintRuleIds = verilogLintRuleCatalog
  .filter((rule) => rule.configurable)
  .map((rule) => rule.id);
export const defaultDisabledVerilogLintRuleIds = verilogLintRuleCatalog
  .filter((rule) => rule.configurable && !rule.enabledByDefault)
  .map((rule) => rule.id);

function loadVerilogLintRuleCatalog(): VerilogLintRuleCatalogEntry[] {
  const filePath = path.join(__dirname, '..', '..', '..', 'resources', 'verilog', 'lintRules.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Verilog lint rule catalog must be an array.');
  }
  const rules = parsed.map(normalizeRule);
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new Error(`Duplicate Verilog lint rule id: ${rule.id}.`);
    }
    seen.add(rule.id);
  }
  return rules;
}

function normalizeRule(value: unknown): VerilogLintRuleCatalogEntry {
  if (!isRecord(value)) {
    throw new Error('Invalid Verilog lint rule entry.');
  }
  const id = stringField(value, 'id');
  const severity = stringField(value, 'severity');
  if (!/^(?:vc-\d{3}|synth-[a-z-]+)$/.test(id)) {
    throw new Error(`Invalid Verilog lint rule id: ${id}.`);
  }
  if (severity !== 'error' && severity !== 'warning' && severity !== 'information' && severity !== 'hint') {
    throw new Error(`Invalid Verilog lint rule severity for ${id}.`);
  }
  return {
    id,
    title: stringField(value, 'title'),
    severity,
    enabledByDefault: booleanField(value, 'enabledByDefault'),
    configurable: booleanField(value, 'configurable'),
    description: stringField(value, 'description'),
    quickFixCommand: typeof value.quickFixCommand === 'string' ? value.quickFixCommand : undefined
  };
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) {
    throw new Error(`Invalid Verilog lint rule field: ${key}.`);
  }
  return field.trim();
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new Error(`Invalid Verilog lint rule field: ${key}.`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
