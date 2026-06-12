import { describe, expect, it } from 'vitest';
import {
  buildSidebarModel,
  SidebarModelContext,
  SidebarNodeModel
} from '../sidebarModel';

function baseContext(overrides: Partial<SidebarModelContext> = {}): SidebarModelContext {
  return {
    profile: 'P7',
    workspaceName: 'hlc-mips-cpu',
    workspacePath: 'E:\\VSCode\\BUAA-CO\\hlc-mips-cpu',
    configSource: '.co/config.json',
    topModule: 'mips',
    testbench: 'mips_tb',
    machineCode: 'code.txt',
    simTime: '200us',
    simBackend: 'isim',
    tools: [],
    tutorials: [],
    ...overrides
  };
}

function section(model: SidebarNodeModel[], label: string): SidebarNodeModel {
  const found = model.find((node) => node.label === label);
  expect(found, label).toBeTruthy();
  return found!;
}

function findCommand(model: SidebarNodeModel[], command: string): SidebarNodeModel | undefined {
  for (const node of model) {
    if (node.command?.command === command) {
      return node;
    }
    const child = findCommand(node.children ?? [], command);
    if (child) {
      return child;
    }
  }
  return undefined;
}

function hasCommand(nodes: SidebarNodeModel[] | undefined, command: string): boolean {
  return Boolean(findCommand(nodes ?? [], command));
}

describe('sidebar model', () => {
  it('keeps continuous testing prominent for P7 Verilog and moves TB generation to manual workflow', () => {
    const model = buildSidebarModel(baseContext({
      activeFile: {
        languageId: 'verilog',
        fsPath: 'E:\\VSCode\\BUAA-CO\\hlc-mips-cpu\\src\\mips.v',
        basename: 'mips.v',
        isLogisimCircuit: false
      }
    }));

    const core = section(model, '核心操作');
    const manual = section(model, '手动流程');
    expect(hasCommand(core.children, 'co.test.startContinuousGeneratedTraceTests')).toBe(true);
    expect(hasCommand(core.children, 'co.verilog.generateTestbench')).toBe(false);
    expect(hasCommand(manual.children, 'co.verilog.generateTestbench')).toBe(true);

    const runIsim = findCommand(core.children ?? [], 'co.verilog.runIsim');
    expect(runIsim?.description).toContain('Top/TB');
    expect(runIsim?.description).toContain('ASM 运行时选择');
    expect(runIsim?.tooltip).toContain('.co/cases/<caseId>');
  });

  it('does not show active-editor commands without a current file but keeps continuous testing visible', () => {
    const model = buildSidebarModel(baseContext({
      profile: 'P6',
      activeFile: undefined
    }));

    const core = section(model, '核心操作');
    expect(hasCommand(core.children, 'co.test.startContinuousGeneratedTraceTests')).toBe(true);
    expect(findCommand(model, 'co.verilog.runIsim')).toBeUndefined();
    expect(findCommand(model, 'co.verilog.generateTestbench')).toBeUndefined();
    expect(findCommand(model, 'co.sidebar.refresh')).toBeUndefined();
  });

  it('shows current ASM inputs and dump target for P2', () => {
    const asmPath = 'E:\\VSCode\\BUAA-CO\\p2\\src\\matrix.asm';
    const model = buildSidebarModel(baseContext({
      profile: 'P2',
      activeFile: {
        languageId: 'mipsasm',
        fsPath: asmPath,
        basename: 'matrix.asm',
        isLogisimCircuit: false
      }
    }));

    const context = section(model, '当前上下文');
    expect(context.children?.some((item) => item.label === '当前 ASM' && item.description === 'matrix.asm')).toBe(true);
    expect(context.children?.find((item) => item.label === '机器码输出')?.tooltip).toContain('code.txt');

    const runAsm = findCommand(model, 'co.mips.runCurrentFile');
    expect(runAsm?.description).toContain('matrix.asm');
    expect(runAsm?.tooltip).toContain(asmPath);
  });

  it('shows Logisim circuit operations with runtime ASM visibility', () => {
    const circuitPath = 'E:\\VSCode\\BUAA-CO\\p3\\logisim\\cpu.circ';
    const model = buildSidebarModel(baseContext({
      profile: 'P3',
      activeFile: {
        languageId: 'xml',
        fsPath: circuitPath,
        basename: 'cpu.circ',
        isLogisimCircuit: true
      }
    }));

    const core = section(model, '核心操作');
    expect(hasCommand(core.children, 'co.test.prepareLogisimCases')).toBe(true);
    expect(hasCommand(core.children, 'co.logisim.openCurrentCircuit')).toBe(true);
    const inject = findCommand(core.children ?? [], 'co.logisim.injectRomIntoCircuit');
    expect(inject?.description).toContain('运行时选择 ASM');
    expect(inject?.tooltip).toContain(circuitPath);
  });

  it('keeps P1 Testbench generation in core actions with visible target name', () => {
    const model = buildSidebarModel(baseContext({
      profile: 'P1',
      activeFile: {
        languageId: 'verilog',
        fsPath: 'E:\\VSCode\\BUAA-CO\\p1\\src\\fsm.v',
        basename: 'fsm.v',
        isLogisimCircuit: false
      }
    }));

    const core = section(model, '核心操作');
    const tb = findCommand(core.children ?? [], 'co.verilog.generateTestbench');
    expect(tb?.description).toContain('mips_tb.v');
    expect(tb?.tooltip).toContain('Top: mips');
  });

  it('does not expose course actions while auto remains unresolved', () => {
    const model = buildSidebarModel(baseContext({
      profile: 'auto',
      activeFile: {
        languageId: 'verilog',
        fsPath: 'E:\\VSCode\\BUAA-CO\\unknown\\src\\mips.v',
        basename: 'mips.v',
        isLogisimCircuit: false
      }
    }));

    expect(findCommand(model, 'co.selectProjectProfile')).toBeDefined();
    expect(findCommand(model, 'co.verilog.runIsim')).toBeUndefined();
    expect(findCommand(model, 'co.test.startContinuousGeneratedTraceTests')).toBeUndefined();
    const project = section(model, '项目');
    expect(project.children?.find((item) => item.id === 'project.profile')?.description).toBe('未推断');
  });
});
