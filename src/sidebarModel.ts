import * as path from 'path';
import { ProjectProfile } from './projectProfile';

export type SidebarNodeKind = 'section' | 'info' | 'action' | 'tool' | 'tutorial';

export interface SidebarCommandModel {
  command: string;
  title?: string;
  arguments?: unknown[];
}

export interface SidebarNodeModel {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  contextValue?: string;
  kind?: SidebarNodeKind;
  command?: SidebarCommandModel;
  children?: SidebarNodeModel[];
  expanded?: boolean;
}

export interface SidebarToolModel {
  id: string;
  name: string;
  value: string;
  configured: boolean;
}

export interface SidebarTutorialModel {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  command: string;
  arguments?: unknown[];
  icon: string;
}

export interface SidebarActiveFileModel {
  languageId?: string;
  fsPath: string;
  basename: string;
  isLogisimCircuit: boolean;
}

export interface SidebarModelContext {
  profile: ProjectProfile;
  workspaceName?: string;
  workspacePath?: string;
  configSource: '.co/config.json' | 'VS Code settings';
  topModule: string;
  testbench: string;
  machineCode: string;
  simTime: string;
  simBackend: string;
  activeFile?: SidebarActiveFileModel;
  tools: SidebarToolModel[];
  tutorials: SidebarTutorialModel[];
}

const traceProfiles = new Set<ProjectProfile>(['auto', 'P4', 'P5', 'P6', 'P7']);
const verilogProfiles = new Set<ProjectProfile>(['auto', 'P1', 'P4', 'P5', 'P6', 'P7']);
const mipsProfiles = new Set<ProjectProfile>(['auto', 'P2', 'P4', 'P5', 'P6', 'P7']);
const asmGenerationProfiles = new Set<ProjectProfile>(['auto', 'P3', 'P4', 'P5', 'P6', 'P7']);
const logisimProfiles = new Set<ProjectProfile>(['auto', 'P0', 'P3']);
const hazardProfiles = new Set<ProjectProfile>(['P5', 'P6', 'P7']);

export function buildSidebarModel(context: SidebarModelContext): SidebarNodeModel[] {
  return [
    projectSection(context),
    contextSection(context),
    coreActionsSection(context),
    manualWorkflowSection(context),
    reportsSection(context),
    materialsSection(context)
  ].filter(hasVisibleChildren);
}

function projectSection(context: SidebarModelContext): SidebarNodeModel {
  const toolSummary = summarizeTools(context.tools);
  const children: SidebarNodeModel[] = [
    infoItem('project.profile', 'Profile', context.profile, `配置来源: ${context.configSource}`, 'symbol-class', {
      command: 'co.selectProjectProfile',
      title: '选择 Profile'
    }),
    infoItem(
      'project.workspace',
      '工作区',
      context.workspaceName ?? '未打开工作区',
      context.workspacePath ?? '请先打开一个工作区文件夹',
      context.workspacePath ? 'root-folder' : 'warning'
    ),
    infoItem('project.config', '配置来源', context.configSource, configSourceTooltip(context), 'json'),
    infoItem('project.tools', '工具链', toolSummary.description, toolSummary.tooltip, toolSummary.icon, {
      command: 'co.checkToolchain',
      title: '检查工具链'
    }),
    actionItem(
      'project.wizard',
      '项目向导',
      'co.projectWizard',
      'new-folder',
      '创建结构 / 写入 .co/config.json',
      workspaceTooltip(context, '项目向导会在当前工作区创建课程目录和默认配置。')
    ),
    actionItem(
      'project.selectProfile',
      '选择 Profile',
      'co.selectProjectProfile',
      'settings-gear',
      `当前 ${context.profile}`,
      '切换 co.project.profile。项目级 .co/config.json 存在时会优先作为配置来源。'
    ),
    actionItem(
      'project.checkToolchain',
      '检查工具链',
      'co.checkToolchain',
      'check-all',
      toolSummary.description,
      toolSummary.tooltip
    )
  ];
  return sectionItem('project', '项目', true, children);
}

