// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "lsh",
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
      "rt"
    ],
    "memory": "load",
    "width": 4
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
    const address=(ctx.readGpr(fields.rs)^(fields.immediate&0xffff))>>>0;
    const word=ctx.load(address&0xfffffffc,4);
    const half=(word>>>((address&2)*8))&0xffff;
    return {gprWrites:[{register:fields.rt,value:(address&1)?sx(half):half}]};
  }
};
export default instruction;
