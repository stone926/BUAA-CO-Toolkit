`timescale 1ns / 1ps

module decision_timer_restart_tb;
  reg clk = 0;
  reg reset = 0;
  reg [31:2] Addr = 0;
  reg WE = 0;
  reg [31:0] Din = 0;
  wire [31:0] Dout;
  wire IRQ;

  TC dut(.clk(clk), .reset(reset), .Addr(Addr), .WE(WE), .Din(Din), .Dout(Dout), .IRQ(IRQ));

  task edge_and_snapshot;
    input [8*32-1:0] label;
    begin
      #5 clk = 1;
      #1 $display("SNAP %0s %0d %0d %0d %0d %0d %0d", label, dut.state,
                  dut.mem[0], dut.mem[1], dut.mem[2], dut._IRQ, IRQ);
      #4 clk = 0;
    end
  endtask

  initial begin
    reset = 1;
    edge_and_snapshot("reset");
    reset = 0;

    WE = 1; Addr = 30'h1; Din = 32'd2;
    edge_and_snapshot("write_preset");

    WE = 1; Addr = 30'h0; Din = 32'd9;
    edge_and_snapshot("write_enable");

    WE = 0;
    edge_and_snapshot("initial_load");
    edge_and_snapshot("initial_count_load");
    edge_and_snapshot("count_one");
    edge_and_snapshot("irq_set");
    edge_and_snapshot("mode0_idle");

    WE = 1; Addr = 30'h0; Din = 32'd9;
    edge_and_snapshot("restart_write");

    WE = 0;
    edge_and_snapshot("restart_load");
    edge_and_snapshot("restart_count_load");
    $finish;
  end
endmodule
