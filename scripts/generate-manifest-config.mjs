import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const packagePath = path.join(root, 'package.json');
const configManifestPath = path.join(root, 'resources', 'co', 'configManifest.json');
const configDefaultsPath = path.join(root, 'resources', 'co', 'configDefaults.json');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Generated files are written with LF; a CRLF checkout must still compare equal. */
function normalizeToLf(text) {
  return text.replace(/\r\n/g, '\n');
}

function writeJsonIfChanged(filePath, value) {
  const next = stableJson(value);
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (normalizeToLf(previous) === normalizeToLf(next)) {
    return false;
  }
  if (checkOnly) {
    throw new Error(`${path.relative(root, filePath)} is not generated from current resources.`);
  }
  fs.writeFileSync(filePath, next);
  return true;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function propertyMap(groups) {
  const properties = {};
  for (const group of groups) {
    for (const [key, property] of Object.entries(group.properties ?? {})) {
      if (!key.startsWith('co.') || Object.hasOwn(properties, key)) {
        throw new Error(`Invalid or duplicate setting key: ${key}`);
      }
      properties[key] = property;
    }
  }
  return properties;
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function generatorInstructionDescription() {
  return '自动测试重点覆盖的真实指令。用逗号或空白分隔；留空时覆盖当前 Profile 的完整课程指令集。测试规模、中断、异常、外设和持续测试策略由插件自动使用最强安全配置。';
}

function generatorInstructionMarkdownDescription(generatorProfiles) {
  const profiles = generatorProfiles.profiles;
  const defaultProfiles = Object.keys(profiles)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((profile) => `- **${profile}**: \`${profiles[profile].join(', ')}\``)
    .join('\n');
  return [
    '自动测试重点覆盖的真实指令。测试脚手架所需指令由插件内部管理，不需要手工加入。',
    '',
    '- 用逗号或任意数量空白分隔。',
    '- 只接受真实指令，不接受伪指令。',
    '- 留空时使用当前 Profile 的默认指令集。',
    '',
    '各 Profile 默认指令集：',
    defaultProfiles
  ].join('\n');
}

function deriveConfigDefaults(groups, { lintRules }) {
  const defaults = {};
  for (const [key, property] of Object.entries(propertyMap(groups))) {
    const hasDefault = Object.hasOwn(property, 'runtimeDefault');
    if (hasDefault === Object.hasOwn(property, 'defaultFrom')) {
      throw new Error(`${key} must declare exactly one runtimeDefault or defaultFrom.`);
    }
    if (hasDefault) {
      defaults[key.slice(3)] = clone(property.runtimeDefault);
    } else if (property.defaultFrom === 'disabledVerilogLintRules') {
      defaults[key.slice(3)] = lintRules
        .filter((rule) => rule.configurable && !rule.enabledByDefault)
        .map((rule) => rule.id);
    } else {
      throw new Error(`Unknown default source for ${key}: ${property.defaultFrom}`);
    }
    const value = defaults[key.slice(3)];
    const type = Array.isArray(value) ? 'array' : typeof value;
    if (type !== property.type || (property.enum && !property.enum.includes(value))) {
      throw new Error(`Invalid runtime default for ${key}.`);
    }
  }
  return sortedObject(defaults);
}

function applyGeneratedSchema(groups, defaults, resources) {
  const generated = clone(groups);
  const properties = propertyMap(generated);

  for (const [key, property] of Object.entries(properties)) {
    delete property.runtimeDefault;
    delete property.defaultFrom;
    // Deprecated compatibility settings intentionally have no contributed
    // default. VS Code then keeps them out of the normal Settings UI while
    // still recognizing values already present in older workspaces.
    if (property.deprecationMessage) {
      delete property.default;
      continue;
    }
    const defaultKey = key.replace(/^co\./, '');
    if (!Object.prototype.hasOwnProperty.call(defaults, defaultKey)) {
      throw new Error(`Public setting ${key} has no internal default in configDefaults.json.`);
    }
    // A schema may intentionally provide a UI sentinel (for example an empty
    // project override whose effective value comes from the selected Profile).
    if (!Object.prototype.hasOwnProperty.call(property, 'default')) {
      property.default = clone(defaults[defaultKey]);
    }
  }

  const { courseConfig, generatorProfiles, lintRules } = resources;
  const profileIds = Object.keys(courseConfig.profiles);
  properties['co.project.profile'].enum = ['auto', ...profileIds];
  properties['co.project.profile'].enumDescriptions = [
    '根据当前工作区内容自动推断 Profile',
    ...profileIds.map((profile) => courseConfig.profiles[profile]?.name ?? profile)
  ];

  properties['co.test.instructions'].description = generatorInstructionDescription();
  properties['co.test.instructions'].markdownDescription =
    generatorInstructionMarkdownDescription(generatorProfiles);
  properties['co.verilog.lint.disabledRules'].items.enum = lintRules
    .filter((rule) => rule.configurable).map((rule) => rule.id);

  return generated;
}

function main() {
  const pkg = readJson(packagePath);
  if ([...args].some((arg) => arg !== '--check')) {
    throw new Error('Only --check is supported; edit resources/co/configManifest.json.');
  }
  const configManifest = readJson(configManifestPath);
  const courseConfig = readJson(path.join(root, 'resources', 'co', 'courseConfig.json'));
  const generatorProfiles = readJson(path.join(root, 'resources', 'mips', 'generatorProfiles.json'));
  const lintRules = readJson(path.join(root, 'resources', 'verilog', 'lintRules.json'));
  const resources = { courseConfig, generatorProfiles, lintRules };

  const nextDefaults = deriveConfigDefaults(configManifest, resources);
  writeJsonIfChanged(configDefaultsPath, nextDefaults);

  pkg.contributes.configuration = applyGeneratedSchema(configManifest, nextDefaults, resources);
  writeJsonIfChanged(packagePath, pkg);

  if (!checkOnly) {
    console.log('Generated package.json contributes.configuration and resources/co/configDefaults.json.');
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
