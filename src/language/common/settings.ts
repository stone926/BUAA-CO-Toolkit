// @index settings — CoSettings接口/默认值/合并验证/诊断禁用键
import { ProjectProfile } from '../../projectProfile';
import { configDefault, configDefaultArray } from '../../configDefaults';
import { configurableVerilogLintRuleIds, defaultDisabledVerilogLintRuleIds } from '../verilog/lintRuleCatalog';

export const defaultDisabledVerilogLintRules = defaultDisabledVerilogLintRuleIds as readonly string[];
const configurableVerilogLintRuleSet = new Set(configurableVerilogLintRuleIds);
export const disableDiagnosticCodeCommand = 'co.diagnostics.disableCode';

export interface CoSettings {
  diagnostics: {
    disabledCodes: string[];
    disabledFileCodes: string[];
  };
  project: {
    profile: ProjectProfile;
    topModule: string;
    testbench: string;
    machineCode: string;
    simTime: string;
  };
  toolchain: {
    isePath: string;
  };
  run: {
    timeoutMs: number;
  };
  mips: {
    warnPseudoInstruction: boolean;
    instructionTokenMode: 'realVsPseudo' | 'same' | 'byType';
    warnMissingExitSyscall: boolean;
  };
  verilog: {
    syntax: {
      ise: {
        enabled: boolean;
        mode: 'off' | 'onSave' | 'commandOnly';
        timeoutMs: number;
        suppressedWarnings: string[];
      };
    };
    implicitNet: {
      diagnostic: 'off' | 'hint' | 'warning' | 'error';
      ignorePatterns: string[];
    };
    lint: {
      courseRules: boolean;
      synthesizableHints: boolean;
      disabledRules: string[];
    };
    format: {
      continuationIndent: number;
      spaceInRange: boolean;
      declarationRangeSpacing: 'space' | 'compact' | 'preserve';
      spaceBeforeInstancePorts: boolean;
      separateElse: boolean;
      maxBlankLines: number;
      parameterAlignment: 'none' | 'equals';
      modulePortAlignment: 'none' | 'name';
      ternaryAlignment: 'none' | 'question';
    };
  };
}

export const defaultCoSettings: CoSettings = {
  diagnostics: {
    disabledCodes: configDefaultArray('diagnostics.disabledCodes'),
    disabledFileCodes: configDefaultArray('diagnostics.disabledFileCodes')
  },
  project: {
    profile: configDefault<ProjectProfile>('project.profile'),
    topModule: configDefault<string>('project.topModule'),
    testbench: configDefault<string>('project.testbench'),
    machineCode: configDefault<string>('project.machineCode'),
    simTime: configDefault<string>('project.simTime')
  },
  toolchain: {
    isePath: configDefault<string>('toolchain.isePath')
  },
  run: {
    timeoutMs: configDefault<number>('run.timeoutMs')
  },
  mips: {
    warnPseudoInstruction: configDefault<boolean>('mips.warnPseudoInstruction'),
    instructionTokenMode: configDefault<'realVsPseudo' | 'same' | 'byType'>('mips.instructionTokenMode'),
    warnMissingExitSyscall: configDefault<boolean>('mips.warnMissingExitSyscall')
  },
  verilog: {
    syntax: {
      ise: {
        enabled: configDefault<boolean>('verilog.syntax.ise.enabled'),
        mode: configDefault<'off' | 'onSave' | 'commandOnly'>('verilog.syntax.ise.mode'),
        timeoutMs: configDefault<number>('verilog.syntax.ise.timeoutMs'),
        suppressedWarnings: configDefaultArray('verilog.syntax.ise.suppressedWarnings')
      }
    },
    implicitNet: {
      diagnostic: configDefault<'off' | 'hint' | 'warning' | 'error'>('verilog.implicitNet.diagnostic'),
      ignorePatterns: configDefaultArray('verilog.implicitNet.ignorePatterns')
    },
    lint: {
      courseRules: configDefault<boolean>('verilog.lint.courseRules'),
      synthesizableHints: configDefault<boolean>('verilog.lint.synthesizableHints'),
      disabledRules: [...defaultDisabledVerilogLintRules]
    },
    format: {
      continuationIndent: configDefault<number>('verilog.format.continuationIndent'),
      spaceInRange: configDefault<boolean>('verilog.format.spaceInRange'),
      declarationRangeSpacing: configDefault<'space' | 'compact' | 'preserve'>('verilog.format.declarationRangeSpacing'),
      spaceBeforeInstancePorts: configDefault<boolean>('verilog.format.spaceBeforeInstancePorts'),
      separateElse: configDefault<boolean>('verilog.format.separateElse'),
      maxBlankLines: configDefault<number>('verilog.format.maxBlankLines'),
      parameterAlignment: configDefault<'none' | 'equals'>('verilog.format.alignment.parameter'),
      modulePortAlignment: configDefault<'none' | 'name'>('verilog.format.alignment.modulePort'),
      ternaryAlignment: configDefault<'none' | 'question'>('verilog.format.alignment.ternary')
    }
  }
};

