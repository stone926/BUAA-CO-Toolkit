import * as vscode from 'vscode';
import {
  SemanticColorPresetName,
  semanticColorPresets,
  semanticColorPresetSetting,
  semanticColorTokenIds
} from './semanticColorPresets';

type SemanticColorMode = 'auto' | 'dark' | 'light' | 'off';
type SemanticRuleValue = string | { foreground?: string; fontStyle?: string; bold?: boolean; italic?: boolean; underline?: boolean };

const lastAppliedKey = 'semanticColors.lastAppliedRules';
const initialApplyDelayMs = 1500;
const managedTokenIds = new Set<string>(semanticColorTokenIds);

export function registerSemanticColorDefaults(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const controller = new SemanticColorController(context, output);
  context.subscriptions.push(controller);
  controller.applySoon(initialApplyDelayMs);
}

class SemanticColorController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private applyTimer: ReturnType<typeof setTimeout> | undefined;
  private applying = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => void this.apply()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(`co.${semanticColorPresetSetting}`) ||
          event.affectsConfiguration('editor.semanticTokenColorCustomizations')
        ) {
          void this.apply();
        }
      })
    );
  }

  dispose(): void {
    if (this.applyTimer) {
      clearTimeout(this.applyTimer);
      this.applyTimer = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  applySoon(delayMs: number): void {
    if (this.applyTimer) {
      clearTimeout(this.applyTimer);
    }
    this.applyTimer = setTimeout(() => {
      this.applyTimer = undefined;
      void this.apply();
    }, Math.max(0, delayMs));
  }

  async apply(): Promise<void> {
    if (this.applying) {
      return;
    }
    const mode = vscode.workspace.getConfiguration('co').get<SemanticColorMode>(semanticColorPresetSetting, 'off');
    if (mode === 'off') {
      await this.clearAppliedRules();
      return;
    }

    const presetName = mode === 'dark' || mode === 'light' ? mode : activeThemePreset();
    if (!presetName) {
      await this.clearAppliedRules();
      return;
    }
    const preset = semanticColorPresets[presetName];
    const editorConfig = vscode.workspace.getConfiguration('editor');
    const current = editorConfig.inspect<Record<string, unknown>>('semanticTokenColorCustomizations')?.globalValue ?? {};
    const next = isPlainObject(current) ? { ...current } : {};
    const currentRules = isPlainObject(next.rules) ? next.rules as Record<string, SemanticRuleValue> : {};
    const rules: Record<string, SemanticRuleValue> = { ...currentRules };
    const previous = this.context.globalState.get<Record<string, string>>(lastAppliedKey, {});
    const applied: Record<string, string> = {};
    let changed = false;

    for (const [token, previousColor] of Object.entries(previous)) {
      if (!managedTokenIds.has(token) && ruleMatchesColor(rules[token], previousColor)) {
        delete rules[token];
        changed = true;
      }
    }

    for (const token of semanticColorTokenIds) {
      const color = preset[token];
      const currentRule = rules[token];
      const previousColor = previous[token];
      if (currentRule !== undefined && (!previousColor || !ruleMatchesColor(currentRule, previousColor))) {
        continue;
      }
      applied[token] = color;
      if (!ruleMatchesColor(currentRule, color)) {
        rules[token] = color;
        changed = true;
      }
    }

    if (!changed) {
      await this.context.globalState.update(lastAppliedKey, applied);
      return;
    }

    this.applying = true;
    try {
      await editorConfig.update('semanticTokenColorCustomizations', {
        ...next,
        rules
      }, vscode.ConfigurationTarget.Global);
      await this.context.globalState.update(lastAppliedKey, applied);
    } catch (error) {
      this.output.appendLine(`无法应用 CO 语义着色预设: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.applying = false;
    }
  }

  private async clearAppliedRules(): Promise<void> {
    const previous = this.context.globalState.get<Record<string, string>>(lastAppliedKey, {});
    if (!Object.keys(previous).length) {
      return;
    }

    const editorConfig = vscode.workspace.getConfiguration('editor');
    const current = editorConfig.inspect<Record<string, unknown>>('semanticTokenColorCustomizations')?.globalValue ?? {};
    const next = isPlainObject(current) ? { ...current } : {};
    const currentRules = isPlainObject(next.rules) ? next.rules as Record<string, SemanticRuleValue> : {};
    const rules: Record<string, SemanticRuleValue> = { ...currentRules };
    let changed = false;

    for (const [token, previousColor] of Object.entries(previous)) {
      if (ruleMatchesColor(rules[token], previousColor)) {
        delete rules[token];
        changed = true;
      }
    }

    this.applying = true;
    try {
      if (changed) {
        await editorConfig.update('semanticTokenColorCustomizations', {
          ...next,
          rules
        }, vscode.ConfigurationTarget.Global);
      }
      await this.context.globalState.update(lastAppliedKey, {});
    } catch (error) {
      this.output.appendLine(`无法清理 CO 语义着色预设: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.applying = false;
    }
  }
}

function activeThemePreset(): SemanticColorPresetName | undefined {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.Dark:
      return 'dark';
    case vscode.ColorThemeKind.HighContrast:
    case vscode.ColorThemeKind.HighContrastLight:
      return undefined;
    default:
      return undefined;
  }
}

function ruleMatchesColor(value: SemanticRuleValue | undefined, color: string): boolean {
  if (typeof value === 'string') {
    return value.toLowerCase() === color.toLowerCase();
  }
  if (isPlainObject(value) && typeof value.foreground === 'string') {
    return value.foreground.toLowerCase() === color.toLowerCase();
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
