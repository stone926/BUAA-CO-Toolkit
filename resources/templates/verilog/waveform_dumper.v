// CO_GENERATED_WAVEFORM_DUMPER — BUAA CO Toolkit 为“查看波形”生成，每次运行都会覆盖。
`timescale 1ps/1ps
module ${moduleName};
    initial begin
        // 打印 testbench 时间单位，供波形查看器把 $display trace 对齐到 VCD 时间轴。
        $printtimescale(${testbench});
        $dumpfile(${dumpFile});
${dumpLimit}        $dumpvars(0, ${testbench});
        // 不带存储器的 $dumpvars 不会记录数组，小存储器（如 GRF）逐字加入。
${memoryDumps}    end
endmodule