function contextSection(context: SidebarModelContext): SidebarNodeModel {
  const active = context.activeFile;
  if (!active) {
    return sectionItem('context', '当前上下文', true, [
      infoItem(
        'context.none',
        '未绑定当前文件',
        '打开 ASM / Verilog / .circ 后显示文件操作',
        '当前没有可用于 CO 操作的 active editor。依赖当前文件的命令不会出现在核心操作中。',
        'info'
      )
    ]);
  }

  if (isMipsFile(active)) {
    return sectionItem('context', '当前上下文', true, [
      infoItem('context.asm', '当前 ASM', active.basename, active.fsPath, 'file-code'),
      infoItem(
        'context.asmMachineCode',
        '机器码输出',
        context.machineCode,
        `ASM 导出文本段默认写入:\n${defaultSiblingPath(active.fsPath, context.machineCode)}`,
        'file-binary'
      )
    ]);
  }

  if (isVerilogFile(active)) {
    return sectionItem('context', '当前上下文', true, [
      infoItem('context.verilog', '当前 Verilog', active.basename, active.fsPath, 'file-code'),
      infoItem('context.top', 'Top', context.topModule, 'co.project.topModule 或 .co/config.json', 'symbol-class'),
      infoItem('context.tb', 'TB', context.testbench, 'co.project.testbench 或 .co/config.json', 'beaker'),
      infoItem('context.machineCode', '机器码名', context.machineCode, '仿真前会复制到 .co/isim/<machineCode>', 'file-binary'),
      infoItem('context.simTime', '仿真时长', context.simTime, 'co.project.simTime 或 .co/config.json', 'watch'),
      infoItem('context.backend', '仿真后端', context.simBackend, '.co/config.json: simulation.backend', 'circuit-board')
    ]);
  }

  if (isLogisimCircuitFile(active)) {
    return sectionItem('context', '当前上下文', true, [
      infoItem('context.circuit', '当前电路', active.basename, active.fsPath, 'circuit-board')
    ]);
  }

  return sectionItem('context', '当前上下文', true, [
    infoItem(
      'context.file',
      '当前文件',
      active.basename,
      `${active.fsPath}\n当前文件类型未绑定 CO 核心操作。`,
      'file'
    )
  ]);
}

