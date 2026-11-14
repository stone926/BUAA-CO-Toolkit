// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "bomez",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "101100 rt:5 rs:5 immediate:16",
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
          "rs": 3,
          "rt": 1
        }
      },
      {
        "registerValues": {
          "rs": 1,
          "rt": 3
        }
      },
      {
        "registerValues": {
          "rs": 0,
          "rt": 1
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
    const a=ones(ctx.readGpr(fields.rs)),b=ones(ctx.readGpr(fields.rt));
    const taken=a!==0&&b!==0&&a%b===0;
    return {control:{taken,target:(ctx.pc+4+(sx(fields.immediate)<<2))>>>0}};
  }
};
export default instruction;
