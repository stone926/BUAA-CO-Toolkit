// @index single-generate-fixtures — Shared indexed diagnostic and real compiler vectors
export const invalidSingleGenerateCases = [
  ['if range', 'module m(input n); if(1) wire [ [[n]] :0] a; endmodule', 'nonconstant-expression'],
  ['for parameter', 'module m(input n); genvar i; for(i=0;i<2;i=i+1) localparam P=[[n]]; endmodule', 'nonconstant-expression'],
  ['case range', 'module m(input n); case(1) 1:wire [ [[n]] :0] a; endcase endmodule', 'nonconstant-expression'],
  ['nested for range', 'module m(input n); genvar i; if(1) for(i=0;i<2;i=i+1) wire [ [[n]] :0] a; endmodule', 'nonconstant-expression'],
  ['iteration assignment', 'module m; genvar i; for(i=0;i<2;i=i+1) assign [[i]]=1; endmodule', 'invalid-assignment-target']
] as const;

export const validSingleGenerateCases = [
  'module m; if(1) wire [3:0] a; endmodule',
  'module m; genvar i; for(i=0;i<2;i=i+1) wire [i:0] a; endmodule',
  'module m; if(1) wire a; if(1) wire a; endmodule',
  'module m; genvar i; for(i=0;i<2;i=i+1) wire a; for(i=0;i<2;i=i+1) wire a; endmodule',
  'module m; case(1) 1:wire [3:0] a; default:wire [2:0] a; endcase endmodule',
  'module m; genvar i,j; for(i=0;i<2;i=i+1) for(j=0;j<2;j=j+1) wire [i+j:0] a; endmodule',
  'module m(output [1:0] y); genvar i; for(i=0;i<2;i=i+1) assign y[i]=i; endmodule',
  'module m; if(1) function f(input x); f=x; endfunction if(1) function f(input x); f=x; endfunction endmodule'
] as const;
