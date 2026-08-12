// @index legacy-semantic-color-migration — 一次性移除旧版本注入且未被用户修改的全局语义颜色
import * as vscode from 'vscode';

const legacyAppliedRulesKey = 'semanticColors.lastAppliedRules';

type JsonObject = Record<string, unknown>;

/**
 * Removes only exact string values written by the retired color preset feature.
 * Object rules and changed strings belong to the user and must be preserved.
 */
export function withoutUnmodifiedLegacySemanticColorRules(
  currentRules: JsonObject,
  legacyRules: Record<string, string>
): { rules: JsonObject; removed: boolean } {
  const rules = { ...currentRules };
  let removed = false;

  for (const [token, legacyColor] of Object.entries(legacyRules)) {
    if (rules[token] === legacyColor) {
      delete rules[token];
      removed = true;
    }
  }

  return { rules, removed };
}

/**
 * Upgrade-only cleanup for users of the removed semantic color presets.
 * Once the legacy state is cleared, later activations do not inspect or write
 * editor color settings.
 */
export async function migrateLegacySemanticColorRules(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const stored = context.globalState.get<unknown>(legacyAppliedRulesKey);
  if (stored === undefined) {
    return;
  }
  if (!isStringRecord(stored)) {
    await context.globalState.update(legacyAppliedRulesKey, undefined);
    return;
  }

  const editorConfig = vscode.workspace.getConfiguration('editor');
  const globalValue = editorConfig.inspect<unknown>('semanticTokenColorCustomizations')?.globalValue;
  const customizations = isPlainObject(globalValue) ? { ...globalValue } : {};
  const currentRules = isPlainObject(customizations.rules) ? customizations.rules : {};
  const result = withoutUnmodifiedLegacySemanticColorRules(currentRules, stored);

  try {
    if (result.removed) {
      if (Object.keys(result.rules).length) {
        customizations.rules = result.rules;
      } else {
        delete customizations.rules;
      }
      await editorConfig.update(
        'semanticTokenColorCustomizations',
        Object.keys(customizations).length ? customizations : undefined,
        vscode.ConfigurationTarget.Global
      );
    }
    await context.globalState.update(legacyAppliedRulesKey, undefined);
  } catch (error) {
    output.appendLine(`无法清理旧版 CO 语义颜色设置: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
