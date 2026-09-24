`timescale 1ns / 1ps

// ${topModuleName} 的测试激励：由 BUAA CO Toolkit 生成，插件不会覆盖此文件。
// 编写激励后点击编辑器右上角的运行按钮；$monitor 的输出显示在“输出”面板，并保存到 .co/out/${tbName}.sim.out。
module ${tbName};

${parameterBlock}${inputBlock}${outputBlock}    // 被测模块实例（UUT）
    ${topModuleName}${parameterOverrides} uut (
${connections}    );

${clockBlock}${monitorBlock}    initial begin
${stimulusBody}    end

    // 查看波形：点击编辑器右上角的「仿真并查看波形」，插件会自动记录全部信号并在 VS Code 中打开，无需手写 $dumpfile。
    // 如需用其他工具查看，也可以取消下面的注释，运行后 VCD 写入 .co/isim/${tbName}.vcd
    // initial begin
    //     $dumpfile("${tbName}.vcd");
    //     $dumpvars(0, ${tbName});
    // end

endmodule