function coreActionsSection(context: SidebarModelContext): SidebarNodeModel {
  const children: SidebarNodeModel[] = [];
  const active = context.activeFile;

  if (shouldShowTraceActions(context.profile)) {
    children.push(
      actionItem(
        'core.continuousTrace',
        '持续生成测试',
        'co.test.startContinuousGeneratedTraceTests',
        'rocket',
        '生成 ASM -> case -> dump -> ISim -> 对拍',
        `自动生成或导入 ASM，并为每次运行写入 .co/cases/<caseId>。\n报告和输出保留在 .co/out。`
      ),
      actionItem(
        'core.stopContinuousTrace',
        '停止持续测试',
        'co.test.stopContinuousTests',
        'debug-stop',
        '停止当前持续测试任务',
        '如果没有正在运行的持续测试，此命令会安全返回。'
      ),
      actionItem(
        'core.asmCases',
        '查看 ASM 用例记录',
        'co.test.openAsmCaseIndex',
        'history',
        '.co/cases 历史记录',
        '打开 .co/cases/*/case.json 的索引视图，查看 ASM 快照、机器码和派生输出。'
      )
    );
  }

  if (shouldShowLogisimActions(context.profile, active)) {
    children.push(
      actionItem(
        'core.prepareLogisimCases',
        '准备 Logisim 用例',
        'co.test.prepareLogisimCases',
        'file-submodule',
        '选择 ASM -> case -> 注入电路',
        '选择 ASM 并生成可用于 Logisim 的用例。机器码和派生电路写入对应 ASM case。'
      ),
      actionItem(
        'core.prepareGeneratedLogisimCases',
        '生成 Logisim 用例',
        'co.test.prepareGeneratedLogisimCases',
        'files',
        '生成 ASM -> case -> 注入电路',
        '使用生成器生成 ASM，并把 Logisim 派生物记录到 .co/cases/<caseId>/logisim。'
      )
    );
  }

  if (active && isMipsFile(active) && shouldShowMipsActions(context.profile, active.languageId)) {
    children.push(
      actionItem(
        'core.asmRun',
        'ASM 运行',
        'co.mips.runCurrentFile',
        'play',
        `使用当前 ASM: ${active.basename}`,
        active.fsPath
      ),
      actionItem(
        'core.asmRunStdin',
        'ASM 带输入运行',
        'co.mips.runWithStdinFile',
        'terminal',
        '当前 ASM + 运行时选择 stdin',
        `ASM:\n${active.fsPath}\n\nstdin 会在执行时弹出选择器。`
      ),
      actionItem(
        'core.asmDumpText',
        'ASM 导出文本段',
        'co.mips.dumpText',
        'export',
        `写入 ${context.machineCode}`,
        `ASM:\n${active.fsPath}\n\n默认输出:\n${defaultSiblingPath(active.fsPath, context.machineCode)}`
      )
    );
  }

  if (active && isVerilogFile(active) && shouldShowVerilogActions(context.profile, active.languageId)) {
    if (context.profile === 'P1') {
      children.push(
        actionItem(
          'core.verilogTb',
          '生成 Testbench',
          'co.verilog.generateTestbench',
          'file-code',
          `当前光标模块，Top 时为 ${context.testbench}.v`,
          verilogTestbenchTooltip(context, active)
        )
      );
    }
    children.push(
      actionItem(
        'core.runIsim',
        '运行 ISim',
        'co.verilog.runIsim',
        'run',
        verilogSimulationDescription(context),
        verilogSimulationTooltip(context, active)
      ),
      actionItem(
        'core.openWave',
        '查看 ISim 波形',
        'co.verilog.openIsimWaveform',
        'pulse',
        verilogSimulationDescription(context),
        `${verilogSimulationTooltip(context, active)}\n\nGUI 启动后执行 wave add -r /。`
      )
    );
  }

  if (active && isLogisimCircuitFile(active) && shouldShowLogisimActions(context.profile, active)) {
    children.push(
      actionItem(
        'core.openCircuit',
        '打开 Logisim 电路',
        'co.logisim.openCurrentCircuit',
        'circuit-board',
        `使用当前电路: ${active.basename}`,
        active.fsPath
      ),
      actionItem(
        'core.injectCircuit',
        'Logisim 注入 ROM',
        'co.logisim.injectRomIntoCircuit',
        'circuit-board',
        '当前 .circ + 运行时选择 ASM',
        `电路:\n${active.fsPath}\n\nASM 会在执行时选择，并导入 .co/cases/<caseId>。`
      )
    );
  }

  return sectionItem('core', '核心操作', true, children);
}

