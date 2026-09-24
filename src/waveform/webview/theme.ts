// @index waveform-webview-theme — 从 VS Code 主题 CSS 变量解析画布调色板（明/暗/高对比），颜色透明度处理与主题变化监听

export interface Palette {
  readonly background: string;
  readonly foreground: string;
  readonly dim: string;
  readonly grid: string;
  readonly gridStrong: string;
  readonly rowStripe: string;
  readonly selection: string;
  readonly hover: string;
  readonly cursor: string;
  readonly cursorText: string;
  readonly marker: string;
  readonly unknown: string;
  readonly highZ: string;
  readonly traceGrf: string;
  readonly traceDm: string;
  readonly rulerBackground: string;
  readonly rowColors: readonly string[];
  readonly monoFamily: string;
  readonly uiFamily: string;
  readonly highContrast: boolean;
  readonly dark: boolean;
}

/** Names shown for the row color palette, index-aligned with Palette.rowColors. */
export const rowColorNames = ['绿色', '蓝色', '黄色', '橙色', '紫色', '青色', '品红', '前景色'];

const colorProbe = document.createElement('canvas').getContext('2d')!;

export function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const bodyClass = document.body.classList;
  const highContrast = bodyClass.contains('vscode-high-contrast') || bodyClass.contains('vscode-high-contrast-light');
  const dark = bodyClass.contains('vscode-dark') || bodyClass.contains('vscode-high-contrast');
  const variable = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value || fallback;
  };
  const foreground = variable('--vscode-editor-foreground', dark ? '#cccccc' : '#333333');
  const background = variable('--vscode-editor-background', dark ? '#1e1e1e' : '#ffffff');
  return {
    background,
    foreground,
    dim: variable('--vscode-descriptionForeground', dark ? '#9d9d9d' : '#717171'),
    grid: withAlpha(foreground, highContrast ? 0.35 : dark ? 0.07 : 0.08),
    gridStrong: withAlpha(foreground, highContrast ? 0.6 : dark ? 0.16 : 0.18),
    rowStripe: withAlpha(foreground, dark ? 0.025 : 0.03),
    selection: withAlpha(variable('--vscode-list-activeSelectionBackground', '#04395e'), dark ? 0.55 : 0.35),
    hover: withAlpha(variable('--vscode-list-hoverBackground', dark ? '#2a2d2e' : '#e8e8e8'), 0.8),
    cursor: variable('--vscode-focusBorder', '#0090f1'),
    cursorText: variable('--vscode-button-foreground', '#ffffff'),
    marker: variable('--vscode-charts-purple', '#b180d7'),
    unknown: variable('--vscode-charts-red', '#f14c4c'),
    highZ: variable('--vscode-charts-yellow', '#cca700'),
    traceGrf: variable('--vscode-charts-green', '#89d185'),
    traceDm: variable('--vscode-charts-orange', '#d18616'),
    rulerBackground: variable('--vscode-editorGroupHeader-tabsBackground', variable('--vscode-sideBar-background', background)),
    rowColors: [
      variable('--vscode-charts-green', '#89d185'),
      variable('--vscode-charts-blue', '#3794ff'),
      variable('--vscode-charts-yellow', '#cca700'),
      variable('--vscode-charts-orange', '#d18616'),
      variable('--vscode-charts-purple', '#b180d7'),
      variable('--vscode-terminal-ansiCyan', '#11a8cd'),
      variable('--vscode-terminal-ansiMagenta', '#bc3fbc'),
      foreground
    ],
    monoFamily: variable('--vscode-editor-font-family', 'Consolas, "Courier New", monospace'),
    uiFamily: variable('--vscode-font-family', 'system-ui, sans-serif'),
    highContrast,
    dark
  };
}

/** Parse any CSS color the canvas understands and apply an alpha factor. */
export function withAlpha(color: string, alpha: number): string {
  colorProbe.fillStyle = '#000000';
  colorProbe.fillStyle = color;
  const normalized = colorProbe.fillStyle;
  if (normalized.startsWith('#')) {
    const r = Number.parseInt(normalized.slice(1, 3), 16);
    const g = Number.parseInt(normalized.slice(3, 5), 16);
    const b = Number.parseInt(normalized.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const match = /^rgba?\(([^)]+)\)$/.exec(normalized);
  if (!match) {
    return normalized;
  }
  const [r, g, b, a = '1'] = match[1].split(',').map((part) => part.trim());
  return `rgba(${r}, ${g}, ${b}, ${Number(a) * alpha})`;
}

/** Call `onChange` whenever VS Code switches theme (body class or inline variables change). */
export function observeTheme(onChange: () => void): void {
  const observer = new MutationObserver(() => onChange());
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}
