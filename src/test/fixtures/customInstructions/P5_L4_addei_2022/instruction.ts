// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "addei",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "110011 rs:5 rt:5 immediate:16",
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
      "field": "immediate",
      "signed": true
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
  "generation": {
    "cases": [
      {
        "registerValues": {
          "rs": 0
        }
      },
      {
        "registerValues": {
          "rs": -2147483648
        }
      },
      {
        "registerValues": {
          "rs": 2147483647
        }
      }
    ]
  },
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
    const immediate=(fields.immediate|0xffff0000)|0,sum=(ctx.readGpr(fields.rs)|0)+immediate;
    return {gprWrites:[{register:fields.rt,value:(sum>0x7fffffff||sum< -0x80000000?immediate:sum)>>>0}]};
  }
};
export default instruction;
