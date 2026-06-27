// @index asm-templates — 从 resources/asm/*.asm 加载 MIPS 汇编模板并做 ${var} 插值
import * as fs from 'fs';
import * as path from 'path';

const asmDir = path.resolve(__dirname, '..', '..', '..', 'resources', 'asm');

/**
 * 加载 .asm 文件，按行分割（去除首尾空白和空行），
 * 对每行做 ${var} → value 替换。
 *
 * 模板变量约定（驼峰命名，不含 `$` 前缀）：
 *  - ${intAckHex} — 中断确认地址的十六进制
 */
function loadAsmTemplate(filename: string): string[] {
  const filePath = path.join(asmDir, filename);
  const text = fs.readFileSync(filePath, 'utf8');
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

function interpolateTemplate(lines: string[], vars: Record<string, string>): string[] {
  return lines.map((line) => {
    let result = line;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
    }
    return result;
  });
}

// ── P7 异常处理模板 ──

const p7ExceptionHandlerTemplate = loadAsmTemplate('p7_exception_handler.asm');
const p7ExceptionHandlerUnifiedTemplate = loadAsmTemplate('p7_exception_handler_unified.asm');

export function renderP7ExceptionHandler(intAckAddress: number): string[] {
  return interpolateTemplate(p7ExceptionHandlerTemplate, {
    intAckHex: `0x${intAckAddress.toString(16)}`
  });
}

export function renderP7ExceptionHandlerUnified(intAckAddress: number): string[] {
  return interpolateTemplate(p7ExceptionHandlerUnifiedTemplate, {
    intAckHex: `0x${intAckAddress.toString(16)}`
  });
}
