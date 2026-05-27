该项目是一个为计算机组成（CO）课程服务的开箱即用VSCode插件

`E:\VSCode\BUAA-CO\cscore\site\cscore.buaa.edu.cn\tutorial` 是该课程的教学用教程，`tutorial_toolchain_vscode_plugin_analysis.md` 是对教程中涉及的工具链的分析与对相应插件功能的建议

`CO-Extension设计文档.md` 是基于 `tutorial_toolchain_vscode_plugin_analysis.md` 编写的初步设计建议，不一定要完全复制，但可以参考

关于Verilog和MIPS ASM语言服务，你可以参考既有的开源项目或VSCode插件，在其基础上拓展和强化功能，不必从头重新写

关于Verilog的运行和调试，目前只需支持ISE，其他工具暂不接入，但保留未来接入的可能

本地目前没有安装ISE