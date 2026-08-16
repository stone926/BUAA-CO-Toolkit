# BUAA CO test-cli

从 BUAA CO Toolkit 插件中抽取出的 **P7 无头持续测试 CLI**。保持插件原有代码不变，构建时把课程测试管线复制到 `test-cli/dist` 并注入一个最小 `vscode` 运行时 shim，因此不需要启动 VS Code。

管线循环：

1. 内置随机 ASM 测试点生成（支持自定义 P7 指令集）
2. MARS dump 机器码
3. MARS 黄金 Trace（coL2）
4. ISim Verilog 仿真 Trace
5. Trace 对拍（anchor）或 DM Probe 检查（probe），hybrid 每轮同时跑两者
6. 写 `.co/out/continuous-trace-report.json`，按策略保留通过/失败产物并进入下一轮

## 构建

```bash
cd test-cli
npm install
npm run build
```

构建产物位于 `test-cli/dist`，入口：

- `test-cli/dist/cli.js`（推荐）
- `test-cli/dist/test-cli/src/cli.js`

构建脚本只读取 `../src` 与 `../resources` 复制到 `test-cli/.build-src` 和 `dist`，不修改插件原有代码；`dist/node_modules/vscode` 是注入的无头 shim，使 `dist` 脱离 VS Code 运行。

## 运行

```bash
node test-cli/dist/cli.js --project <P7项目目录> \
  --mars-p7 <Mars-with-BUAA-CO-extension jar> \
  --ise <ISE安装目录> \
  --instructions "add, sub, ori, lw, sw, beq, lui, jal, jr, mfc0, mtc0, eret, syscall, nop" \
  --count 200 --iterations 3 --stress anchor
```

常用参数见 `--help`。默认 Profile 固定为 P7，内存配置固定为 `CompactLargeText`。

### 指令集配置

`--instructions` 接受逗号或空白分隔的真实 MIPS 指令（不接受伪指令）。留空时使用 P7 Profile 默认指令集。自定义指令集后，是否启用异常/中断由以下参数共同决定：

- `--stress off` 且 `--exception-rate 0 --exception-types ""`：可运行不含 `mfc0/mtc0/eret` 的最小指令集
- 启用 syscall/trap 指令、`--exception-rate > 0` 或 `--interrupt` 时，生成器要求指令集包含 `mfc0 mtc0 eret`
- `--exception-types RI` 需要支持 `cl` 额外指令加载的修改版 MARS

## 工具链

- MARS：`--mars-p7` 优先，未配置时回退 `--mars`；需要支持 `coL1`/`coL2`、`efc`、`p7irq` 和 `CompactLargeText`
- ISE：`--ise` 指向 Xilinx ISE 根目录（需要 `fuse`/`isim`）
- Java：`--java`，默认 `java`

可用 `--skip-toolchain-check` 跳过启动工具链检查（失败仍会在用例执行阶段体现）。

## 退出码

- `0`：所有轮次通过
- `1`：存在失败/错误，或启动失败
- `2`：命令行参数错误
