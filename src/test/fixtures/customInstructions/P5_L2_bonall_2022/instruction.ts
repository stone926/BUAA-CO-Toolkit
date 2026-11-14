// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "bonall",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "011001 rt:5 rs:5 immediate:16",
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
    "writes": [
      "$31"
    ]
  },
  "controlFlow": true,
  "generation": {
    "cases": [
      {
        "registerValues": {
          "rs": 1,
          "rt": -1
        }
      },
      {
        "registerValues": {
          "rs": 1,
          "rt": 1
        }
      },
      {
        "registerValues": {
          "rs": -2147483648,
          "rt": -2147483648
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
    const taken=(ctx.readGpr(fields.rs)|0)+(ctx.readGpr(fields.rt)|0)===0;
    return {gprWrites:[{register:31,value:ctx.linkAddress}],control:{taken,target:(ctx.pc+4+(sx(fields.immediate)<<2))>>>0,annulDelaySlot:!taken}};
  }
};
export default instruction;
