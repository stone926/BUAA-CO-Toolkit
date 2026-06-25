`default_nettype none

module child(input a, input b, output y);
    assign y = a & b;
endmodule

module top(input clk, input a, input b, output reg y);
    wire child_y;
    integer i;

    child #() u_child(.a(a), .b(b), .y(child_y));

    always @(posedge clk) begin
        for (i = 0; i < 2; i = i + 1) begin
            y <= child_y;
        end
    end
endmodule
