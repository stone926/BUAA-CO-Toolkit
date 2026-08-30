import * as fs from 'fs';
import * as path from 'path';
import { ProjectProfile } from './projectProfile';

export interface ProfileConfig {
  name: string;
  description: string;
  language: string;
  directories: string[];
  requiredTools: string[];
  capabilities?: Partial<Record<ProfileCapability, boolean>>;
  defaults?: Partial<ProfileDefaults>;
}

export type ProfileCapability =
  | 'trace'
  | 'verilog'
  | 'mips'
  | 'logisim'
  | 'hazard'
  | 'delayedBranching'
  | 'cpuHalt'
  | 'asmNeededForVerilog';

export interface ProfileDefaults {
  topModule: string;
  testbench: string;
  machineCode: string;
  simTime: string;
}

export interface PortConfig {
  name: string;
  direction: 'input' | 'output';
  width: number;
}

export interface LogisimTraceColumnConfig {
  width: number;
  required?: boolean;
  aliases?: string[];
}

export interface LogisimTraceProfileConfig {
  defaultCircuit: string;
  textBase: string;
  romMaxWords: number;
  haltLoopWords: number;
  pcAlignmentBytes?: number;
  stuckPcRowLimit?: number;
  haltLabel: string;
  orderedColumns: string[];
  columns: Record<string, LogisimTraceColumnConfig>;
}

export interface ProfileInferenceStructureConfig {
  cp0ModuleNames?: string[];
  cp0ModuleNameIncludes?: string[];
  cp0DeclarationHints?: string[];
  bridgeModuleNames?: string[];
  timerModuleNames?: string[];
}

export interface ProfileInferenceConfig {
  topModuleNames?: string[];
  p6RequiredPorts?: string[];
  p7ExclusivePorts?: string[];
  p7Structure?: ProfileInferenceStructureConfig;
  logisimCpuPathPatterns?: string[];
}

export interface MemoryRange {
  min: string;
  max: string;
  label: string;
}

export interface CourseConfig {
  memoryLayout: Record<string, Record<string, MemoryRange>>;
  verilogTestbench?: {
    externalInstructionMemoryWords?: number;
    externalDataMemoryWords?: number;
  };
  profiles: Record<string, ProfileConfig>;
  verilogPorts: Record<string, PortConfig[]>;
  profileInference?: ProfileInferenceConfig;
  logisimTrace?: Record<string, LogisimTraceProfileConfig>;
  traceFormatPatterns: Record<string, string[]>;
  directiveDescriptions: Record<string, string>;
  directiveDetails: Record<string, { description: string; commonValues?: Record<string, string> }>;
}

let courseConfig: CourseConfig | undefined;

function loadCourseConfig(): CourseConfig {
  if (courseConfig) {
    return courseConfig;
  }
  const configPath = path.join(__dirname, '..', 'resources', 'co', 'courseConfig.json');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    courseConfig = JSON.parse(content) as CourseConfig;
    return courseConfig;
  } catch (error) {
    console.error('Failed to load course config:', error);
    return {
      memoryLayout: {},
      verilogTestbench: {},
      profiles: {},
      verilogPorts: {},
      logisimTrace: {},
      traceFormatPatterns: {},
      directiveDescriptions: {},
      directiveDetails: {}
    };
  }
}

export function getProfileConfig(profile: string): ProfileConfig | undefined {
  return loadCourseConfig().profiles[profile];
}

export function getProfileDescription(profile: string): string {
  const config = getProfileConfig(profile);
  return config?.description ?? '';
}

export function getProfileName(profile: string): string {
  const config = getProfileConfig(profile);
  return config?.name ?? profile;
}

export function getProfileDirectories(profile: string): string[] {
  const config = getProfileConfig(profile);
  return config?.directories ?? ['.co'];
}

export function getProfileRequiredTools(profile: string): string[] {
  const config = getProfileConfig(profile);
  return config?.requiredTools ?? [];
}

export function getProfileCapabilities(profile: string): Partial<Record<ProfileCapability, boolean>> {
  return getProfileConfig(profile)?.capabilities ?? {};
}

export function getProfileDefaults(profile: string): Partial<ProfileDefaults> {
  return getProfileConfig(profile)?.defaults ?? {};
}

export function profilesWithCapability(capability: ProfileCapability): ProjectProfile[] {
  return Object.entries(loadCourseConfig().profiles)
    .filter(([, config]) => config.capabilities?.[capability] === true)
    .map(([profile]) => profile as ProjectProfile);
}

export function getVerilogPorts(profile: string): PortConfig[] {
  return loadCourseConfig().verilogPorts[profile] ?? [];
}

export function getLogisimTraceProfileConfig(profile: string): LogisimTraceProfileConfig | undefined {
  return loadCourseConfig().logisimTrace?.[profile];
}

export function getProfileInferenceConfig(): ProfileInferenceConfig {
  return loadCourseConfig().profileInference ?? {};
}

export function getVerilogTestbenchConfig(): {
  externalInstructionMemoryWords: number;
  externalDataMemoryWords: number;
} {
  const configured = loadCourseConfig().verilogTestbench;
  return {
    externalInstructionMemoryWords: positiveIntegerOr(configured?.externalInstructionMemoryWords, 4096),
    externalDataMemoryWords: positiveIntegerOr(configured?.externalDataMemoryWords, 3072)
  };
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 从 courseConfig.json 推导 expectedPorts（Verilog 端口期望定义）。
 * 单比特端口（width === 1）→ undefined（仅检查存在，不检查宽度）；
 * 多比特端口 → Verilog range 格式 `[N-1:0]`。
 */
export function buildExpectedPorts(profile: string): Record<string, string | undefined> {
  const ports = getVerilogPorts(profile);
  const result: Record<string, string | undefined> = {};
  for (const port of ports) {
    result[port.name] = port.width > 1 ? `[${port.width - 1}:0]` : undefined;
  }
  return result;
}

export function getTraceFormatPatterns(profile: string): string[] {
  return loadCourseConfig().traceFormatPatterns[profile] ?? [];
}

export function getMemoryRange(section: string): MemoryRange | undefined {
  const layout = loadCourseConfig().memoryLayout['CompactDataAtZero'];
  return layout?.[section];
}

export function getDirectiveDescription(directive: string): string | undefined {
  return loadCourseConfig().directiveDescriptions[directive];
}

export function getDirectiveDetail(directive: string): { description: string; commonValues?: Record<string, string> } | undefined {
  return loadCourseConfig().directiveDetails[directive];
}

export function getCourseConfig(): CourseConfig {
  return loadCourseConfig();
}
