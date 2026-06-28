import { renderResourceTemplate } from './templates/templateRegistry';

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
  const projectEntries = verilogFiles
    .map((file) => `Verilog work "${file.replace(/\\/g, '/')}"`)
    .sort()
    .join('\n');
  return renderResourceTemplate('isim/project.prj.tmpl', { projectEntries });
}

export function buildIsimRunTcl(simTime: string): string {
  return renderResourceTemplate('isim/run.tcl.tmpl', { simTime });
}

export function buildIsimWaveTcl(simTime: string): string {
  return renderResourceTemplate('isim/wave.tcl.tmpl', { simTime });
}

export function buildIsimVcdTcl(vcdFile: string, testbenchName: string, simTime: string): string {
  return renderResourceTemplate('isim/vcd.tcl.tmpl', {
    simTime,
    testbenchName,
    vcdFile: quoteTclString(vcdFile.replace(/\\/g, '/'))
  });
}

function safeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_') || 'testbench';
}

function quoteTclString(value: string): string {
  return `"${value.replace(/["\\]/g, (match) => `\\${match}`)}"`;
}