function manualWorkflowSection(context: SidebarModelContext): SidebarNodeModel {
  const children: SidebarNodeModel[] = [];
  const active = context.activeFile;

  if (active && isMipsFile(active) && shouldShowMipsActions(context.profile, active.languageId)) {
    children.push(
      actionItem(
        'manual.asmTerminal',
        'ASM 终端运行',
        'co.mips.runInTerminal',
        'terminal-powershell',
        `使用当前 ASM: ${active.basename}`,
        active.fsPath
      )
    );
    if (context.profile === 'P7' || context.profile === 'auto') {
      children.push(
        actionItem(
          'manual.asmDumpKernel',
          'ASM 导出内核段',
          'co.mips.dumpKernelText',
          'export',
          'P7 内核文本段',
          `ASM:\n${active.fsPath}\n\n默认输出在 ASM 同目录。`
        )
      );
    }
  }

  if (shouldShowAsmGenerationActions(context.profile)) {
    children.push(
      actionItem(
        'manual.generateAsm',
        '生成 ASM 测试点',
        'co.test.generateAsmTests',
        'file-code',
        '生成并保留 ASM case',
        '生成器输出会导入 .co/cases/<caseId>，并打开第一个 ASM 快照。'
      ),
      actionItem(
        'manual.generateAndDumpAsm',
        '生成并导出机器码',
        'co.test.generateAndDumpAsmTests',
        'export',
        '生成 ASM -> case -> code.txt',
        '生成 ASM 后通过 MARS dump，机器码写入 .co/cases/<caseId>/code.txt。'
      )
    );
  }

  if (shouldShowTraceActions(context.profile)) {
    children.push(
      actionItem(
        'manual.singleTrace',
        '单 ASM 测试',
        'co.test.runFullTest',
        'run-all',
        '运行时选择 ASM',
        '选择 ASM 后创建 case，dump 机器码，分别运行 MARS/ISim 并对拍。'
      ),
      actionItem(
        'manual.batchTrace',
        '多 ASM 批量测试',
        'co.test.runBatchTraceTests',
        'list-selection',
        '运行时选择多个 ASM',
        '每个 ASM 都会创建独立 .co/cases/<caseId>，批量报告写入 .co/out。'
      ),
      actionItem(
        'manual.generatedBatchTrace',
        '生成并批量测试',
        'co.test.runGeneratedTraceTests',
        'beaker',
        '生成 ASM -> 批量对拍',
        '适合一次性生成固定数量测试点；持续压力测试请优先使用核心操作。'
      )
    );
  }

  if (active && isVerilogFile(active) && shouldShowVerilogActions(context.profile, active.languageId)) {
    if (context.profile !== 'P1') {
      children.push(
        actionItem(
          'manual.verilogTb',
          'Verilog Testbench',
          'co.verilog.generateTestbench',
          'file-code',
          `当前光标模块，Top 时为 ${context.testbench}.v`,
          verilogTestbenchTooltip(context, active)
        )
      );
    }
    children.push(
      actionItem(
        'manual.iseProject',
        'Verilog ISE 工程',
        'co.verilog.generateIseProject',
        'project',
        '生成 .co/isim PRJ/TCL',
        verilogConfigTooltip(context, active)
      ),
      actionItem(
        'manual.exportVcd',
        '导出 VCD 波形',
        'co.verilog.exportVcd',
        'save',
        '批量运行并写入 .co/out',
        `${verilogSimulationTooltip(context, active)}\n\nVCD 输出到 .co/out。`
      )
    );
  }

  if (shouldShowLogisimActions(context.profile, active)) {
    children.push(
      actionItem(
        'manual.logisimRom',
        'Logisim ROM',
        'co.logisim.generateRom',
        'file-binary',
        '运行时选择 ASM',
        '选择 ASM 后创建 case，ROM 文本写入 .co/cases/<caseId>/logisim。'
      )
    );
    if (!active || !isLogisimCircuitFile(active)) {
      children.push(
        actionItem(
          'manual.logisimInject',
          'Logisim 注入 ROM',
          'co.logisim.injectRomIntoCircuit',
          'circuit-board',
          '运行时选择 .circ 和 ASM',
          '电路和 ASM 都会在执行时选择；注入后的电路写入对应 ASM case。'
        )
      );
    }
    children.push(
      actionItem(
        'manual.logisimCsv',
        'Logisim Logging 转 CSV',
        'co.logisim.convertLogToCsv',
        'table',
        '运行时选择日志文本',
        '将 Logisim logging 文本转换为同目录 CSV。'
      )
    );
  }

  return sectionItem('manual', '手动流程', false, children);
}

