# Tutorial references（教程引用）

课程教程、官方 PDF、官方 Verilog/TB 不自动继承 MARS 的 MIT 许可。conformance 不把教程
原文拷贝进扩展仓库；本目录只保存来源引用、contract ID 与条款摘录，实际向量以自写的
最小 microprogram（`spec-microprograms/`）或引用路径 + 内容 hash 表达。

首批引用（contracts.json 已逐条登记 `normativeReference`，此处为语料视角的入口清单）：

| 来源 | 位置 | 用途 |
| --- | --- | --- |
| P3 模块规格 | `cscore/markdown/P3/P3-2.md` | IM/DM 容量、复位、PC 初值契约 |
| P4 设计 | `cscore/markdown/P4/P4-1.md` | 单周期无延迟槽、10 条指令集 |
| P5 流水线 | `cscore/markdown/P5/project/P5-5-1.md`、`P5-5-3.md` | 延迟槽、link=PC+8 |
| P7 外设/地址空间 | `cscore/markdown/P7/implement/P7-2-2.md` | 地址空间表、IG 应答 |
| P7 CP0/异常 | `cscore/markdown/P7/implement/P7-2-3.md` | CP0 位域、ExcCode 表 |
| P7 精确异常 | `cscore/markdown/P7/implement/P7-2-4.md` | 宏观 PC、EPC、BD、流水异常码 |
| P7 handler 示例 | `cscore/markdown/P7/implement/P7-2-5.md` | eret 无延迟槽、官方 handler 结构 |
| P7 提交要求 | `cscore/markdown/P7/implement/P7-2-6.md` | 指令约束、中断异常约束、官方场景边界 |
| 官方 Timer | `cscore/markdown/assets/cscore-assets/P7_standard_timer_2019.v` | Timer 寄存器映射与状态机 |
| Timer 规范 PDF | `cscore/markdown/assets/cscore-assets/COCO定时器设计规范-1.0.0.4.pdf` | Timer 行为规范 |

后续阶段把教程代码片段转为最小向量时，每条向量必须携带：
contract ID + 教程来源路径 + 行号区间 + 内容 SHA-256（防止教程改版后静默漂移）。
