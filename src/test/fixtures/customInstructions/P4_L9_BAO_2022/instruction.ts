// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "bao",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "101101 rs:5 rt:5 immediate:16",
  "operands": [
    {
      "kind": "register",
      "field": "rs"
    },
    {
      "kind": "register",
      "field": "rt"
    },
    {
      "kind": "immediate",
      "field": "immediate",
      "signed": true,
      "relocation": "branch"
    }
  ],
  "access": {
    "reads": [
      "rs",
      "rt"
    ],
    "writes": []
  },
  "controlFlow": true,
  "generation": {
    "cases": [
      {
        "registerValues": {
          "rs": 2147483647,
          "rt": 1
        }
      },
      {
        "registerValues": {
          "rs": 1,
          "rt": 2
        }
      }
    ]
  },
  "timing": {
    "hazardClass": "br_r2",
    "reads": [
      {
        "field": "rs",
        "role": "rs",
        "useStage": "D"
      },
      {
        "field": "rt",
        "role": "rt",
        "useStage": "D"
      }
    ],
    "readyStage": "E"
  },
  execute(ctx, fields) {
    const a=ctx.readGpr(fields.rs)|0,b=ctx.readGpr(fields.rt)|0,sum=a+b;
    const taken=sum>0x7fffffff||sum< -0x80000000;
    return {control:{taken,target:(ctx.pc+4+(sx(fields.immediate)<<2))>>>0}};
  }
};
export default instruction;