function reportsSection(context: SidebarModelContext): SidebarNodeModel {
  const children: SidebarNodeModel[] = [];

  if (shouldShowTraceActions(context.profile)) {
    children.push(
      actionItem(
        'reports.compareTraceFiles',
        '手动选择输出对拍',
        'co.test.compareTraceFiles',
        'compare-changes',
        '运行时选择两个输出',
        '适合手动比较 MARS/ISim 或历史输出文件。'
      ),
      actionItem(
        'reports.compareLatest',
        '最近输出对拍',
        'co.test.compareLatestOutputs',
        'diff',
        '使用 .co/out 最近输出',
        '自动寻找最近的仿真/黄金模型输出并比较。'
      ),
      actionItem(
        'reports.batchReport',
        '打开批量测试报告',
        'co.test.openBatchTraceReport',
        'preview',
        '.co/out 报告',
        '打开最近的批量 Trace 测试报告。'
      )
    );
  }

  if (hazardProfiles.has(context.profile)) {
    children.push(
      actionItem(
        'reports.hazardAnalyze',
        'Hazard 分析',
        'co.hazard.analyzeCurrentMachineCode',
        'pulse',
        '当前 ASM 或运行时选择机器码',
        '若当前文件是 ASM，会先 dump 机器码；否则使用配置的 machineCode 或弹出选择器。输出写入 .co/hazard。'
      ),
      actionItem(
        'reports.hazardReport',
        '打开 Hazard 报告',
        'co.hazard.openReport',
        'json',
        '.co/hazard/result',
        '打开最近一次 Hazard 分析统计报告。'
      )
    );
  }

  return sectionItem('reports', '报告与诊断', false, children);
}

function materialsSection(context: SidebarModelContext): SidebarNodeModel {
  const children: SidebarNodeModel[] = [
    ...context.tutorials.map((tutorial) => ({
      id: `tutorial.${tutorial.id}`,
      label: tutorial.label,
      description: tutorial.description,
      tooltip: tutorial.tooltip ?? tutorial.description,
      icon: tutorial.icon,
      kind: 'tutorial' as const,
      contextValue: 'tutorial',
      command: {
        command: tutorial.command,
        title: tutorial.label,
        arguments: tutorial.arguments ?? []
      }
    }))
  ];

  for (const tool of context.tools) {
    children.push({
      id: `tool.${tool.id}`,
      label: tool.name,
      description: tool.configured ? '已配置' : '未配置',
      tooltip: tool.configured ? tool.value : `${tool.name} 未配置。点击“检查工具链”查看建议。`,
      icon: tool.configured ? 'check' : 'warning',
      kind: 'tool',
      contextValue: 'tool',
      command: {
        command: 'co.checkToolchain',
        title: '检查工具链',
        arguments: []
      }
    });
  }

  return sectionItem('materials', '资料', false, children);
}

function sectionItem(id: string, label: string, expanded: boolean, children: SidebarNodeModel[]): SidebarNodeModel {
  return {
    id,
    label,
    icon: 'folder',
    kind: 'section',
    contextValue: 'header',
    expanded,
    children
  };
}

function infoItem(
  id: string,
  label: string,
  description: string,
  tooltip: string,
  icon: string,
  command?: SidebarCommandModel
): SidebarNodeModel {
  return {
    id,
    label,
    description,
    tooltip,
    icon,
    kind: 'info',
    contextValue: 'info',
    command
  };
}

function actionItem(
  id: string,
  label: string,
  command: string,
  icon: string,
  description: string,
  tooltip: string
): SidebarNodeModel {
  return {
    id,
    label,
    description,
    tooltip,
    icon,
    kind: 'action',
    contextValue: 'action',
    command: {
      command,
      title: label,
      arguments: []
    }
  };
}

function hasVisibleChildren(section: SidebarNodeModel): boolean {
  return Boolean(section.children?.length);
}

function isMipsFile(active: SidebarActiveFileModel): boolean {
  return active.languageId === 'mipsasm';
}

function isVerilogFile(active: SidebarActiveFileModel): boolean {
  return active.languageId === 'verilog';
}

