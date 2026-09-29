import {
  getLogisimTraceProfileConfig,
  LogisimTraceColumnConfig,
  LogisimTraceProfileConfig
} from '../courseConfig';

export type LogisimTraceRequiredLabel =
  | 'pc'
  | 'regwrite'
  | 'regaddr'
  | 'regdata'
  | 'memwrite'
  | 'memaddr'
  | 'memdata';

export type LogisimTraceSemanticLabel = 'instr' | LogisimTraceRequiredLabel;

const knownSemanticLabels = new Set<LogisimTraceSemanticLabel>([
  'instr',
  'pc',
  'regwrite',
  'regaddr',
  'regdata',
  'memwrite',
  'memaddr',
  'memdata'
]);

export interface ResolvedLogisimTraceProfile {
  profile: 'P3';
  defaultCircuit: string;
  textBase: number;
  romMaxWords: number;
  haltLoopWords: number;
  maxProgramWords: number;
  pcAlignmentBytes: number;
  stuckPcRowLimit: number;
  haltLabel: string;
  orderedLabels: readonly LogisimTraceSemanticLabel[];
  requiredLabels: readonly LogisimTraceRequiredLabel[];
  semanticLabels: readonly LogisimTraceSemanticLabel[];
  widths: Record<LogisimTraceSemanticLabel, number>;
  aliasToSemantic: ReadonlyMap<string, LogisimTraceSemanticLabel>;
}

export const p3LogisimTraceProfile = resolveLogisimTraceProfile('P3');

export function normalizeLogisimTraceLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[_\-\s]+/g, '');
}

export function canonicalizeP3LogisimTraceLabel(label: string): string {
  const normalized = normalizeLogisimTraceLabel(label);
  return p3LogisimTraceProfile.aliasToSemantic.get(normalized) ?? normalized;
}

export function isP3LogisimTraceSemanticLabel(label: string): label is LogisimTraceSemanticLabel {
  return knownSemanticLabels.has(label as LogisimTraceSemanticLabel);
}

function resolveLogisimTraceProfile(profile: 'P3'): ResolvedLogisimTraceProfile {
  const config = getLogisimTraceProfileConfig(profile);
  if (!config) {
    throw new Error(`courseConfig.json 中缺少 Logisim 写回记录配置“${profile}”。`);
  }
  return normalizeProfileConfig(profile, config);
}

function normalizeProfileConfig(
  profile: 'P3',
  config: LogisimTraceProfileConfig
): ResolvedLogisimTraceProfile {
  const textBase = parseHexAddress(config.textBase, `${profile}.textBase`);
  const romMaxWords = positiveInteger(config.romMaxWords, `${profile}.romMaxWords`);
  const haltLoopWords = positiveInteger(config.haltLoopWords, `${profile}.haltLoopWords`);
  if (haltLoopWords >= romMaxWords) {
    throw new Error(`Logisim 写回记录配置“${profile}”中的 haltLoopWords 必须小于 romMaxWords。`);
  }

  const columns = Object.entries(config.columns);
  const semanticLabels = columns.map(([label]) => requireSemanticLabel(label, `${profile}.columns`));
  const orderedLabels = config.orderedColumns.map((label) => requireSemanticLabel(label, `${profile}.orderedColumns`));
  for (const label of orderedLabels) {
    if (!config.columns[label]) {
      throw new Error(`Logisim 写回记录配置“${profile}”的 orderedColumns 引用了不存在的列“${label}”。`);
    }
  }

  const widths = Object.fromEntries(semanticLabels.map((label) => {
    const column = config.columns[label];
    return [label, positiveInteger(column.width, `${profile}.columns.${label}.width`)];
  })) as Record<LogisimTraceSemanticLabel, number>;
  const requiredLabels = columns
    .filter(([, column]) => column.required === true)
    .map(([label]) => requireRequiredLabel(label, `${profile}.columns`));
  const aliasToSemantic = buildAliasMap(profile, config.columns);

  return {
    profile,
    defaultCircuit: config.defaultCircuit || 'main',
    textBase,
    romMaxWords,
    haltLoopWords,
    maxProgramWords: romMaxWords - haltLoopWords,
    pcAlignmentBytes: positiveInteger(config.pcAlignmentBytes ?? 4, `${profile}.pcAlignmentBytes`),
    stuckPcRowLimit: positiveInteger(config.stuckPcRowLimit ?? 256, `${profile}.stuckPcRowLimit`),
    haltLabel: normalizeLogisimTraceLabel(config.haltLabel || 'halt'),
    orderedLabels,
    requiredLabels,
    semanticLabels,
    widths,
    aliasToSemantic
  };
}

function buildAliasMap(
  profile: string,
  columns: Record<string, LogisimTraceColumnConfig>
): ReadonlyMap<string, LogisimTraceSemanticLabel> {
  const result = new Map<string, LogisimTraceSemanticLabel>();
  for (const [rawLabel, column] of Object.entries(columns)) {
    const semantic = requireSemanticLabel(rawLabel, `${profile}.columns`);
    const aliases = new Set([rawLabel, ...(column.aliases ?? [])]);
    for (const alias of aliases) {
      const normalized = normalizeLogisimTraceLabel(alias);
      if (!normalized) {
        continue;
      }
      const existing = result.get(normalized);
      if (existing && existing !== semantic) {
        throw new Error(`Logisim 写回记录配置“${profile}”将别名“${alias}”同时映射到“${existing}”和“${semantic}”。`);
      }
      result.set(normalized, semantic);
    }
  }
  return result;
}

function requireSemanticLabel(label: string, context: string): LogisimTraceSemanticLabel {
  const normalized = normalizeLogisimTraceLabel(label);
  if (!knownSemanticLabels.has(normalized as LogisimTraceSemanticLabel)) {
    throw new Error(`${context} 中的 Logisim 写回记录语义标签“${label}”未知。`);
  }
  return normalized as LogisimTraceSemanticLabel;
}

function requireRequiredLabel(label: string, context: string): LogisimTraceRequiredLabel {
  const semantic = requireSemanticLabel(label, context);
  if (semantic === 'instr') {
    throw new Error(`Logisim 写回记录配置在 ${context} 中将可选列“instr”标记为必需列。`);
  }
  return semantic;
}

function parseHexAddress(value: string, context: string): number {
  if (!/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`${context} 应为十六进制地址。`);
  }
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${context} 超出安全整数范围。`);
  }
  return parsed;
}

function positiveInteger(value: number, context: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${context} 应为正整数。`);
  }
  return value;
}
