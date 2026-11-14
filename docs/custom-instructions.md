# 使用 JS/TS 定义课程自定义指令

扩展可以用同一份 JavaScript / TypeScript 定义完成汇编、内置参考执行和随机测试，无需编译 `.class`。脚本使用 VS Code 自带的 Node 运行时；最低需要 VS Code **1.101**，无需另装 Node、JavaScript 包或 `tsc`。运行时缺少原生模块或类型擦除能力时，会提示更新 VS Code。

## 创建与加载

打开 CPU 工作区，运行命令 **CO: 创建 JS/TS 自定义指令**，选择语言和助记符。命令创建示例、`co-instructions.d.ts` 和供编辑器检查的 `tsconfig.json`，随后打开源码；这些辅助文件不参与指令执行。

```text
.co/custom-instructions/
  addei.ts                 # 入口：default 导出一个定义或定义数组
  another.js               # 另一个入口
  helpers/
    arithmetic.ts          # 被入口静态 import 的辅助模块
  co-instructions.d.ts     # @buaa-co/instructions 的本地类型声明
  tsconfig.json
```

目录直属的 `.js` / `.ts` 文件都是入口，`.d.ts` 除外。辅助模块请放在子目录，避免被当作独立入口加载。使用 ESM 的 `export default`，可以导出一个指令，也可以导出指令数组。

运行时仅接受 `@buaa-co/instructions` 和目录内带明确扩展名的静态相对导入，例如 `import { helper } from './helpers/arithmetic.ts'`。不解析 npm 包、绝对路径、目录外文件、动态 `import()` 或 CommonJS `require()`。路径使用 `/`，支持工作区路径中的空格和中文。

TypeScript 使用原生类型擦除：可以写接口、类型、类型注解和 `import type`；需要代码转换的 `enum`、运行时 `namespace`、构造参数属性等语法需要改写。没有额外的构建步骤。

## 一个完整的 addei 示例

下面按课程练习定义：立即数高位补 1，与寄存器做有符号加法；溢出时写入扩展后的立即数。`addSigned32` 返回的是 `{ result, overflow }`。

```ts
import { defineInstruction, bits } from '@buaa-co/instructions';

export default defineInstruction({
  apiVersion: 1,
  mnemonic: 'addei',
  modes: ['mars', 'P3', 'P4', 'P5', 'P6', 'P7'],
  encoding: '110011 rs:5 rt:5 immediate:16',
  operands: [
    { kind: 'register', field: 'rt' },
    { kind: 'register', field: 'rs' },
    { kind: 'immediate', field: 'immediate' }
  ],
  access: { reads: ['rs'], writes: ['rt'] },
  generation: {},
  timing: {
    hazardClass: 'cal_ri',
    reads: [{ field: 'rs', role: 'rs', useStage: 'E' }],
    readyStage: 'M'
  },
  execute(cpu, fields) {
    const extended = bits.oneExtend(fields.immediate, 16);
    const sum = bits.addSigned32(cpu.readGpr(fields.rs), extended);
    return {
      gprWrites: [{
        register: fields.rt,
        value: sum.overflow ? extended : sum.result
      }]
    };
  }
});
```

保存为 `.co/custom-instructions/addei.ts` 后，可在汇编中写 `addei $3, $1, 2`。在 `co.test.instructions` 中加入 `addei` 可选择随机重点；配置留空时，带 `generation` 配方且支持当前模式的自定义指令会加入默认集合。

## 编码、操作数与 SDK

| 属性 | 含义 |
| --- | --- |
| `apiVersion` | 当前固定为 `1`。 |
| `mnemonic` / `aliases` | 小写助记符与可选别名；别名共享同一编码和语义。 |
| `modes` | 生效模式：普通 MARS 为 `mars`，课程为 `P3` 至 `P7`。 |
| `encoding` | 从最高位到最低位排列的固定位串与 `字段名:宽度`，总计 32 位。 |
| `operands` | 汇编书写顺序；每个可变编码字段都必须由一个操作数提供。 |
| `access` | 读写元数据；实际提交效果仍由 `execute` 返回值决定。 |
| `controlFlow` | 指令可能转移控制流时设为 `true`。 |
| `override` | 显式允许覆盖已有原生名称或编码；不会消除两个自定义定义之间的歧义。 |

寄存器操作数写为 `{ kind: 'register', field: 'rd' }`，对应字段必须是 5 位。立即数写为 `{ kind: 'immediate', field: 'immediate', signed: true }`。访存操作数写为 `{ kind: 'memory', baseField: 'rs', offsetField: 'immediate', signed: true }`，汇编形式为 `offset($base)`，偏移默认有符号。

`execute` 收到的是**解码后的原始无符号字段**：例如 16 位的 `-1` 是 `65535`。`signed` 约束汇编输入，并不会替回调完成符号扩展。请使用 `bits.signExtend(value, width)`；随机配方中的原始 `65535` 会按有符号操作数输出为 `-1`。

