// @index sidebar-model — 纯函数式数据模型，四段结构
import * as path from 'path';
import {
  Commands,
  ASM_NEEDED_VERILOG_PROFILES,
  LOGISIM_PROFILES,
  MIPS_PROFILES,
  TRACE_PROFILES,
  VERILOG_PROFILES
} from './constants';
import { getProfileName } from './courseConfig';
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
  configSource: 'VS Code settings';
  topModule: string;
  testbench: string;
  machineCode: string;
  simTime: string;
  simBackend: string;
  activeFile?: SidebarActiveFileModel;
  tools: SidebarToolModel[];
  tutorials: SidebarTutorialModel[];
}

const traceProfiles = TRACE_PROFILES;
const verilogProfiles = VERILOG_PROFILES;
const configuredVerilogProjectProfiles = ASM_NEEDED_VERILOG_PROFILES;
const mipsProfiles = MIPS_PROFILES;
const logisimProfiles = LOGISIM_PROFILES;

export function buildSidebarModel(context: SidebarModelContext): SidebarNodeModel[] {
  return [
    projectSection(context),
    contextSection(context),
    actionsSection(context),
    materialsSection(context)
  ].filter(hasVisibleChildren);
}

function projectSection(context: SidebarModelContext): SidebarNodeModel {
  const toolSummary = summarizeTools(context.tools);
  const children: SidebarNodeModel[] = [
    infoItem('project.profile', 'Profile', profileDescription(context.profile), `配置来源: ${context.configSource}`, context.profile === 'auto' ? 'warning' : 'symbol-class', {
      command: Commands.SelectProjectProfile,
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
      command: Commands.CheckToolchain,
      title: '检查工具链'
    }),
    actionItem(
      'project.wizard',
      '项目向导',
      Commands.ProjectWizard,
      'new-folder',
      '创建结构 / 写入工作区设置',
      workspaceTooltip(context, '项目向导会在当前工作区创建课程目录，并写入 VS Code 工作区设置。')
    ),
    actionItem(
      'project.selectProfile',
      '选择 Profile',
      Commands.SelectProjectProfile,
      'settings-gear',
      context.profile === 'auto' ? '无法自动推断' : `当前 ${context.profile}`,
      '切换 co.project.profile；auto 无法推断时会要求手动选择。'
    ),
    actionItem(
      'project.checkToolchain',
      '检查工具链',
      Commands.CheckToolchain,
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
        '当前没有可用于 CO 操作的 active editor。依赖当前文件的命令不会出现在操作区中。',
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

  if (isVerilogFile(active) && usesVerilogProfile(context.profile)) {
    const children: SidebarNodeModel[] = [
      infoItem('context.verilog', '当前 Verilog', active.basename, active.fsPath, 'file-code')
    ];
    if (usesConfiguredVerilogProject(context.profile)) {
      children.push(
      infoItem('context.top', 'Top', context.topModule, 'co.project.topModule', 'symbol-class'),
      infoItem('context.tb', 'TB', context.testbench, 'co.project.testbench', 'beaker'),
      infoItem('context.machineCode', '机器码名', context.machineCode, '仿真前会复制到 .co/isim/<machineCode>', 'file-binary'),
      infoItem('context.simTime', '仿真时长', context.simTime, 'co.project.simTime', 'watch'),
      infoItem('context.backend', '仿真后端', context.simBackend, 'co.project.simBackend', 'circuit-board')
      );
    } else if (context.profile === 'P1') {
      children.push(infoItem(
        'context.verilogMode',
        '仿真模式',
        '独立模块',
        'P1 Verilog 练习没有统一顶层。运行 ISim 时会优先使用当前 testbench；否则为当前模块生成临时 testbench。',
        'beaker'
      ));
    }
    return sectionItem('context', '当前上下文', true, children);
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
      `${active.fsPath}\n当前文件类型未绑定 CO 操作。`,
      'file'
    )
  ]);
}

