// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "bnezalc",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "000001 rs:5 10011 immediate:16",
  "operands": [
    {
      "kind": "register",
      "field": "rs"
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
      "rs"
    ],
    "writes": [
      "$31"
    ]
  },
  "controlFlow": true,
  "generation": {
    "cases": [
      {
        "registerValues": {
          "rs": 0
        }
      },
      {
        "registerValues": {
          "rs": 1
        }
      }
    ]
  },
  "timing": {
    "hazardClass": "br_r1",
    "reads": [
      {
        "field": "rs",
        "role": "rs",
        "useStage": "D"
      }
    ],
    "readyStage": "E"
  },
  execute(ctx, fields) {
    const taken=ctx.readGpr(fields.rs)!==0;
    return {gprWrites:taken?[{register:31,value:(ctx.pc+4)>>>0}]:[],control:{taken,target:(ctx.pc+4+(sx(fields.immediate)<<2))>>>0}};
  }
};
export default instruction;
