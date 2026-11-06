import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyProjectOverride, normalizeProjectOverrides, resolveProjectOverride } from '../projectSettings';
import { mergeCoSettings } from '../language/common/settings';
import { VerilogProjectContext } from '../language/verilog/projectContext';
import { URI } from 'vscode-uri';

const root = path.resolve('project settings 中文');
describe('project settings isolation', () => {
  it('does not inherit a parent project override across an independent project boundary', () => {
    const scope = { name: 'p4', rootPath: path.join(root, 'p4'), workspacePath: root, isolated: true };
    expect(resolveProjectOverride({ '.': { profile: 'P5' } }, path.join(root, 'p4/mips.v'), root, [scope])).toBeUndefined();
  });
  it('derives distinct project anchors from explicit file lists containing a shared library', () => {
    const context = new VerilogProjectContext([URI.file(root).toString()], {
      one: ['common/shared.v', 'p4/mips.v', 'p4/alu.v'], two: ['common/shared.v', 'p5/mips.v', 'p5/alu.v']
    });
    const one = context.projectScopes(URI.file(path.join(root, 'p4/mips.v')).toString());
    const two = context.projectScopes(URI.file(path.join(root, 'p5/mips.v')).toString());
    expect(one[0].rootPath.replace(/\\/g, '/').toLowerCase()).toBe(path.join(root, 'p4').replace(/\\/g, '/').toLowerCase());
    expect(two[0].rootPath.replace(/\\/g, '/').toLowerCase()).toBe(path.join(root, 'p5').replace(/\\/g, '/').toLowerCase());
  });
  it('normalizes only supported project fields', () => {
    expect(normalizeProjectOverrides({ p4: { profile: 'P4', topModule: ' cpu4 ', ignored: true }, bad: { profile: 'P9' }, '**': { profile: 'P5' } }))
      .toEqual({ p4: { profile: 'P4', topModule: 'cpu4' } });
  });
  it('matches whole directories and supports file-level independent projects', () => {
    const settings = { p4: { profile: 'P4' }, 'p5/one.v': { profile: 'P5' }, 'p5/two.v': { profile: 'P6' } };
    expect(resolveProjectOverride(settings, path.join(root, 'p4/src/m.v'), root)?.profile).toBe('P4');
    expect(resolveProjectOverride(settings, path.join(root, 'p40/m.v'), root)).toBeUndefined();
    expect(resolveProjectOverride(settings, path.join(root, 'p5/two.v'), root)?.profile).toBe('P6');
  });
  it('keeps shared dependencies ambiguous when callers configure different profiles', () => {
    const settings = { p4: { profile: 'P4' }, p5: { profile: 'P5' } };
    const scopes = ['p4', 'p5'].map((name) => ({ name, rootPath: path.join(root, name), workspacePath: root, isolated: true }));
    expect(resolveProjectOverride(settings, path.join(root, 'lib/alu.v'), root, [scopes[0]])?.profile).toBe('P4');
    expect(resolveProjectOverride(settings, path.join(root, 'lib/alu.v'), root, scopes)).toBeUndefined();
  });
  it('applies project defaults before normalizing inherited workspace settings', () => {
    const raw = { project: { profile: 'P5', overrides: { p1: { profile: 'P1' } } } };
    const settings = mergeCoSettings(applyProjectOverride(raw, path.join(root, 'p1/main.v'), root));
    expect(settings.project).toMatchObject({ profile: 'P1', profileSource: 'project', topModule: 'main', testbench: 'main_tb' });
    expect(mergeCoSettings(applyProjectOverride(raw, path.join(root, 'p5/mips.v'), root)).project.profile).toBe('P5');
  });
});
