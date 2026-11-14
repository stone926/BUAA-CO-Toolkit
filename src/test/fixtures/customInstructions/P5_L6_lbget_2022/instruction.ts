// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "lbget",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "110101 rs:5 rt:5 immediate:16",
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
      "rs"
    ],
    "writes": [
      "dynamic"
    ],
    "memory": "load",
    "width": 1
  },
  "generation": {},
  "timing": {
    "hazardClass": "load",
    "reads": [
      {
        "field": "rs",
        "role": "rs",
        "useStage": "E"
      }
    ],
    "readyStage": "W"
  },
  execute(ctx, fields) {
    const address=(ctx.readGpr(fields.rs)+sx(fields.immediate))>>>0;
    const value=ctx.load(address,1,true);
    return {gprWrites:[{register:(value|0)>=0?fields.rt:fields.rs,value}]};
  }
};
export default instruction;
