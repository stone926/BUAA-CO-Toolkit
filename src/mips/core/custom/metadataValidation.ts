// @index mips-core — Validate declarative generation, access and timing facts before registration
import type { CustomInstructionDefinition } from './api';
import type { CustomEncodingField } from './registry';

export function validateCustomMetadata(definition: CustomInstructionDefinition, fields: readonly CustomEncodingField[]): void {
  const fail = (message: string): never => { throw new Error(`${definition.mnemonic}: ${message}`); };
  const object = (value: unknown, label: string): void => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); };
  const integer = (value: unknown, min: number, max: number, label: string): void => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer in ${min}..${max}`); };
  const width = (value: unknown, label: string): void => { if (value !== undefined && value !== 1 && value !== 2 && value !== 4) fail(`${label} must be 1, 2 or 4`); };
  const registerFields = new Set(definition.operands.flatMap(operand => operand.kind === 'register' ? [operand.field] : operand.kind === 'memory' ? [operand.baseField] : []));
  const field = (name: string, registerOnly = false): CustomEncodingField => {
    const found = fields.find(item => item.name === name);
    if (!found || (registerOnly && !registerFields.has(name))) return fail(`Unknown ${registerOnly ? 'GPR ' : ''}field ${name}`);
    return found;
  };
  for (const operand of definition.operands) {
    if (operand.kind !== 'register' && operand.signed !== undefined && typeof operand.signed !== 'boolean') fail('Operand signed flag must be boolean');
    if (operand.kind === 'immediate' && operand.relocation === 'jump' && field(operand.field).width !== 26) fail('Jump relocation requires a 26-bit field');
  }
  const access = definition.access;
  if (access !== undefined) {
    object(access, 'access'); width(access.width, 'access.width');
    if (access.memory !== undefined && access.memory !== 'load' && access.memory !== 'store') fail('access.memory must be load or store');
    for (const [label, names] of [['reads', access.reads], ['writes', access.writes]] as const) {
      if (names === undefined) continue;
      if (!Array.isArray(names) || names.length > 64) fail(`access.${label} must be an array of at most 64 names`);
      for (const name of names) if (typeof name !== 'string' || (!['hi', 'lo', 'dynamic'].includes(name) && !/^\$(?:[0-9]|[12][0-9]|3[01])$/.test(name) && !registerFields.has(name))) fail(`Invalid access field ${String(name)}`);
    }
  }
  const generation = definition.generation;
  if (generation !== undefined) {
    object(generation, 'generation');
    if (generation.weight !== undefined) integer(generation.weight, 1, 1000, 'generation.weight');
    if (generation.fields !== undefined) {
      object(generation.fields, 'generation.fields');
      for (const [name, limits] of Object.entries(generation.fields)) {
        const item = field(name); object(limits, `generation.fields.${name}`);
        const minimum = -(2 ** (item.width - 1)), maximum = 2 ** item.width - 1;
        if (limits.min !== undefined) integer(limits.min, minimum, maximum, `${name}.min`);
        if (limits.max !== undefined) integer(limits.max, minimum, maximum, `${name}.max`);
        if (limits.min !== undefined && limits.max !== undefined && limits.min > limits.max) fail(`${name}: min exceeds max`);
        if (limits.values !== undefined) {
          if (!Array.isArray(limits.values) || limits.values.length === 0 || limits.values.length > 256) fail(`${name}.values must contain 1..256 values`);
          for (const value of limits.values) integer(value, minimum, maximum, `${name}.values`);
        }
        if (limits.address !== undefined) { field(name, true); object(limits.address, `${name}.address`); width(limits.address.alignment, `${name}.alignment`); width(limits.address.width, `${name}.width`); }
      }
    }
    if (generation.control !== undefined) {
      object(generation.control, 'generation.control'); field(generation.control.targetField);
      if (!definition.controlFlow || !['branch', 'jump', 'absolute'].includes(generation.control.relocation)) fail('generation.control requires controlFlow and a supported relocation');
      if (generation.control.shiftBy !== undefined) { object(generation.control.shiftBy, 'generation.control.shiftBy'); field(generation.control.shiftBy.field, true); integer(generation.control.shiftBy.mask, 0, 31, 'generation.control.shiftBy.mask'); }
    }
    if (generation.cases !== undefined) {
      if (!Array.isArray(generation.cases) || generation.cases.length === 0 || generation.cases.length > 256) fail('generation.cases must contain 1..256 cases');
      for (const item of generation.cases) {
        object(item, 'generation case'); object(item.registerValues, 'generation case registerValues');
        if (Object.keys(item.registerValues).length > 8) fail('Generation cases support at most eight register fields');
        for (const [name, value] of Object.entries(item.registerValues)) { field(name, true); integer(value, -0x80000000, 0xffffffff, `generation case ${name}`); }
      }
    }
  }
  const timing = definition.timing;
  if (timing !== undefined) {
    object(timing, 'timing');
    if (timing.latency !== undefined) integer(timing.latency, 0, 1000000, 'timing.latency');
    if (timing.initiationInterval !== undefined) integer(timing.initiationInterval, 1, 1000000, 'timing.initiationInterval');
    if (timing.hazardClass !== undefined && !['cal_rr', 'cal_ri', 'br_r1', 'br_r2', 'mv_fr', 'mv_to', 'load', 'store', 'mul_div', 'lui', 'jal', 'jalr', 'jr', 'cp0_fr', 'cp0_to', 'trap', 'other'].includes(timing.hazardClass)) fail('Invalid timing.hazardClass');
    if (timing.readyStage !== undefined && !['D', 'E', 'M', 'W'].includes(timing.readyStage)) fail('Invalid timing.readyStage');
    if (timing.reads !== undefined) {
      if (!Array.isArray(timing.reads) || timing.reads.length > 8) fail('timing.reads must contain at most eight reads');
      for (const read of timing.reads) { object(read, 'timing read'); field(read.field, true); if (!['rs', 'rt'].includes(read.role) || !['D', 'E', 'M', 'W'].includes(read.useStage)) fail('Invalid timing read role/stage'); }
    }
  }
}
