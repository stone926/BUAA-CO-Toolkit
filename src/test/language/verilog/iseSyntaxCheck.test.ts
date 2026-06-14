import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { URI } from 'vscode-uri';
import { parseFuseDiagnostics } from '../../../language/verilog/iseSyntaxCheck';

describe('ISE syntax diagnostic parser', () => {
  it('parses HDLCompiler file and line diagnostics', () => {
    const root = path.resolve('workspace');
    const file = path.join(root, 'cpu.v');
    const output = `ERROR:HDLCompiler:806 - "${file.replace(/\\/g, '/')}" Line 28: Syntax error near "endmodule".`;
    const diagnostics = parseFuseDiagnostics(output, root, URI.file(path.join(root, 'fallback.v')).toString());
    const uri = URI.file(file).toString();
    expect(diagnostics.get(uri)?.[0]).toMatchObject({
      code: 'ise-syntax',
      message: 'Syntax error near "endmodule".'
    });
    expect(diagnostics.get(uri)?.[0].range.start.line).toBe(27);
  });

  it('falls back to the trigger document when ISE omits a file path', () => {
    const root = path.resolve('workspace');
    const fallbackUri = URI.file(path.join(root, 'top.v')).toString();
    const diagnostics = parseFuseDiagnostics('ERROR:Simulator:778 - Static elaboration failed.', root, fallbackUri);
    expect(diagnostics.get(fallbackUri)?.[0]).toMatchObject({
      code: 'ise-syntax',
      message: 'Static elaboration failed.'
    });
  });

  it('keeps warnings as warning diagnostics', () => {
    const root = path.resolve('workspace');
    const file = path.join(root, 'top.v');
    const diagnostics = parseFuseDiagnostics(
      `WARNING:HDLCompiler:413 - "${file}" Line 7: Result of 32-bit expression is truncated.`,
      root,
      URI.file(file).toString()
    );
    expect(diagnostics.get(URI.file(file).toString())?.[0].severity).toBe(2);
  });
});
