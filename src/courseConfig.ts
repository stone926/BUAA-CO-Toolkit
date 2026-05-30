import * as fs from 'fs';
import * as path from 'path';

export interface ProfileConfig {
  name: string;
  description: string;
  language: string;
  directories: string[];
  requiredTools: string[];
}

export interface PortConfig {
  name: string;
  direction: 'input' | 'output';
  width: number;
}

export interface MemoryRange {
  min: string;
  max: string;
  label: string;
}

export interface CourseConfig {
  memoryLayout: Record<string, Record<string, MemoryRange>>;
  profiles: Record<string, ProfileConfig>;
  verilogPorts: Record<string, PortConfig[]>;
  directiveDescriptions: Record<string, string>;
  directiveDetails: Record<string, { description: string; commonValues?: Record<string, string> }>;
}

let courseConfig: CourseConfig | undefined;

function loadCourseConfig(): CourseConfig {
  if (courseConfig) {
    return courseConfig;
  }
  const configPath = path.join(__dirname, '..', '..', 'resources', 'co', 'courseConfig.json');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    courseConfig = JSON.parse(content) as CourseConfig;
    return courseConfig;
  } catch (error) {
    console.error('Failed to load course config:', error);
    return {
      memoryLayout: {},
      profiles: {},
      verilogPorts: {},
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

export function getVerilogPorts(profile: string): PortConfig[] {
  return loadCourseConfig().verilogPorts[profile] ?? [];
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
