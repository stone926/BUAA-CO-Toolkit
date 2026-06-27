// @index profile-resolver — 基于端口签名+trace格式推断CPU Profile(P4-P7)
import {
  ConcreteProjectProfile,
  ProjectProfile,
  isConcreteProjectProfile
} from './projectProfile';
import { extractVerilogDisplayFormats } from './language/verilog/displayFormats';
import { getTraceFormatPatterns } from './courseConfig';

export type ProfileConfiguredSource = 'settings' | 'default';
export type ProfileResolutionSource = ProfileConfiguredSource | 'inferred' | 'manualFallback';
export type ProfileInferenceConfidence = 'explicit' | 'strong' | 'weak' | 'none';

export interface ProfileResolverPort {
  name: string;
  direction?: 'input' | 'output' | 'inout';
  width?: string;
}

export interface ProfileResolverDeclaration {
  name: string;
}

export interface ProfileResolverInstance {
  moduleName: string;
}

export interface ProfileResolverModule {
  name: string;
  ports: ProfileResolverPort[];
  declarations?: {
    values(): Iterable<ProfileResolverDeclaration>;
  };
  instances?: ProfileResolverInstance[];
  bodyText?: string;
  uri?: string;
}

export interface ProfileResolverFile {
  path: string;
  languageId?: string;
}

export interface ProfileResolverInput {
  configuredProfile?: ProjectProfile;
  configuredSource?: ProfileConfiguredSource;
  topModule?: string;
  activeLanguageId?: string;
  activeFilePath?: string;
  files?: ProfileResolverFile[];
  modules?: ProfileResolverModule[];
  verilogTexts?: string[];
  verilogDisplayFormats?: string[];
}

export interface ProfileResolution {
  configuredProfile: ProjectProfile;
  configuredSource: ProfileConfiguredSource;
  effectiveProfile?: ConcreteProjectProfile;
  source: ProfileResolutionSource;
  confidence: ProfileInferenceConfidence;
  reason: string;
  candidates: ConcreteProjectProfile[];
}

interface Candidate {
  profile: ConcreteProjectProfile;
  confidence: Exclude<ProfileInferenceConfidence, 'explicit' | 'none'>;
  reason: string;
}

const p7ExclusivePorts = new Set(['interrupt', 'macroscopic_pc', 'm_int_addr', 'm_int_byteen']);
const p6RequiredPorts = [
  'clk',
  'reset',
  'i_inst_rdata',
  'm_data_rdata',
  'i_inst_addr',
  'm_data_addr',
  'm_data_wdata',
  'm_data_byteen',
  'm_inst_addr',
  'w_grf_addr',
  'w_grf_wdata',
  'w_grf_we',
  'w_inst_addr'
];

export function resolveProjectProfile(input: ProfileResolverInput): ProfileResolution {
  const configuredProfile = input.configuredProfile ?? 'auto';
  const configuredSource = input.configuredSource ?? 'default';
  if (isConcreteProjectProfile(configuredProfile)) {
    return {
      configuredProfile,
      configuredSource,
      effectiveProfile: configuredProfile,
      source: configuredSource,
      confidence: 'explicit',
      reason: `profile is explicitly configured as ${configuredProfile}`,
      candidates: [configuredProfile]
    };
  }

  const candidates = inferCandidates(input);
  const profiles = uniqueProfiles(candidates);
  if (profiles.length === 1) {
    const profile = profiles[0];
    const candidate = candidates.find((item) => item.profile === profile);
    return {
      configuredProfile: 'auto',
      configuredSource,
      effectiveProfile: profile,
      source: 'inferred',
      confidence: candidate?.confidence ?? 'strong',
      reason: candidate?.reason ?? `inferred ${profile}`,
      candidates: profiles
    };
  }

  return {
    configuredProfile: 'auto',
    configuredSource,
    source: 'inferred',
    confidence: 'none',
    reason: profiles.length > 1
      ? `conflicting profile evidence: ${profiles.join(', ')}`
      : 'not enough project evidence to infer a concrete profile',
    candidates: profiles
  };
}

