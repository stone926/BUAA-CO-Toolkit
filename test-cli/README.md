# BUAA CO test-cli

BUAA CO Toolkit 的 P7 无头持续自动测试入口。构建时会复用插件中的课程测试实现并注入最小 `vscode` 运行时 shim，因此运行测试时不需要启动 VS Code。

CLI 与插件共用同一套自动测试策略。默认每轮都会使用 P7 允许范围内的最大测试负载并启用全部内置验证维度；持续执行直到发现问题或用户发送中止信号。覆盖强度、场景组合、循环调度、失败停止、产物留存、随机化和仿真预算均由工具内部管理，不能从命令行调低。

唯一可自定义的测试内容是 payload 指令集。项目位置、ISE 工具链路径、DUT 顶层模块和输出格式仍可配置。

## 构建

```bash
cd test-cli
npm install
npm run build
```

构建产物位于 `test-cli/dist`，推荐入口为 `test-cli/dist/cli.js`。构建脚本只读取 `../src` 与 `../resources`，不会修改插件源文件。

## 运行

```bash
node test-cli/dist/cli.js \
  --project <P7项目目录> \
  --ise <ISE安装目录> \
  --instructions "add, sub, ori, lw, sw, beq, lui, jal, jr, mfc0, mtc0, eret, syscall, nop"
```

`--instructions` 接受逗号或空白分隔的真实 MIPS 指令；留空时使用 P7 Profile 默认指令集。测试框架所需的安全脚手架和异常处理代码不受该列表限制。

使用 `--help` 查看项目、ISE、DUT 顶层模块和报告格式参数。旧版的强度、次数、间隔、场景、异常、中断、种子、留存、仿真时长、私有 testbench 和中间产物参数会被明确拒绝，不会静默改变最强策略。

## 工具链与 DUT

- P7 自动路径使用 ISE/ISim 验证 Verilog DUT，其余参考与测试点准备无需额外工具链配置。
- `--ise` 指向 Xilinx ISE 安装目录。
- `--top-module` 用于定位项目 DUT；自动 testbench、机器码文件名和执行预算由工具内部管理。
- 自动测试始终执行静默工具链预检，防止在环境不完整时生成误导性的结果。

## 报告与退出码

默认报告写入项目的 `.co/out/continuous-trace-report.json`，也可用 `--report` 指定输出位置。公开 JSON 只包含轮次状态、汇总、匿名测试点、复现编号和 CPU 差异证据，不包含本机路径、外部命令、工作目录或内部策略。

- `0`：测试正常结束且已执行轮次全部通过
- `1`：存在失败/错误，或启动失败
- `2`：命令行参数错误
- `130`：收到中止信号