export function mergeCoSettings(value: unknown): CoSettings {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<CoSettings> : {};
  return {
    diagnostics: {
      ...defaultCoSettings.diagnostics,
      ...(candidate.diagnostics ?? {}),
      disabledCodes: normalizeDisabledDiagnosticCodes(candidate.diagnostics?.disabledCodes),
      disabledFileCodes: normalizeDisabledDiagnosticFileCodes(candidate.diagnostics?.disabledFileCodes)
    },
    project: {
      ...defaultCoSettings.project,
      ...(candidate.project ?? {})
    },
    toolchain: {
      ...defaultCoSettings.toolchain,
      ...(candidate.toolchain ?? {}),
      isePath: typeof candidate.toolchain?.isePath === 'string' ? candidate.toolchain.isePath.trim() : defaultCoSettings.toolchain.isePath
    },
    run: {
      ...defaultCoSettings.run,
      ...(candidate.run ?? {}),
      timeoutMs: normalizeInteger(candidate.run?.timeoutMs, defaultCoSettings.run.timeoutMs, 1000, 600000)
    },
    mips: {
      ...defaultCoSettings.mips,
      ...(candidate.mips ?? {})
    },
    verilog: {
      syntax: normalizeVerilogSyntax(candidate.verilog?.syntax),
      implicitNet: {
        ...defaultCoSettings.verilog.implicitNet,
        ...(candidate.verilog?.implicitNet ?? {})
      },
      lint: {
        ...defaultCoSettings.verilog.lint,
        ...(candidate.verilog?.lint ?? {}),
        disabledRules: normalizeDisabledRules(candidate.verilog?.lint?.disabledRules)
      },
      format: normalizeVerilogFormat(candidate.verilog?.format)
    }
  };
}

function normalizeVerilogSyntax(value: unknown): CoSettings['verilog']['syntax'] {
  const candidate = typeof value === 'object' && value !== null
    ? value as Partial<CoSettings['verilog']['syntax']>
    : {};
  const iseCandidate = typeof candidate.ise === 'object' && candidate.ise !== null
    ? candidate.ise as Partial<CoSettings['verilog']['syntax']['ise']>
    : {};
  const mode = iseCandidate.mode === 'off' || iseCandidate.mode === 'commandOnly' || iseCandidate.mode === 'onSave'
    ? iseCandidate.mode
    : defaultCoSettings.verilog.syntax.ise.mode;
  return {
    ise: {
      enabled: typeof iseCandidate.enabled === 'boolean' ? iseCandidate.enabled : defaultCoSettings.verilog.syntax.ise.enabled,
      mode,
      timeoutMs: normalizeInteger(iseCandidate.timeoutMs, defaultCoSettings.verilog.syntax.ise.timeoutMs, 0, 600000),
      suppressedWarnings: normalizeStringArray(iseCandidate.suppressedWarnings, defaultCoSettings.verilog.syntax.ise.suppressedWarnings)
    }
  };
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))].sort();
}

export function isVerilogLintRuleEnabled(settings: CoSettings, rule: string): boolean {
  const normalized = rule.toLowerCase();
  return !settings.verilog.lint.disabledRules.some((item) => item.toLowerCase() === normalized);
}

export function diagnosticCodeKey(languageId: string, code: string): string {
  return `${languageId.trim().toLowerCase()}:${code.trim().toLowerCase()}`;
}

export function diagnosticFileCodeKey(languageId: string, code: string, documentUri: string): string {
  return `${diagnosticCodeKey(languageId, code)}@${documentUri.trim()}`;
}

export function diagnosticCodeToString(code: unknown): string | undefined {
  if (typeof code !== 'string' && typeof code !== 'number') {
    return undefined;
  }
  const normalized = String(code).trim().toLowerCase();
  return normalized && /^\S+$/.test(normalized) ? normalized : undefined;
}

export function isDiagnosticCodeDisabled(settings: CoSettings, languageId: string, code: unknown): boolean {
  const normalized = diagnosticCodeToString(code);
  if (!normalized) {
    return false;
  }
  const languageKey = diagnosticCodeKey(languageId, normalized);
  return settings.diagnostics.disabledCodes.some((item) => item === languageKey || item === normalized);
}