function actionsSection(context: SidebarModelContext): SidebarNodeModel {
  const children: SidebarNodeModel[] = [];
  const active = context.activeFile;

  if (shouldShowTraceActions(context.profile)) {
    children.push(
      actionItem(
        'core.automaticTest',
        '运行自动测试',
        Commands.Test.RunGeneratedTraceTests,
        'beaker',
        '生成完整测试并验证 CPU',
        '使用当前 Profile 的默认最强测试方案。'
      ),
      actionItem(
        'core.continuousAutomaticTest',
        '持续自动测试',
        Commands.Test.StartContinuousGeneratedTraceTests,
        'rocket',
        '持续运行自动测试',
        '持续验证 CPU，直到停止或发现问题。'
      ),
      actionItem(
        'core.stopAutomaticTest',
        '停止自动测试',
        Commands.Test.StopContinuousTests,
        'debug-stop',
        '停止当前的自动测试',
        '如果没有正在运行的自动测试，此命令会安全返回。'
      ),
      actionItem(
        'core.testHistory',
        '测试历史 / 失败用例',
        Commands.Test.OpenAsmCaseIndex,
        'history',
        '查看历史结果和失败用例',
        '打开测试历史，用于定位和复现失败。'
      )
    );
  }

  if (shouldShowLogisimActions(context.profile, active)) {
    if (active && isLogisimCircuitFile(active)) {
      children.push(
        actionItem(
          'core.openCircuit',
          '打开 Logisim 电路',
          Commands.Logisim.OpenCurrentCircuit,
          'circuit-board',
          `使用当前电路: ${active.basename}`,
          active.fsPath
        ),
        actionItem(
          'core.injectCircuit',
          'Logisim 注入 ROM',
          Commands.Logisim.InjectRomIntoCircuit,
          'circuit-board',
          '当前 .circ + 运行时选择 ASM',
          `电路:\n${active.fsPath}\n\nASM 会在执行时选择，并导入 .co/cases/<caseId>。`
        )
      );
    }
  }

  if (active && isMipsFile(active) && shouldShowMipsActions(context.profile, active.languageId)) {
    children.push(
      actionItem(
        'core.asmRun',
        'ASM 运行',
        Commands.Mips.RunCurrentFile,
        'play',
        `使用当前 ASM: ${active.basename}`,
        active.fsPath
      ),
      actionItem(
        'core.asmDumpText',
        'ASM 导出文本段',
        Commands.Mips.DumpText,
        'export',
        `写入 ${context.machineCode}`,
        `ASM:\n${active.fsPath}\n\n默认输出:\n${defaultSiblingPath(active.fsPath, context.machineCode)}`
      )
    );
  }

  if (active && isVerilogFile(active) && shouldShowVerilogActions(context.profile, active.languageId)) {
    children.push(
      actionItem(
        'core.runIsim',
        '运行 ISim',
        Commands.Verilog.RunIsim,
        'run',
        verilogSimulationDescription(context),
        verilogSimulationTooltip(context, active)
      ),
      actionItem(
        'core.openWave',
        '查看 ISim 波形',
        Commands.Verilog.OpenIsimWaveform,
        'pulse',
        verilogSimulationDescription(context),
        `${verilogSimulationTooltip(context, active)}\n\nGUI 启动后执行 wave add -r /。`
      ),
      actionItem(
        'core.inspectSignal',
        '查看信号连线',
        Commands.Verilog.InspectSignal,
        'circuit-board',
        `使用当前 Verilog: ${active.basename}`,
        '将光标放在任一信号上，侧边栏会显示声明、驱动和读取位置。'
      )
    );
  }

  children.push(
    actionItem(
      'core.moreTools',
      '更多工具...',
      Commands.ToolsOpenAdvanced,
      'tools',
      '按当前 Profile 显示低频工具',
      '打开高级工具选择器，包含自动测试、VCD、Logisim CSV、Hazard 分析等低频入口。'
    )
  );

  return sectionItem('actions', '操作', true, children);
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
        command: Commands.CheckToolchain,
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
  return profile !== 'auto' && (language === 'mipsasm' || mipsProfiles.has(profile));
}

function shouldShowVerilogActions(profile: ProjectProfile, language?: string): boolean {
  return language === 'verilog' && usesVerilogProfile(profile);
}

function shouldShowLogisimActions(profile: ProjectProfile, active?: SidebarActiveFileModel): boolean {
  return profile !== 'auto' && (Boolean(active && isLogisimCircuitFile(active)) || logisimProfiles.has(profile));
}

function shouldShowTraceActions(profile: ProjectProfile): boolean {
  return traceProfiles.has(profile);
}

function usesConfiguredVerilogProject(profile: ProjectProfile): boolean {
  return configuredVerilogProjectProfiles.has(profile);
}

function usesVerilogProfile(profile: ProjectProfile): boolean {
  return verilogProfiles.has(profile);
}

function profileDescription(profile: ProjectProfile): string {
  return profile === 'auto' ? '未推断' : getProfileName(profile);
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
  const lines = [
    `当前配置来源: ${context.configSource}`,
    `Profile: ${context.profile}`
  ];
  if (usesConfiguredVerilogProject(context.profile)) {
    lines.push(
      `Top: ${context.topModule}`,
      `TB: ${context.testbench}`,
      `machineCode: ${context.machineCode}`
    );
  }
  return lines.join('\n');
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

function verilogSimulationDescription(context: SidebarModelContext): string {
  if (!usesConfiguredVerilogProject(context.profile)) {
    return '当前模块/testbench，无 ASM';
  }
  return 'Top/TB 来自配置，ASM 运行时选择';
}

function verilogSimulationTooltip(context: SidebarModelContext, active: SidebarActiveFileModel): string {
  if (!usesConfiguredVerilogProject(context.profile)) {
    return [
      `当前 Verilog:\n${active.fsPath}`,
      '',
      'P1/独立模块没有统一 Top/TB。',
      '运行时会优先使用当前 testbench；否则为当前模块生成临时 <module>_tb。',
      `仿真工作目录: .co/isim`,
      `仿真输出: .co/out`
    ].join('\n');
  }

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
