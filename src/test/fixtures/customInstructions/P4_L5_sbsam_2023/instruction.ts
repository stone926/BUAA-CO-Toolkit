// Course exercise translation; provenance and known historical differences: ../README.md.
import type { CustomInstructionDefinition } from '@buaa-co/instructions';

function sx(value: number, width = 16): number { return (value << (32-width)) >> (32-width); }
function ones(value: number): number { let bits = value >>> 0, count = 0; while (bits) { bits &= bits-1; count++; } return count; }

const instruction: CustomInstructionDefinition = {
  "apiVersion": 1,
  "mnemonic": "sbsam",
  "modes": [
    "mars",
    "P3",
    "P4",
    "P5",
    "P6",
    "P7"
  ],
  "override": true,
  "encoding": "111110 rs:5 rt:5 immediate:16",
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
    const base=ctx.readGpr(fields.rs),data=ctx.readGpr(fields.rt),imm=sx(fields.immediate);
    const address=(base+imm)>>>0,shift=base&31,end=(base>>>27)&31,start=(imm>>>11)&31;
    const rotated=shift?((data<<shift)|(data>>>(32-shift)))>>>0:data;
    const mask=end>=start?(((1<<(end-start))-1)<<start):~(((1<<(start-end))-1)<<end);
    return {store:{address,width:1,value:((rotated&mask)>>>((address&3)*8))&255}};
  }
};
export default instruction;