export function applyResolvedProfile<T extends { project: { profile: ProjectProfile; topModule: string } }>(
  settings: T,
  input: Omit<ProfileResolverInput, 'configuredProfile' | 'configuredSource' | 'topModule'>
): T {
  const resolution = resolveProjectProfile({
    ...input,
    configuredProfile: settings.project.profile,
    configuredSource: 'settings',
    topModule: settings.project.topModule
  });
  if (!resolution.effectiveProfile || resolution.effectiveProfile === settings.project.profile) {
    return settings;
  }
  return {
    ...settings,
    project: {
      ...settings.project,
      profile: resolution.effectiveProfile
    }
  };
}

function inferCandidates(input: ProfileResolverInput): Candidate[] {
  const modules = input.modules ?? [];
  const files = normalizedFiles(input);
  const top = findTopModule(modules, input.topModule);
  const candidates: Candidate[] = [];

  const p7ByPorts = top && hasAnyPort(top, p7ExclusivePorts);
  const p6ByPorts = top && hasAllPorts(top, p6RequiredPorts) && !hasAnyPort(top, p7ExclusivePorts);
  const p7ByStructure = hasP7Structure(modules);

  if (p7ByPorts) {
    candidates.push({
      profile: 'P7',
      confidence: 'strong',
      reason: `top module '${top.name}' exposes P7-only interrupt/peripheral ports`
    });
  }

  if (p7ByStructure && !p6ByPorts) {
    candidates.push({
      profile: 'P7',
      confidence: 'strong',
      reason: 'workspace contains CP0/Bridge/TC-style P7 structure'
    });
  }

  if (p6ByPorts && !p7ByPorts && !p7ByStructure) {
    candidates.push({
      profile: 'P6',
      confidence: 'strong',
      reason: `top module '${top.name}' matches the P6 external memory interface`
    });
  }

  if (top && isClockResetOnlyTop(top) && !p7ByPorts && !p6ByPorts && !p7ByStructure) {
    const traceProfile = inferP4P5FromTraceFormats(input, top);
    if (traceProfile) {
      candidates.push(traceProfile);
    }
  }

  if (candidates.length) {
    return candidates;
  }

  const hasVerilog = modules.length > 0 || files.some((file) => file.kind === 'verilog');
  const hasAsm = isAsmLanguage(input.activeLanguageId) || files.some((file) => file.kind === 'asm');
  const hasCircuit = isCircuitPath(input.activeFilePath) || files.some((file) => file.kind === 'circ');
  const hasCpuLikeTop = Boolean(top && (isClockResetOnlyTop(top) || hasAnyPort(top, p7ExclusivePorts) || hasAllPorts(top, p6RequiredPorts)));

  if (hasVerilog && !hasCpuLikeTop && !hasAsm && !hasCircuit) {
    return [{
      profile: 'P1',
      confidence: 'weak',
      reason: 'workspace looks like a standalone Verilog exercise without CPU top-level evidence'
    }];
  }

  if (hasAsm && !hasVerilog && !hasCircuit) {
    return [{
      profile: 'P2',
      confidence: 'weak',
      reason: 'workspace or active file is ASM-only'
    }];
  }

  if (hasCircuit && !hasVerilog) {
    return [{
      profile: looksLikeLogisimCpuProject(files) || hasAsm ? 'P3' : 'P0',
      confidence: 'weak',
      reason: hasAsm || looksLikeLogisimCpuProject(files)
        ? 'Logisim project contains CPU-test evidence'
        : 'workspace or active file is Logisim-only'
    }];
  }

  return [];
}

function inferP4P5FromTraceFormats(input: ProfileResolverInput, top: ProfileResolverModule): Candidate | undefined {
  const formats = input.verilogDisplayFormats ?? [
    top.bodyText ?? '',
    ...(input.verilogTexts ?? []),
    ...(input.modules ?? []).map((module) => module.bodyText ?? '')
  ].filter(Boolean).flatMap(extractVerilogDisplayFormats);
  const hasP4 = formats.some(looksLikeP4TraceFormat);
  const hasP5 = formats.some(looksLikeP5TraceFormat);
  if (hasP4 === hasP5) {
    return undefined;
  }
  return hasP5
    ? {
      profile: 'P5',
      confidence: 'strong',
      reason: 'workspace $display trace format includes a timestamp prefix'
    }
    : {
      profile: 'P4',
      confidence: 'strong',
      reason: 'workspace $display trace format omits the timestamp prefix'
    };
}

function findTopModule(modules: ProfileResolverModule[], topName?: string): ProfileResolverModule | undefined {
  const wanted = (topName?.trim() || 'mips').toLowerCase();
  return modules.find((module) => module.name.toLowerCase() === wanted)
    ?? modules.find((module) => module.name.toLowerCase() === 'mips')
    ?? modules.find((module) => module.name.toLowerCase() === 'cpu');
}

