`timescale 1ns / 1ps

// ${topModuleName} 的测试激励：由 BUAA CO Toolkit 生成，插件不会覆盖此文件。
// 编写激励后点击编辑器右上角的运行按钮；$monitor 的输出显示在“输出”面板，并保存到 .co/out/${tbName}.sim.out。
module ${tbName};

${parameterBlock}${inputBlock}${outputBlock}    // 被测模块实例（UUT）
    ${topModuleName}${parameterOverrides} uut (
${connections}    );

${clockBlock}${monitorBlock}    initial begin
${stimulusBody}    end

    // 如需波形：取消下面的注释，运行后用 VCD 查看器打开 .co/isim/${tbName}.vcd
    // initial begin
    //     $dumpfile("${tbName}.vcd");
    //     $dumpvars(0, ${tbName});
    // end

endmodule
