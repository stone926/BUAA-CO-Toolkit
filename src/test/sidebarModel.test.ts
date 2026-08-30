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
    configSource: 'VS Code settings',
    topModule: 'mips',
    testbench: 'mips_tb',
    machineCode: 'code.txt',
    simTime: '200us',
    verilogBackend: 'Icarus Verilog（内置）',
    iseConfigured: false,
    tools: [],
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

function childLabels(node: SidebarNodeModel): string[] {
  return node.children?.map((child) => child.label) ?? [];
}

describe('sidebar model', () => {
  it('keeps only focused P7 Verilog actions in the main operation section', () => {
    const model = buildSidebarModel(baseContext({
      activeFile: {
        languageId: 'verilog',
        fsPath: 'E:\\VSCode\\BUAA-CO\\hlc-mips-cpu\\src\\mips.v',
        basename: 'mips.v',
        isLogisimCircuit: false
      }
    }));

    expect(model.map((node) => node.label)).toEqual(['项目', '当前上下文', '操作']);
    const actions = section(model, '操作');
    expect(hasCommand(actions.children, 'co.test.startContinuousGeneratedTraceTests')).toBe(true);
    expect(hasCommand(actions.children, 'co.test.runGeneratedTraceTests')).toBe(false);
    expect(hasCommand(actions.children, 'co.verilog.generateTestbench')).toBe(false);
    expect(hasCommand(actions.children, 'co.verilog.inspectSignal')).toBe(true);
    expect(hasCommand(actions.children, 'co.tools.openAdvanced')).toBe(true);

    const runIsim = findCommand(actions.children ?? [], 'co.verilog.runIsim');
    expect(runIsim?.description).toContain('Top/TB');
    expect(runIsim?.description).toContain('ASM 运行时选择');
    expect(runIsim?.tooltip).toContain('.co/cases/<caseId>');
  });

  it('does not show active-editor commands without a current file but keeps continuous testing visible', () => {
    const model = buildSidebarModel(baseContext({
      profile: 'P6',
      activeFile: undefined
    }));

    const actions = section(model, '操作');
    expect(hasCommand(actions.children, 'co.test.startContinuousGeneratedTraceTests')).toBe(true);
    expect(hasCommand(actions.children, 'co.test.runGeneratedTraceTests')).toBe(false);
    expect(hasCommand(actions.children, 'co.tools.openAdvanced')).toBe(true);
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
    expect(findCommand(model, 'co.mips.runWithStdinFile')).toBeUndefined();
    expect(findCommand(model, 'co.tools.openAdvanced')).toBeDefined();
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

    const actions = section(model, '操作');
    expect(hasCommand(actions.children, 'co.test.startContinuousGeneratedTraceTests')).toBe(true);
    expect(hasCommand(actions.children, 'co.test.runGeneratedTraceTests')).toBe(false);
    expect(hasCommand(actions.children, 'co.test.prepareLogisimCases')).toBe(false);
    expect(hasCommand(actions.children, 'co.logisim.openCurrentCircuit')).toBe(true);
    expect(hasCommand(actions.children, 'co.tools.openAdvanced')).toBe(true);
    const inject = findCommand(actions.children ?? [], 'co.logisim.injectRomIntoCircuit');
    expect(inject?.description).toContain('运行时选择 ASM');
    expect(inject?.tooltip).toContain(circuitPath);
  });

  it('keeps P1 Verilog testbench generation out of the main action list', () => {
    const model = buildSidebarModel(baseContext({
      profile: 'P1',
      activeFile: {
        languageId: 'verilog',
        fsPath: 'E:\\VSCode\\BUAA-CO\\p1\\src\\fsm.v',
        basename: 'fsm.v',
        isLogisimCircuit: false
      }
    }));

    const actions = section(model, '操作');
    const context = section(model, '当前上下文');
    expect(childLabels(context)).toEqual(['当前 Verilog', '仿真模式']);
    expect(context.children?.find((item) => item.label === '仿真模式')?.description).toBe('独立模块');
    expect(findCommand(actions.children ?? [], 'co.verilog.generateTestbench')).toBeUndefined();
    expect(hasCommand(actions.children, 'co.verilog.runIsim')).toBe(true);
    expect(findCommand(actions.children ?? [], 'co.verilog.runIsim')?.description).toContain('当前模块/testbench');
    expect(hasCommand(actions.children, 'co.verilog.inspectSignal')).toBe(true);
    expect(hasCommand(actions.children, 'co.tools.openAdvanced')).toBe(true);
  });

  it('treats a Verilog file as a normal file under non-Verilog profiles', () => {
    const model = buildSidebarModel(baseContext({
      profile: 'P2',
      activeFile: {
        languageId: 'verilog',
        fsPath: 'E:\\VSCode\\BUAA-CO\\p2\\splitter.v',
        basename: 'splitter.v',
        isLogisimCircuit: false
      }
    }));

    const context = section(model, '当前上下文');
    expect(childLabels(context)).toEqual(['当前文件']);
    expect(findCommand(model, 'co.verilog.runIsim')).toBeUndefined();
    expect(findCommand(model, 'co.verilog.openIsimWaveform')).toBeUndefined();
    expect(findCommand(model, 'co.tools.openAdvanced')).toBeDefined();
  });

  it('does not expose Verilog context for Logisim profiles', () => {
    const model = buildSidebarModel(baseContext({
      profile: 'P3',
      activeFile: {
        languageId: 'verilog',
        fsPath: 'E:\\VSCode\\BUAA-CO\\p3\\splitter.v',
        basename: 'splitter.v',
        isLogisimCircuit: false
      }
    }));

    const context = section(model, '当前上下文');
    expect(childLabels(context)).toEqual(['当前文件']);
    expect(findCommand(model, 'co.verilog.inspectSignal')).toBeUndefined();
    expect(findCommand(model, 'co.verilog.runIsim')).toBeUndefined();
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

  it('exposes exactly the continuous-test start, stop, and history facade without internal details', () => {
    const model = buildSidebarModel(baseContext({ profile: 'P7' }));
    const actions = section(model, '操作');
    const testActions = actions.children?.filter((item) => item.command?.command.startsWith('co.test.')) ?? [];

    expect(testActions.map((item) => item.command?.command)).toEqual([
      'co.test.startContinuousGeneratedTraceTests',
      'co.test.stopContinuousTests',
      'co.test.openAsmCaseIndex'
    ]);
    expect(testActions.map((item) => item.label)).toEqual([
      '启动持续测试',
      '停止持续测试',
      '测试历史 / 失败用例'
    ]);
    expect(testActions.flatMap((item) => [item.description, item.tooltip]).join('\n'))
      .not.toMatch(/\.co\/|\.co\\|case\.json|MARS|ISim|Logisim|backend|dump|对拍/i);
  });

  it('does not restore a materials section when tool status is available', () => {
    const model = buildSidebarModel(baseContext({
      tools: [
        { id: 'mars', name: 'Mars', value: 'D:\\Program Files\\Mars\\Mars.jar', configured: true },
        { id: 'ise', name: 'ISE', value: 'D:\\ISE\\14.7', configured: true }
      ]
    }));

    expect(model.some((node) => node.label === '资料')).toBe(false);
    expect(model.some((node) => node.id === 'materials')).toBe(false);
  });
});
