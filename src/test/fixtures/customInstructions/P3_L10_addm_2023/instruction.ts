// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "addm",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "000000 rs:5 rt:5 rd:5 00000 001110",
  "operands": [
    {
      "kind": "register",
      "field": "rd"
    },
    {
      "kind": "register",
      "field": "rs"
    },
    {
      "kind": "register",
      "field": "rt"
    }
  ],
  "access": {
    "reads": [
      "rs",
      "rt"
    ],
    "writes": [
      "rd"
    ]
  },
  "generation": {},
  "timing": {
    "hazardClass": "cal_rr",
    "reads": [
      {
        "field": "rs",
        "role": "rs",
        "useStage": "E"
      },
      {
        "field": "rt",
        "role": "rt",
        "useStage": "E"
      }
    ],
    "readyStage": "E"
  },
  execute(ctx, fields) {
    const a=ctx.readGpr(fields.rs)|0, b=ctx.readGpr(fields.rt)|0;
    return {gprWrites:[{register:fields.rd,value:Math.max(a,b,(a+b)|0)>>>0}]};
  }
};
export default instruction;
