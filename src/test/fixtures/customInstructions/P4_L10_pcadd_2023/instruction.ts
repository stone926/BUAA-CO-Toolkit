// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "pcadd",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "000000 rs:5 00000 rd:5 00000 110001",
  "operands": [
    {
      "kind": "register",
      "field": "rd"
    },
    {
      "kind": "register",
      "field": "rs"
    }
  ],
  "access": {
    "reads": [
      "rs"
    ],
    "writes": [
      "rd"
    ]
  },
  "generation": {},
  "timing": {
    "hazardClass": "cal_ri",
    "reads": [
      {
        "field": "rs",
        "role": "rs",
        "useStage": "E"
      }
    ],
    "readyStage": "E"
  },
  execute(ctx, fields) {
    return {gprWrites:[{register:fields.rd,value:(ctx.readGpr(fields.rs)+ctx.pc)>>>0}]};
  }
};
export default instruction;
