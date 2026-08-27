// @index templates — 资源模板加载与受控占位替换
import * as fs from 'fs';
import * as path from 'path';

type TemplateValue = string | number | boolean | null | undefined;

const templateCache = new Map<string, string>();

export function renderResourceTemplate(relativePath: string, values: Record<string, TemplateValue>): string {
  return renderTemplateText(readResourceTemplate(relativePath), values);
}

export function renderTemplateText(template: string, values: Record<string, TemplateValue>): string {
  return template.replace(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`Missing template value: ${name}`);
    }
    const value = values[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

function readResourceTemplate(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const cached = templateCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }
  const templatePath = path.join(__dirname, '..', '..', 'resources', 'templates', ...normalized.split('/'));
  // Normalize to LF at load: the extension's rendered outputs (Tcl scripts,
  // project files, Verilog) must not depend on whether the checkout used CRLF.
  const text = fs.readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');
  templateCache.set(normalized, text);
  return text;
}
