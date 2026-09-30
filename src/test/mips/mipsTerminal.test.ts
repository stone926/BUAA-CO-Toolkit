import { describe, expect, it } from 'vitest';
import { marsTerminalInvocation } from '../../mipsTerminal';

describe('MARS terminal invocation', () => {
  it('uses PowerShell call syntax and preserves spaces, Chinese characters, apostrophes and interpolation characters', () => {
    const invocation = marsTerminalInvocation('C:\\Program Files\\Java\\bin\\java.exe', [
      '-jar', "E:\\中文 目录\\O'Brien $x`test.jar", 'nc', 'E:\\中文 空格\\程序.asm'
    ], 'win32');
    expect(invocation.shellPath).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(invocation.command).toBe("& 'C:\\Program Files\\Java\\bin\\java.exe' '-jar' 'E:\\中文 目录\\O''Brien $x`test.jar' 'nc' 'E:\\中文 空格\\程序.asm'");
  });

  it('uses POSIX literal quoting with an explicit shell on Unix', () => {
    const invocation = marsTerminalInvocation('/opt/java home/bin/java', ["/tmp/O'Brien $(test).asm"], 'linux');
    expect(invocation).toEqual({ shellPath: '/bin/sh', command: "'/opt/java home/bin/java' '/tmp/O'\"'\"'Brien $(test).asm'" });
  });
});
