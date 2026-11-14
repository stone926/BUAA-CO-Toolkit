// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "blztal",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "100111 rs:5 rt:5 immediate:16",
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
      "signed": true
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
    "control": {
      "targetField": "immediate",
      "relocation": "branch",
      "shiftBy": {
        "field": "rt",
        "mask": 3
      }
    },
    "cases": [
      {
        "registerValues": {
          "rs": -1,
          "rt": 0
        }
      },
      {
        "registerValues": {
          "rs": 1,
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
    const taken=(ctx.readGpr(fields.rs)|0)<0;
    const displacement=sx(fields.immediate)<<(2+(ctx.readGpr(fields.rt)&3));
    return {gprWrites:taken?[{register:31,value:ctx.linkAddress}]:[],control:{taken,target:(ctx.pc+4+displacement)>>>0}};
  }
};
export default instruction;