可选的 `relocation: 'branch'` 对标签或引用符号的表达式，将字节目标地址换算成 `(目标 - PC - 4) / 4`；纯数字或常量表达式仍是原始有符号位移，兼容 MARS 附件语法。因此 `bonall $1,$2,1` 与跳到隔一条指令的标签编码相同。`'jump'` 的数字仍是字节地址，并检查对齐与同一 256 MiB 区域。题目特有的倍数位移（如 `blztal`）也可保留普通 `immediate`，在回调和随机配方中单独描述缩放。

SDK 导出 `defineInstruction`、`bits`，以及可直接命名导入的 `u32`、`s32`、`zeroExtend`、`signExtend`、`oneExtend`、`addSigned32`、`subtractSigned32`。JavaScript 的 `Number` 不是任意精度整数；32 位运算请显式归一化，带溢出判断的加减使用 SDK 辅助函数。

`access.reads` / `writes` 可列操作数字段、`'$31'`、`'hi'`、`'lo'`；数据决定目的寄存器时用 `'dynamic'`。访存还可声明 `memory: 'load' | 'store'` 与 `width: 1 | 2 | 4`。这些元数据不能代替实际的读写回调与效果。

## 读取状态并返回效果

回调只读取上下文，并同步返回效果对象。不要直接修改 CPU、寄存器、内存或传入字段。

| 上下文 | 含义 |
| --- | --- |
| `cpu.pc` / `delaySlot` | 当前指令地址、是否位于延迟槽。 |
| `cpu.linkAddress` | 当前模式的链接地址；P3/P4 为 PC+4，P5–P7 为 PC+8。 |
| `readGpr(n)` | 读取 0–31 号 GPR，返回无符号 32 位值。 |
| `readHi()` / `readLo()` | 读取 HI/LO；未定义状态会按执行策略报告。 |
| `load(address, width, signed?, addressOverflow?)` | 通过内存总线读取，宽度为 1、2 或 4 字节。 |

| 返回属性 | 示例与约束 |
| --- | --- |
| `gprWrites` | `[{ register: fields.rt, value }]`；允许条件写或动态目的寄存器，`$0` 保持为零。 |
| `hiLoWrites` | `[{ register: 'hi', value }]` 或 `'lo'`。 |
| `store` | `{ address, width: 4, value, addressOverflow? }`。 |
| `control` | `{ target, taken, annulDelaySlot? }`；必须声明 `controlFlow: true`。 |
| `trap` | `{ name: 'ov', message?: '...' }` 等受支持的架构异常。 |

每条指令至多进行一次架构访存：调用一次 `load`，或返回一次 `store`，不能组合成多次访问。总线负责地址、对齐、权限与 P7 设备检查；发生访存异常或显式陷阱时，不会提交该指令的部分寄存器、HI/LO 或存储效果。写目的不能重复，回调不能返回 Promise。

分支必须同时给出目标和 `taken`，链接写入应按题目条件放进 `gprWrites`。P5–P7 的普通转移执行延迟槽；`annulDelaySlot: true` 只在**未跳转且当前模式有延迟槽**时取消该槽。P3/P4 没有延迟槽。需要题目特有的 PC+4 写回时直接使用 `cpu.pc + 4`，不要误用通用链接地址。

P7 使用原有精确异常、CP0、IRQ、Timer/MMIO 总线与返回流程；自定义指令不会关闭已有的 anchor/probe/hybrid 测试。Timer 访问仍须服从设备 cycle schedule 的比较边界；DUT-only probe 的通过不表示已经取得完整参考执行证据。P3–P6 不会因声明一个陷阱就获得 P7 的异常硬件。

## 让指令参与随机生成

`generation` 可省略：此时仍可汇编和执行用户 ASM，但不进入随机默认集合；在随机重点中显式选择会提示缺少支持。普通运算或标准访存操作数通常可从 `generation: {}` 开始。

| 配方项 | 实际作用 |
| --- | --- |
| `weight` | 随机抽取权重，整数 1–1000。 |
| `fields.<字段>.min/max/values` | 编码字段取值限制；寄存器字段限制的是寄存器编号。 |
| `fields.<寄存器字段>.address` | 选择当前保存合法课程 DM 地址的 GPR，可设 `alignment`、`width`，取 1/2/4。 |
| `cases` | 若干 `{ registerValues: { 字段: 值 } }`；先用正常前导指令建立受控寄存器值。 |
| `control` | 指定控制目标字段、`branch/jump/absolute` 编码方式及可选的额外位移缩放。 |

标准 `memory` 操作数会依据当前寄存器和 DM 状态选择安全有效地址；生成器用同一个语义回调更新 GPR、内存和 HI/LO。动态目的、条件写、条件链接由返回效果计算，不会按助记符猜测。无合法候选或预算不足时，生成器保留程序容量与停机约束，不发出越界半段。

下面是 `blztal` 所需的控制配方；它的立即数操作数不声明汇编重定位，保留原始倍数位移语法：