function isLogisimCircuitFile(active: SidebarActiveFileModel): boolean {
  return active.isLogisimCircuit || path.extname(active.fsPath).toLowerCase() === '.circ';
}

function shouldShowMipsActions(profile: ProjectProfile, language?: string): boolean {
  return language === 'mipsasm' || mipsProfiles.has(profile);
}

function shouldShowVerilogActions(profile: ProjectProfile, language?: string): boolean {
  return language === 'verilog' || verilogProfiles.has(profile);
}

function shouldShowLogisimActions(profile: ProjectProfile, active?: SidebarActiveFileModel): boolean {
  return Boolean(active && isLogisimCircuitFile(active)) || logisimProfiles.has(profile);
}

function shouldShowTraceActions(profile: ProjectProfile): boolean {
  return traceProfiles.has(profile);
}

function shouldShowAsmGenerationActions(profile: ProjectProfile): boolean {
  return asmGenerationProfiles.has(profile);
}

function summarizeTools(tools: SidebarToolModel[]): { description: string; tooltip: string; icon: string } {
  if (!tools.length) {
    return {
      description: '无必需工具',
      tooltip: '当前 Profile 没有声明必需工具。',
      icon: 'check'
    };
  }
  const configured = tools.filter((tool) => tool.configured).length;
  return {
    description: `${configured}/${tools.length} 已配置`,
    tooltip: tools
      .map((tool) => `${tool.name}: ${tool.configured ? tool.value : '未配置'}`)
      .join('\n'),
    icon: configured === tools.length ? 'check' : 'warning'
  };
}

function configSourceTooltip(context: SidebarModelContext): string {
  return [
    `当前配置来源: ${context.configSource}`,
    `Profile: ${context.profile}`,
    `Top: ${context.topModule}`,
    `TB: ${context.testbench}`,
    `machineCode: ${context.machineCode}`
  ].join('\n');
}

function workspaceTooltip(context: SidebarModelContext, detail: string): string {
  return [detail, context.workspacePath ? `工作区:\n${context.workspacePath}` : undefined]
    .filter(Boolean)
    .join('\n\n');
}

function verilogConfigTooltip(context: SidebarModelContext, active: SidebarActiveFileModel): string {
  return [
    `当前 Verilog:\n${active.fsPath}`,
    `Top: ${context.topModule}`,
    `TB: ${context.testbench}`,
    `机器码名: ${context.machineCode}`,
    `仿真时长: ${context.simTime}`,
    `配置来源: ${context.configSource}`
  ].join('\n');
}

function verilogTestbenchTooltip(context: SidebarModelContext, active: SidebarActiveFileModel): string {
  return [
    verilogConfigTooltip(context, active),
    '',
    `生成 Testbench 时会解析当前光标所在模块。`,
    `若光标模块是 Top，则目标 TB 名为 ${context.testbench}.v；否则使用 <module>_tb.v。`
  ].join('\n');
}

function verilogSimulationDescription(context: SidebarModelContext): string {
  if (context.profile === 'P1') {
    return 'Top/TB 来自配置，无 ASM';
  }
  return 'Top/TB 来自配置，ASM 运行时选择';
}

function verilogSimulationTooltip(context: SidebarModelContext, active: SidebarActiveFileModel): string {
  const lines = [
    verilogConfigTooltip(context, active),
    '',
    `仿真工作目录: .co/isim`,
    `仿真输出: .co/out`,
    `运行时 TB: .co/isim/co_generated_<tb>.v`
  ];
  if (context.profile !== 'P1') {
    lines.push('ASM 会在执行时选择，导入 .co/cases/<caseId>，再复制 code.txt 到 .co/isim/<machineCode>。');
  }
  return lines.join('\n');
}

function defaultSiblingPath(filePath: string, fileName: string): string {
  if (path.isAbsolute(fileName)) {
    return fileName;
  }
  return path.join(path.dirname(filePath), fileName);
}
