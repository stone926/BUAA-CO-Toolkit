// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "ras",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "111111 rs:5 rt:5 immediate:16",
  "operands": [
    {
      "kind": "register",
      "field": "rt"
    },
    {
      "kind": "register",
      "field": "rs"
    },
    {
      "kind": "immediate",
      "field": "immediate"
    }
  ],
  "access": {
    "reads": [
      "rs"
    ],
    "writes": [
      "rt"
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
    const count=fields.immediate&0xffff;
    const mask=count===0?0:count>=32?0xffffffff:(0xffffffff<<(32-count));
    return {gprWrites:[{register:fields.rt,value:((ctx.readGpr(fields.rs)^mask)>>ones(count))>>>0}]};
  }
};
export default instruction;
