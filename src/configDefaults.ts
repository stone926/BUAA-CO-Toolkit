// @index config-defaults — 从 resources/co/configDefaults.json 加载 co.* 默认值
import * as fs from 'fs';
import * as path from 'path';

export type ConfigDefaultValue = string | number | boolean | string[] | Record<string, unknown>;
export type ConfigDefaults = Record<string, ConfigDefaultValue>;

const configDefaults = loadConfigDefaults();

export function getConfigDefaults(): ConfigDefaults {
  return cloneDefault(configDefaults) as ConfigDefaults;
}

export function configDefault<T extends ConfigDefaultValue>(key: string): T {
  if (!Object.prototype.hasOwnProperty.call(configDefaults, key)) {
    throw new Error(`Missing co.${key} default in configDefaults.json.`);
  }
  return cloneDefault(configDefaults[key]) as T;
}

export function configDefaultArray<T extends string = string>(key: string): T[] {
  const value = configDefault<ConfigDefaultValue>(key);
  if (!Array.isArray(value)) {
    throw new Error(`co.${key} default must be an array.`);
  }
  return value.map((item) => String(item) as T);
}

function loadConfigDefaults(): ConfigDefaults {
  const filePath = path.join(__dirname, '..', 'resources', 'co', 'configDefaults.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('configDefaults.json must contain an object.');
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!isSupportedDefaultValue(value)) {
      throw new Error(`Unsupported default value for co.${key}.`);
    }
  }
  return parsed as ConfigDefaults;
}

function isSupportedDefaultValue(value: unknown): value is ConfigDefaultValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string');
  }
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDefault(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (isRecord(value)) {
    return { ...value };
  }
  return value;
}
