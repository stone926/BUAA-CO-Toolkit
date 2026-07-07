// @index ise-diagnostic-filters — ISE fuse 诊断降噪规则加载与过滤
import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { CoSettings } from '../common/settings';

export interface IseDiagnosticFilterRule {
  id: string;
  severity: 'error' | 'warning' | 'information' | 'hint';
  messagePattern: RegExp;
  defaultEnabled: boolean;
  reason: string;
}

interface RawIseDiagnosticFilterRule {
  id: string;
  severity: string;
  messagePattern: string;
  defaultEnabled: boolean;
  reason: string;
}

export const iseDiagnosticFilterRules = loadIseDiagnosticFilterRules();

export function filterIseDiagnostics(diagnostics: Diagnostic[], settings: CoSettings): Diagnostic[] {
  if (!diagnostics.length) {
    return diagnostics;
  }
  const enabledRules = enabledIseDiagnosticFilterRules(settings);
  if (!enabledRules.length) {
    return diagnostics;
  }
  return diagnostics.filter((diagnostic) => !enabledRules.some((rule) => matchesIseDiagnosticFilter(rule, diagnostic)));
}

export function filterIseDiagnosticsByUri(diagnosticsByUri: Map<string, Diagnostic[]>, settings: CoSettings): Map<string, Diagnostic[]> {
  if (!diagnosticsByUri.size) {
    return diagnosticsByUri;
  }
  const result = new Map<string, Diagnostic[]>();
  for (const [uri, diagnostics] of diagnosticsByUri) {
    const filtered = filterIseDiagnostics(diagnostics, settings);
    if (filtered.length) {
      result.set(uri, filtered);
    }
  }
  return result;
}

function enabledIseDiagnosticFilterRules(settings: CoSettings): IseDiagnosticFilterRule[] {
  const enabledIds = new Set(settings.verilog.syntax.ise.suppressedWarnings.map((id) => id.toLowerCase()));
  return iseDiagnosticFilterRules.filter((rule) => enabledIds.has(rule.id));
}

function matchesIseDiagnosticFilter(rule: IseDiagnosticFilterRule, diagnostic: Diagnostic): boolean {
  return diagnostic.code === 'ise-syntax' &&
    diagnostic.source === 'ISE fuse' &&
    severityName(diagnostic.severity) === rule.severity &&
    rule.messagePattern.test(diagnostic.message);
}

function severityName(severity: DiagnosticSeverity | undefined): IseDiagnosticFilterRule['severity'] | undefined {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return 'error';
    case DiagnosticSeverity.Warning:
      return 'warning';
    case DiagnosticSeverity.Information:
      return 'information';
    case DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return undefined;
  }
}

function loadIseDiagnosticFilterRules(): IseDiagnosticFilterRule[] {
  const filePath = path.join(__dirname, '..', '..', '..', 'resources', 'verilog', 'iseDiagnosticFilters.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('ISE diagnostic filter catalog must be an array.');
  }
  const rules = parsed.map(normalizeRule);
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new Error(`Duplicate ISE diagnostic filter id: ${rule.id}.`);
    }
    seen.add(rule.id);
  }
  return rules;
}

function normalizeRule(value: unknown): IseDiagnosticFilterRule {
  if (!isRecord(value)) {
    throw new Error('Invalid ISE diagnostic filter entry.');
  }
  const raw: RawIseDiagnosticFilterRule = {
    id: stringField(value, 'id').toLowerCase(),
    severity: stringField(value, 'severity').toLowerCase(),
    messagePattern: stringField(value, 'messagePattern'),
    defaultEnabled: booleanField(value, 'defaultEnabled'),
    reason: stringField(value, 'reason')
  };
  if (!/^ise-[a-z0-9-]+$/.test(raw.id)) {
    throw new Error(`Invalid ISE diagnostic filter id: ${raw.id}.`);
  }
  if (!isSeverity(raw.severity)) {
    throw new Error(`Invalid ISE diagnostic filter severity for ${raw.id}.`);
  }
  return {
    ...raw,
    severity: raw.severity,
    messagePattern: compileMessagePattern(raw.id, raw.messagePattern)
  };
}

function compileMessagePattern(id: string, pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ISE diagnostic filter pattern for ${id}: ${message}`);
  }
}

function isSeverity(value: string): value is IseDiagnosticFilterRule['severity'] {
  return value === 'error' || value === 'warning' || value === 'information' || value === 'hint';
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) {
    throw new Error(`Invalid ISE diagnostic filter field: ${key}.`);
  }
  return field.trim();
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new Error(`Invalid ISE diagnostic filter field: ${key}.`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
