`timescale 1ns/1ps
module lane #(parameter [7:0] WIDTH = 8, OTHER = 8)(
    input unused,
    input [WIDTH-1:0] data,
    output [WIDTH-1:0] result
);
    assign result = data;
endmodule

module editor_patterns(input [1:0] sel, input a, b, output reg y);
    parameter CHOICE = 1;
    wire [7:0] left, right;
    wire [7:0] data;
    wire first, second;
    tri (weak1, strong0) ready = a;
    assign (weak1, weak0) first = ready;
    assign second = b, data = {8{a}};
    lane #(.WIDTH(8)) u_left(, data, left), u_right(.unused(), .data(data), .result(right));
    always @* case (sel)
        CHOICE ? 1 : 2: y = first;
        default y = second;
    endcase
endmodule

module delay_source;
    parameter HALF = 2.5, PERIOD = 1e+3;
    reg clk;
    reg [31:0] value;
    initial begin clk = 0; value = 32 'h ff; end
    always #2.5 clk = ~clk;
endmodule
