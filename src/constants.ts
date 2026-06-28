// @index constants — 集中常量：Profile分组/路径约定/输出目录名
import { profilesWithCapability } from './courseConfig';
import { ProjectProfile } from './projectProfile';

// ── Profile 分组 ──

/** 所有可选 Profile（含 auto）。 */
export const ALL_PROFILES: ProjectProfile[] = [
  'auto', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'
];

/** 具体 Project Profile（不含 auto）。 */
export const CONCRETE_PROFILES: ProjectProfile[] = [
  'P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'
];

/** 产生 CPU Trace 的 Profile。 */
export const TRACE_PROFILES = new Set<ProjectProfile>(profilesWithCapability('trace'));

/** 使用 Verilog 开发流程的 Profile。 */
export const VERILOG_PROFILES = new Set<ProjectProfile>(profilesWithCapability('verilog'));

/** 使用 MIPS 汇编（Mars 运行）的 Profile。 */
export const MIPS_PROFILES = new Set<ProjectProfile>(profilesWithCapability('mips'));

/** Logisim 电路相关的 Profile。 */
export const LOGISIM_PROFILES = new Set<ProjectProfile>(profilesWithCapability('logisim'));

/** 需要 ASM case 才能仿真对拍的 Verilog Profile。 */
export const ASM_NEEDED_VERILOG_PROFILES = new Set<ProjectProfile>(profilesWithCapability('asmNeededForVerilog'));

/** 需要 Hazard 对拍的 Profile。 */
export const HAZARD_PROFILES = new Set<ProjectProfile>(profilesWithCapability('hazard'));

/** 流水线 CPU（有延迟槽）的 Profile。 */
export const DELAYED_BRANCHING_PROFILES = new Set<ProjectProfile>(profilesWithCapability('delayedBranching'));

/** 需要停机自环的 CPU Profile（P7 自带内核合并，单独处理）。 */
export const CPU_HALT_PROFILES = new Set<ProjectProfile>(profilesWithCapability('cpuHalt'));

/** 追踪产生时配置文件/上下文 Profile 映射。 */
export const TRACE_CONTEXT_PROFILES = new Set<ProjectProfile>(TRACE_PROFILES);

export const VERILOG_CONTEXT_PROFILES = new Set<ProjectProfile>(VERILOG_PROFILES);

// ── 路径约定 ──

/** 插件输出根目录（相对于工作区）。 */
export const CO_DIR = '.co';

/** 课程测试用例存储目录。 */
export const CO_CASES_DIR = '.co/cases';

/** MARS/ISim 输出目录。 */
export const CO_OUT_DIR = '.co/out';

/** ISim 工程目录。 */
export const CO_ISIM_DIR = '.co/isim';

/** Hazard 分析输出目录。 */
export const CO_HAZARD_DIR = '.co/hazard';

/** 临时文件目录。 */
export const CO_TMP_DIR = '.co/tmp';

/** ISE 语法检查临时目录。 */
export const CO_ISE_CHECK_DIR = '.co/ise-check';

/** Logisim 用例准备目录。 */
export const CO_LOGISIM_DIR = '.co/logisim';

// ── 命令 ID ──

export const Commands = {
  CheckToolchain: 'co.checkToolchain',
  SidebarRefresh: 'co.sidebar.refresh',
  SelectProjectProfile: 'co.selectProjectProfile',
  ProjectWizard: 'co.projectWizard',
  ToolsOpenAdvanced: 'co.tools.openAdvanced',

  Mips: {
    DisablePseudoWarnings: 'co.mips.disablePseudoWarnings',
    RunCurrentFile: 'co.mips.runCurrentFile',
    RunAndCapture: 'co.mips.runAndCapture',
    RunWithStdinFile: 'co.mips.runWithStdinFile',
    RunInTerminal: 'co.mips.runInTerminal',
    DumpText: 'co.mips.dumpText',
    DumpKernelText: 'co.mips.dumpKernelText'
  },

  Verilog: {
    DisableLintRule: 'co.verilog.disableLintRule',
    GenerateTestbench: 'co.verilog.generateTestbench',
    GenerateIseProject: 'co.verilog.generateIseProject',
    CheckSyntaxWithIse: 'co.verilog.checkSyntaxWithIse',
    RunIsim: 'co.verilog.runIsim',
    OpenIsimWaveform: 'co.verilog.openIsimWaveform',
    ExportVcd: 'co.verilog.exportVcd',
    InspectSignal: 'co.verilog.inspectSignal'
  },

  Test: {
    RunFullTest: 'co.test.runFullTest',
    RunBatchTraceTests: 'co.test.runBatchTraceTests',
    RunGeneratedTraceTests: 'co.test.runGeneratedTraceTests',
    StartContinuousGeneratedTraceTests: 'co.test.startContinuousGeneratedTraceTests',
    GenerateAsmTests: 'co.test.generateAsmTests',
    GenerateAndDumpAsmTests: 'co.test.generateAndDumpAsmTests',
    StopContinuousTests: 'co.test.stopContinuousTests',
    PrepareLogisimCases: 'co.test.prepareLogisimCases',
    DiagnoseP3LogisimTraceCircuit: 'co.test.diagnoseP3LogisimTraceCircuit',
    PrepareGeneratedLogisimCases: 'co.test.prepareGeneratedLogisimCases',
    OpenBatchTraceReport: 'co.test.openBatchTraceReport',
    OpenAsmCaseIndex: 'co.test.openAsmCaseIndex',
    CompareTraceFiles: 'co.test.compareTraceFiles',
    CompareLatestOutputs: 'co.test.compareLatestOutputs'
  },

  Logisim: {
    GenerateRom: 'co.logisim.generateRom',
    InjectRomIntoCircuit: 'co.logisim.injectRomIntoCircuit',
    ConvertLogToCsv: 'co.logisim.convertLogToCsv',
    OpenCurrentCircuit: 'co.logisim.openCurrentCircuit'
  },

  Hazard: {
    AnalyzeCurrentMachineCode: 'co.hazard.analyzeCurrentMachineCode',
    OpenReport: 'co.hazard.openReport'
  },

  Course: {
    OpenTutorial: 'co.course.openTutorial',
    OpenProfileTutorial: 'co.course.openProfileTutorial',
    OpenTutorialLink: 'co.course.openTutorialLink'
  },

  Diagnostics: {
    DisableCode: 'co.diagnostics.disableCode'
  },

  Server: {
    MipsIgnorePseudoWarningsForFile: 'co.server.mips.ignorePseudoWarningsForFile',
    MipsIgnorePseudoWarningsForMnemonic: 'co.server.mips.ignorePseudoWarningsForMnemonic',
    InternalVerilogCheckSyntaxWithIse: 'co.internal.verilog.checkSyntaxWithIse'
  }
} as const;
