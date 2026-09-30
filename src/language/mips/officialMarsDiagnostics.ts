// @index mips — 原版 MARS CLI 解析失败识别（解析错误可返回退出码 0）

export function officialMarsCliFailure(stdout: string, stderr: string): string | undefined {
  const line = `${stdout}\n${stderr}`.split(/\r?\n/).find((item) =>
    /^(?:Invalid Command Argument:|Invalid memory configuration:|Invalid\/unaligned address or invalid range:|Dump command line argument requires\b)/i.test(item.trim())
  );
  return line ? `原版 MARS 参数解析失败：${line.trim()}` : undefined;
}
