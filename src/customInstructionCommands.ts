// @index orchestration — Create a typed JS/TS instruction example without installing a toolchain
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { Commands } from './constants';
import { resourcePath } from './resourcePaths';
import { ensureContainedDirectoryPath } from './pathContainment';
import { customInstructionDirectory } from './mips/host/customInstructionFiles';

export function registerCustomInstructionCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(Commands.Mips.CreateCustomInstruction, async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { void vscode.window.showErrorMessage('请先打开 CPU 工作区'); return; }
    const folder = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor?.document.uri ?? folders[0].uri) ?? folders[0];
    const language = await vscode.window.showQuickPick([{ label: 'TypeScript', extension: 'ts' }, { label: 'JavaScript', extension: 'js' }], { title: '创建自定义指令示例' });
    if (!language) return;
    const name = await vscode.window.showInputBox({ title: '自定义指令助记符', value: 'addei', validateInput: value => /^[a-z][a-z0-9_]*$/.test(value) ? undefined : '使用小写字母开头的指令名' });
    if (!name) return;
    try {
      const directory = customInstructionDirectory(folder.uri.fsPath);
      await ensureContainedDirectoryPath(folder.uri.fsPath, directory);
      const target = path.join(directory, `${name}.${language.extension}`);
      const text = `import { defineInstruction, bits } from '@buaa-co/instructions';\n\n// 示例语义：立即数高位补 1，相加溢出时写入扩展后的立即数。\nexport default defineInstruction({\n  apiVersion: 1,\n  mnemonic: '${name}',\n  modes: ['mars', 'P3', 'P4', 'P5', 'P6', 'P7'],\n  encoding: '110011 rs:5 rt:5 immediate:16',\n  operands: [\n    { kind: 'register', field: 'rt' },\n    { kind: 'register', field: 'rs' },\n    { kind: 'immediate', field: 'immediate' }\n  ],\n  access: { reads: ['rs'], writes: ['rt'] },\n  generation: {},\n  execute(cpu, fields) {\n    const extended = bits.oneExtend(fields.immediate, 16);\n    const sum = bits.addSigned32(cpu.readGpr(fields.rs), extended);\n    return { gprWrites: [{ register: fields.rt, value: sum.overflow ? extended : sum.result }] };\n  }\n});\n`;
      await fs.writeFile(target, text, { encoding: 'utf8', flag: 'wx' });
      await writeIfAbsent(path.join(directory, 'co-instructions.d.ts'), await fs.readFile(resourcePath('mips', 'custom-instructions.d.ts'), 'utf8'));
      await writeIfAbsent(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, allowJs: true, checkJs: true, noEmit: true, types: [] }, include: ['**/*.ts', '**/*.js'] }, null, 2) + '\n');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    } catch (error) { void vscode.window.showErrorMessage(`创建自定义指令失败：${error instanceof Error ? error.message : String(error)}`); }
  }));
}
async function writeIfAbsent(file: string, text: string): Promise<void> {
  try { await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
