export const generatedTestbenchMarker = '// CO_GENERATED_RUNTIME_TESTBENCH';
export const p7AutoRuntimeTestbenchName = 'co_generated_p7_auto_tb';
export const verilogProjectExcludeGlob = '**/{node_modules,out,.git,.co}/**';

export function runtimeTestbenchFileName(testbenchName: string): string {
  return `co_generated_${safeFileStem(testbenchName)}.v`;
}

export function generatedRuntimeTestbenchText(testbenchText: string): string {
  return `${generatedTestbenchMarker}\n${testbenchText}`;
}

export function isGeneratedRuntimeTestbench(text: string): boolean {
  return text.includes(generatedTestbenchMarker);
}

export function buildIseProjectText(verilogFiles: readonly string[]): string {
  return verilogFiles
    .map((file) => `Verilog work "${file.replace(/\\/g, '/')}"`)
    .sort()
    .join('\n') + '\n';
}

export function buildIsimRunTcl(simTime: string): string {
  return `run ${simTime};\nexit\n`;
}

export function buildIsimWaveTcl(simTime: string): string {
  return `wave add -r /\nrun ${simTime}\n`;
}

export function buildIsimVcdTcl(vcdFile: string, testbenchName: string, simTime: string): string {
  return [
    `vcd dumpfile ${quoteTclString(vcdFile.replace(/\\/g, '/'))}`,
    `vcd dumpvars -m /${testbenchName} -l 0`,
    `run ${simTime}`,
    'vcd dumpflush',
    'quit',
    ''
  ].join('\n');
}

function safeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_') || 'testbench';
}

function quoteTclString(value: string): string {
  return `"${value.replace(/["\\]/g, (match) => `\\${match}`)}"`;
}
