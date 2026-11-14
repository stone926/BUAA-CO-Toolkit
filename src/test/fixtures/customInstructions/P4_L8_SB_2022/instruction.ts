// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "sb",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "101000 rs:5 rt:5 immediate:16",
  "operands": [
    {
      "kind": "register",
      "field": "rt"
    },
    {
      "kind": "memory",
      "baseField": "rs",
      "offsetField": "immediate",
      "signed": true
    }
  ],
  "access": {
    "reads": [
      "rs",
      "rt"
    ],
    "writes": [],
    "memory": "store",
    "width": 1
  },
  "generation": {},
  "timing": {
    "hazardClass": "store",
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
    return {store:{address:(ctx.readGpr(fields.rs)+sx(fields.immediate))>>>0,width:1,value:ctx.readGpr(fields.rt)&255}};
  }
};
export default instruction;
