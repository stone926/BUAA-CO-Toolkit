`timescale 1ns / 1ps

module ${tbName};
${declarations}${memoryDeclarations}
    ${topModuleName} uut (
${connections}    );

${memoryInitialBlock}${memoryReadBlock}${dataWriteBlock}${storeContractBlock}${writebackTraceBlock}${courseInitialBlock}${clockBlock}endmodule