```ts
generation: {
  control: {
    targetField: 'immediate',
    relocation: 'branch',
    shiftBy: { field: 'rt', mask: 3 }
  },
  cases: [
    { registerValues: { rs: -1, rt: 0 } },
    { registerValues: { rs: 1, rt: 1 } }
  ]
}
```

`shiftBy` 表示额外乘以 `2 ** (GPR[字段] & mask)`。生成器选择可精确编码的前向汇合目标，并按实际跳转、链接和 annul 效果处理可观察路径。自定义控制流仍受有界执行、课程文本容量、P7 的 0x4180 边界和标准 halt 尾约束。

### 冒险时机与覆盖范围

`timing.hazardClass` 使用课程 AT 类别，例如 `cal_rr`、`cal_ri`、`load`、`store`、`br_r1`、`br_r2`。`reads` 逐项声明 `{ field, role: 'rs' | 'rt', useStage: 'D' | 'E' | 'M' | 'W' }`；`readyStage` 声明写回值可供转发的阶段。课程模型中常见 ALU 为 `M`、load 为 `W`、链接结果为 `E`。

`latency` 和 `initiationInterval` 是可保存的附加元数据，不能据此声称已经模拟自定义多周期部件。生成器会混合普通/自定义生产者和消费者、定向安排间隔，并使用实际目的寄存器和条件写结果。还会检查替换旧源值是否改变架构效果；被掩蔽或无法判断的依赖不计入有效转发覆盖。

缺少 AT 时机、无法表达的多目的写等情况会中断对应覆盖观察，不会套用一个虚构的完整时机表。覆盖统计描述本次生成程序在声明的课程模型中的结果，不能替代 RTL 周期验证。

### 覆盖原生指令的限制

`override: true` 允许有意改变已有名称或编码，适合用户 ASM 验证。自动测试仍依赖课程前导、GPR 检查、停机尾、异常处理程序和 probe 的基础指令语义。若实际使用的基础指令名称或规范编码被覆盖，生成器会列出冲突并停止，提示改用用户 ASM；不会先用错误模型生成用例再归咎于 CPU。

这项检查针对实际使用的原生依赖，不会因出现 `override: true` 就拒绝全部自定义指令。作为自定义 payload 发射且不替换固定辅助代码的指令仍可使用；任意改写必需基础 ISA 的语义不保证可进行自动随机测试。

## 纯回调、快照与重放

`execute` 必须是仅由上下文和字段决定的纯函数。不要依赖模块计数器、可变闭包、缓存里的历史状态、时间、随机数或调用次数。生成器需要试探操作数与错误转发来源，回调可能被多次调用；调用次数不等于 CPU 执行次数。`Date` 不可用，`Math.random()` 会直接报错。

脚本在专用 Worker 中加载和执行，支持取消、运行时间和内存限制。工作区脚本应来自可信来源；Worker/VM 是可靠性与取消隔离，不能当作恶意代码的安全沙箱。

每次测试固定入口及其相对依赖的完整内容、擦除后的 JavaScript、SDK/运行时身份与指纹。持续随机会话只捕获一次；同一用例的生成、汇编和参考执行绑定同一快照。即使启动时没有脚本，这个空注册表决定也会固定。

用例保存 `source/custom-instructions.json` 及校验信息，历史重跑使用保存内容，不读取今天工作区里的同名文件，也不静默更换参考引擎。修改脚本后请开始新测试；损坏、缺失或指纹不符的快照会明确报错。源码语法、导入、注册表、脚本执行、超时等错误属于工具/参考错误，不作为 CPU 功能失败。

目前快照限制为最多 128 个文件、单文件 256 KiB、源码合计 2 MiB。只追踪指令入口及其依赖，不扫描整个工作区。

## 与 `.class` 共存及练习示例

原有 `.class` 仍可放在同一目录。JS/TS 定义走内置完整汇编与执行链；显式选择 Mars 参考时，仍使用配置的 modded Mars 和 `.class`。没有 JS/TS 绑定时，用户 ASM 的 auto 路径可在执行前因未知指令选择完整 custom-Mars 引擎；已经绑定脚本后，未实现的指令会报错，不会拼接“脚本汇编 + `.class` 执行”的半套参考。

23 个独立练习包及边界向量位于 [课程指令译本](../src/test/fixtures/customInstructions/README.md)。每个 `instruction.ts` 可作为参考；复制到工作区后，可用创建命令安装本地 SDK 类型声明。相同助记符或冲突编码的练习应分开测试，例如 `addei/lhogez`、`bonall/lwer`，不能全部同时加载。

2022 与 2023 的两个 BOMEZ `.class` 已知把模运算的两个 popcount 参数颠倒，两个附件字节相同；译本按题面实现。BOMEZ 与 BONALL 的原附件还与题面编码图存在源寄存器顺序差异，译本保留经真实附件验证的编码。差异、来源与验证向量记录在上述 README 和各包文件中，不通过悄悄改写机器码来掩盖。