export function isDiagnosticCodeDisabledForFile(
  settings: CoSettings,
  languageId: string,
  code: unknown,
  documentUri: string | undefined
): boolean {
  const normalized = diagnosticCodeToString(code);
  if (!normalized) {
    return false;
  }
  if (isDiagnosticCodeDisabled(settings, languageId, normalized)) {
    return true;
  }
  if (!documentUri?.trim()) {
    return false;
  }
  const fileKey = diagnosticFileCodeKey(languageId, normalized, documentUri);
  const codeOnlyFileKey = `${normalized}@${documentUri.trim()}`;
  return settings.diagnostics.disabledFileCodes.some((item) => item === fileKey || item === codeOnlyFileKey);
}

function normalizeDisabledDiagnosticCodes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...defaultCoSettings.diagnostics.disabledCodes];
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => Boolean(item) && /^\S+$/.test(item)))].sort();
}

function normalizeDisabledDiagnosticFileCodes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...defaultCoSettings.diagnostics.disabledFileCodes];
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeDiagnosticFileCode(item))
    .filter((item): item is string => Boolean(item)))].sort();
}

function normalizeDiagnosticFileCode(value: string): string | undefined {
  const trimmed = value.trim();
  const separator = trimmed.indexOf('@');
  if (separator <= 0 || separator === trimmed.length - 1) {
    return undefined;
  }
  const codePart = trimmed.slice(0, separator).trim();
  const uriPart = trimmed.slice(separator + 1).trim();
  if (!uriPart || /\s/.test(uriPart)) {
    return undefined;
  }
  const normalizedCodePart = normalizeDisabledDiagnosticCodes([codePart])[0];
  return normalizedCodePart ? `${normalizedCodePart}@${uriPart}` : undefined;
}

function normalizeDisabledRules(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...defaultCoSettings.verilog.lint.disabledRules];
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => configurableVerilogLintRuleSet.has(item)))];
}

type VerilogFormatAlignmentCandidate = {
  parameter?: unknown;
  modulePort?: unknown;
  ternary?: unknown;
};

type VerilogFormatCandidate = Partial<Omit<
  CoSettings['verilog']['format'],
  'parameterAlignment' | 'modulePortAlignment' | 'ternaryAlignment'
>> & {
  alignment?: VerilogFormatAlignmentCandidate;
};

function normalizeVerilogFormat(value: unknown): CoSettings['verilog']['format'] {
  const candidate = typeof value === 'object' && value !== null
    ? value as VerilogFormatCandidate
    : {};
  const alignment = typeof candidate.alignment === 'object' && candidate.alignment !== null && !Array.isArray(candidate.alignment)
    ? candidate.alignment
    : {};
  const preset = defaultCoSettings.verilog.format;
  return {
    ...preset,
    continuationIndent: normalizeInteger(candidate.continuationIndent, preset.continuationIndent, 1, 4),
    spaceInRange: typeof candidate.spaceInRange === 'boolean' ? candidate.spaceInRange : preset.spaceInRange,
    declarationRangeSpacing: normalizeDeclarationRangeSpacing(candidate.declarationRangeSpacing, preset.declarationRangeSpacing),
    spaceBeforeInstancePorts: typeof candidate.spaceBeforeInstancePorts === 'boolean' ? candidate.spaceBeforeInstancePorts : preset.spaceBeforeInstancePorts,
    separateElse: typeof candidate.separateElse === 'boolean' ? candidate.separateElse : preset.separateElse,
    maxBlankLines: normalizeInteger(candidate.maxBlankLines, preset.maxBlankLines, 0, 3),
    parameterAlignment: normalizeParameterAlignment(alignment.parameter, preset.parameterAlignment),
    modulePortAlignment: normalizeModulePortAlignment(alignment.modulePort, preset.modulePortAlignment),
    ternaryAlignment: normalizeTernaryAlignment(alignment.ternary, preset.ternaryAlignment)
  };
}

function normalizeDeclarationRangeSpacing(
  value: unknown,
  fallback: CoSettings['verilog']['format']['declarationRangeSpacing']
): CoSettings['verilog']['format']['declarationRangeSpacing'] {
  return value === 'space' || value === 'compact' || value === 'preserve' ? value : fallback;
}

function normalizeParameterAlignment(
  value: unknown,
  fallback: CoSettings['verilog']['format']['parameterAlignment']
): CoSettings['verilog']['format']['parameterAlignment'] {
  return value === 'none' || value === 'equals' ? value : fallback;
}

function normalizeModulePortAlignment(
  value: unknown,
  fallback: CoSettings['verilog']['format']['modulePortAlignment']
): CoSettings['verilog']['format']['modulePortAlignment'] {
  return value === 'none' || value === 'name' ? value : fallback;
}

function normalizeTernaryAlignment(
  value: unknown,
  fallback: CoSettings['verilog']['format']['ternaryAlignment']
): CoSettings['verilog']['format']['ternaryAlignment'] {
  return value === 'none' || value === 'question' ? value : fallback;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