function hasAllPorts(module: ProfileResolverModule, names: readonly string[]): boolean {
  const ports = new Set(module.ports.map((port) => port.name));
  return names.every((name) => ports.has(name));
}

function hasAnyPort(module: ProfileResolverModule, names: ReadonlySet<string>): boolean {
  return module.ports.some((port) => names.has(port.name));
}

function isClockResetOnlyTop(module: ProfileResolverModule): boolean {
  const ports = module.ports.map((port) => port.name).sort();
  return ports.length === 2 && ports[0] === 'clk' && ports[1] === 'reset';
}

function hasP7Structure(modules: ProfileResolverModule[]): boolean {
  const names = new Set(modules.map((module) => module.name.toLowerCase()));
  const hasCp0 = names.has('cp0') || modules.some((module) =>
    module.name.toLowerCase().includes('cp0') && hasAnyDeclaration(module, ['sr', 'cause', 'epc'])
  );
  const hasBridge = names.has('bridge');
  const hasTimer = names.has('tc') || names.has('timer') || names.has('timer0') || names.has('timer1');
  return hasCp0 && hasBridge && hasTimer;
}

function hasAnyDeclaration(module: ProfileResolverModule, names: readonly string[]): boolean {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const declaration of module.declarations?.values() ?? []) {
    if (wanted.has(declaration.name.toLowerCase())) {
      return true;
    }
  }
  return false;
}

const tracePatternCache = new Map<string, RegExp[]>();

function getTracePatterns(profile: string): RegExp[] {
  const cached = tracePatternCache.get(profile);
  if (cached) { return cached; }
  const patterns = getTraceFormatPatterns(profile).map((s) => new RegExp(s, 'i'));
  tracePatternCache.set(profile, patterns);
  return patterns;
}

function looksLikeP5TraceFormat(format: string): boolean {
  const normalized = normalizeTraceFormat(format);
  return getTracePatterns('P5').some((re) => re.test(normalized));
}

function looksLikeP4TraceFormat(format: string): boolean {
  const normalized = normalizeTraceFormat(format);
  return !looksLikeP5TraceFormat(format)
    && getTracePatterns('P4').some((re) => re.test(normalized));
}

function normalizeTraceFormat(format: string): string {
  return format.replace(/\s+/g, '').toLowerCase();
}

function uniqueProfiles(candidates: Candidate[]): ConcreteProjectProfile[] {
  return [...new Set(candidates.map((candidate) => candidate.profile))];
}

function normalizedFiles(input: ProfileResolverInput): Array<ProfileResolverFile & { kind: 'verilog' | 'asm' | 'circ' | 'other' }> {
  const files = [...(input.files ?? [])];
  if (input.activeFilePath) {
    files.push({
      path: input.activeFilePath,
      languageId: input.activeLanguageId
    });
  }
  return files.map((file) => ({ ...file, kind: fileKind(file) }));
}

function fileKind(file: ProfileResolverFile): 'verilog' | 'asm' | 'circ' | 'other' {
  if (file.languageId === 'verilog') {
    return 'verilog';
  }
  if (isAsmLanguage(file.languageId)) {
    return 'asm';
  }
  if (file.languageId === 'logisim-circ' || isCircuitPath(file.path)) {
    return 'circ';
  }
  const lower = file.path.toLowerCase();
  if (lower.endsWith('.v')) {
    return 'verilog';
  }
  if (/\.(asm|s|mips)$/.test(lower)) {
    return 'asm';
  }
  return isCircuitPath(lower) ? 'circ' : 'other';
}

function isAsmLanguage(languageId: string | undefined): boolean {
  return languageId === 'mipsasm';
}

function isCircuitPath(value: string | undefined): boolean {
  return Boolean(value?.toLowerCase().split(/[?#]/, 1)[0].endsWith('.circ'));
}

function looksLikeLogisimCpuProject(files: Array<ProfileResolverFile & { kind: string }>): boolean {
  return files.some((file) => {
    const lower = file.path.toLowerCase().replace(/\\/g, '/');
    return /(^|\/)(p3|cpu|rom|test|code\.txt)(\/|$)/.test(lower) || /(^|\/)code\.txt$/.test(lower);
  });
}
