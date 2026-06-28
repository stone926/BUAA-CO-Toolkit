`timescale 1ns / 1ps

module ${tbName};
    reg clk;
    reg reset;

    ${topModule} uut (
        .clk(clk),
        .reset(reset)
    );

    initial begin
        clk = 1'b0;
        forever #5 clk = ~clk;
    end

    initial begin
        reset = 1'b1;
        #20;
        reset = 1'b0;
        #200000;
        $finish;
    end
endmodule
