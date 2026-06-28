// @index asm-templates — 从 resources/templates/asm 加载 MIPS 汇编模板
import { renderResourceTemplate } from '../../templates/templateRegistry';

/**
 * 加载 .asm 文件，按行分割（去除首尾空白和空行），
 * 对每行做 ${var} → value 替换。
 *
 * 模板变量约定（驼峰命名，不含 `$` 前缀）：
 *  - ${exceptionHandlerHex} — P7 异常处理程序入口的十六进制
 *  - ${intAckHex} — 中断确认地址的十六进制
 */
export function renderP7ExceptionHandler(intAckAddress: number, exceptionHandlerAddress: number): string[] {
  return renderAsmTemplate('asm/p7_exception_handler.asm', {
    exceptionHandlerHex: `0x${exceptionHandlerAddress.toString(16)}`,
    intAckHex: `0x${intAckAddress.toString(16)}`
  });
}

export function renderP7ExceptionHandlerUnified(intAckAddress: number, exceptionHandlerAddress: number): string[] {
  return renderAsmTemplate('asm/p7_exception_handler_unified.asm', {
    exceptionHandlerHex: `0x${exceptionHandlerAddress.toString(16)}`,
    intAckHex: `0x${intAckAddress.toString(16)}`
  });
}

function renderAsmTemplate(relativePath: string, values: Record<string, string>): string[] {
  return renderResourceTemplate(relativePath, values)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}
