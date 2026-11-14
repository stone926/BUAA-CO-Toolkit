import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MipsRuntimeManager } from '../../mips/host/runtimeManager';
import { validateScriptInstructionBundle } from '../../mips/host/scriptInstructionBundle';
import { runProcessCore } from '../../processCore';
import type { CourseProfile } from '../../mips/core/generated/isaCatalog';
import type { ProgramImage } from '../../mips/core/api';

interface Exercise { exercise:string; mnemonic:string; profile:CourseProfile; class:string|null }
interface Vector { name:string; rs:number; rt:number; memory?:number; immediate?:number; destinationValue?:number; expectedMemory?:number }
const fixtureRoot=path.resolve('src/test/fixtures/customInstructions');
const exercises=JSON.parse(readFileSync(path.join(fixtureRoot,'index.json'),'utf8')) as Exercise[];
const jar=process.env.CO_MARS_JAR;
const originals=process.env.CO_CUSTOM_INSTRUCTION_FIXTURES;
let directory:string,workerPath:string;
beforeAll(async()=>{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'co-ts-exercises-'));
  workerPath=path.join(directory,'worker.cjs');
  const built=await build({entryPoints:[path.resolve('src/mips/host/scriptInstructionWorker.ts')],outfile:workerPath,bundle:true,platform:'node',format:'cjs',logLevel:'silent',write:false,
    // The production script entry lives directly in out/. Preserve that resource
    // anchor while keeping test bundles out of concurrent clean/compile output.
    define:{__dirname:JSON.stringify(path.resolve('out'))}});
  await fs.writeFile(workerPath,built.outputFiles![0].contents);
});
afterAll(async()=>{
  if(directory&&path.dirname(directory)===path.resolve(os.tmpdir())&&path.basename(directory).startsWith('co-ts-exercises-')) await fs.rm(directory,{recursive:true,force:true});
});
function initialize(register:number,value:number):string {
  return `lui $${register},${value>>>16}\nori $${register},$${register},${value&65535}\n`;
}
function program(exercise:Exercise,vector:Vector):string {
  const mnemonic=exercise.mnemonic,rawImmediate=vector.immediate??1;
  const imm=mnemonic==='addei'&&rawImmediate>=32768?rawImmediate-65536:rawImmediate;
  let instruction:string;
  if(['lsh','lwrr','lboez','sbsam','sb','lhogez','lbget','lwer'].includes(mnemonic)) instruction=`${mnemonic} $3,${imm}($1)`;
  else if(['bomez','bao','bonall'].includes(mnemonic)) instruction=`${mnemonic} $1,$2,target`;
  else if(mnemonic==='bnezalc') instruction='bnezalc $1,target';
  else if(mnemonic==='blztal') instruction='blztal $1,$2,1';
  else if(['pcadd','tftc'].includes(mnemonic)) instruction=`${mnemonic} $3,$1`;
  else if(['rlb','ras','addei'].includes(mnemonic)) instruction=`${mnemonic} $3,$1,${imm}`;
  else instruction=`${mnemonic} $3,$1,$2`;
  return '.text 0x3000\n'+initialize(23,vector.memory??0)+`sw $23,0($0)\n`+initialize(1,vector.rs)+initialize(2,vector.rt)+initialize(3,vector.destinationValue??0x12345678)+initialize(31,0x77777777)
    +`${instruction}\nori $20,$0,0x101\nori $21,$0,0x202\ntarget: ori $22,$0,0x303\n`
    +Array.from({length:12},()=> 'nop').join('\n')+'\nhalt: beq $0,$0,halt\nnop\n';
}
function canonicalTrace(text:string):string[] {
  return text.split(/\r?\n/).map(line=>line.trim().toLowerCase()).filter(line=>/^@[\da-f]{8}:/.test(line));
}
async function reference(exercise:Exercise,source:string,resultFile:string,haltPc:number) {
  const args=['-Dfile.encoding=UTF-8','-Djava.awt.headless=true','-cp',[path.resolve('resources/mars/bridge/mars-bridge.jar'),jar!,exercise.class?path.dirname(path.join(originals!,exercise.class)):directory].join(path.delimiter),
    'co.mars.bridge.Main','--mode','execute','--source',source,'--profile',exercise.profile,'--layout','CompactLargeText','--delayed',String(['P5','P6','P7'].includes(exercise.profile)),
    '--max-steps','200','--halt-pc',String(haltPc),'--result',resultFile];
  if(exercise.class) args.push('--class',path.join(originals!,exercise.class));
  const processResult=await runProcessCore('java',args,{cwd:path.dirname(source),timeoutMs:15000,maxStdoutBytes:1024*1024,maxStderrBytes:1024*1024});
  expect(processResult.exitCode,processResult.stderr).toBe(0);
  const result=JSON.parse(await fs.readFile(resultFile,'utf8')) as {ok:boolean;diagnostic?:string;segments:ProgramImage['segments']};
  expect(result.ok,result.diagnostic).toBe(true);
  return {...result,trace:canonicalTrace(processResult.stdout)};
}

describe('all 23 independent course instruction exercise translations',()=>{
  it('includes every source exercise, retaining repeated mnemonics in independent registries',()=>{
    expect(exercises).toHaveLength(23);
    expect(exercises.filter(exercise=>exercise.class)).toHaveLength(21);
    expect(new Set(exercises.map(exercise=>exercise.exercise)).size).toBe(23);
  });
  it.each(exercises)('$exercise assembles and executes all boundary vectors through a frozen TS worker',async exercise=>{
    const root=path.join(directory,exercise.exercise);
    await fs.mkdir(path.join(root,'.co/custom-instructions'),{recursive:true});
    await fs.copyFile(path.join(fixtureRoot,exercise.exercise,'instruction.ts'),path.join(root,'.co/custom-instructions/instruction.ts'));
    const vectors=JSON.parse(await fs.readFile(path.join(fixtureRoot,exercise.exercise,'vectors.json'),'utf8')) as Vector[];
    const runtime=new MipsRuntimeManager({scriptWorkerPath:workerPath});
    try {
      const capture=await runtime.runIsolatedJob({kind:'script-capture',payload:{workspaceRoot:root}});
      expect(capture,JSON.stringify(capture)).toMatchObject({ok:true});
      if(capture.kind!=='result')throw new Error('Expected snapshot');
      const bundle=validateScriptInstructionBundle(capture.payload);
      let knownClassBugDifferences=0;
      for(const vector of vectors) {
        const text=program(exercise,vector),source=path.join(root,`${vector.name}.asm`);
        await fs.writeFile(source,text,'utf8');
        const assembly=await runtime.runScriptJob(bundle,{kind:'assembler-assemble',payload:{profile:exercise.profile,sources:[{id:'main',text}]}});
        expect(assembly,`${exercise.exercise}/${vector.name}: ${JSON.stringify(assembly)}`).toMatchObject({ok:true,payload:{ok:true}});
        if(assembly.kind!=='result')throw new Error('Expected assembly');
        const image=(assembly.payload as {image:ProgramImage}).image;
        const haltPc=image.symbols.find(symbol=>symbol.name==='halt')!.value!;
        const execution=await runtime.runScriptJob(bundle,{kind:'machine-execute',payload:{profile:exercise.profile,enabledLayers:['required'],entryPc:'0x00003000',maxSteps:200,haltPc:`0x${haltPc.toString(16).padStart(8,'0')}`,collectTrace:true,
          segments:image.segments.filter(segment=>segment.words.length).map(segment=>({name:segment.name,baseAddress:`0x${segment.baseAddress.toString(16).padStart(8,'0')}`,words:segment.words.map(word=>`0x${word.toString(16).padStart(8,'0')}`)}))}});
        expect(execution,`${exercise.exercise}/${vector.name}`).toMatchObject({ok:true,payload:{status:'halted'}});
        if(execution.kind!=='result')throw new Error('Expected execution');
        const payload=execution.payload as {trace:string[];finalState:{gpr:string[];dataWords:{address:string;value:string}[]}};
        expect(payload.trace.length).toBeGreaterThan(5);
        if(vector.expectedMemory!==undefined) expect(payload.finalState.dataWords).toContainEqual({address:'0x00000000',value:`0x${vector.expectedMemory.toString(16).padStart(8,'0')}`});
        if(exercise.mnemonic==='sb'&&vector.name==='byte-1') expect(payload.finalState.dataWords).toContainEqual({address:'0x00000000',value:'0x80f07855'});
        if(exercise.mnemonic==='sb'&&vector.name==='documented-full-word') expect(payload.finalState.dataWords).toContainEqual({address:'0x00000000',value:'0x1234ff78'});
        if(exercise.mnemonic==='lwer') {
          const memory=vector.memory!,destination=(memory+(vector.destinationValue??0x12345678))&0x1e;
          expect(payload.finalState.gpr[destination]).toBe(`0x${(destination===0?0:memory).toString(16).padStart(8,'0')}`);
        }
        if(jar&&originals&&(exercise.class||exercise.mnemonic==='sb')) {
          const original=await reference(exercise,source,path.join(root,`${vector.name}.json`),haltPc);
          expect(original.segments.filter(segment=>segment.words.length).map(segment=>({baseAddress:segment.baseAddress,words:segment.words})),`${exercise.exercise}/${vector.name} exact image`).toEqual(image.segments.filter(segment=>segment.words.length).map(segment=>({baseAddress:segment.baseAddress,words:segment.words})));
          const actual=payload.trace.map(line=>line.toLowerCase());
          if(exercise.mnemonic==='bomez'&&['positive','reverse','opposites','signed-overflow'].includes(vector.name)) {
            // Both years ship the identical class; the 2022 source flags its rt % rs bug.
            expect(original.trace,`documented known-bad class vector ${vector.name}`).not.toEqual(actual);knownClassBugDifferences++;
          } else expect(original.trace,`${exercise.exercise}/${vector.name} canonical trace`).toEqual(actual);
        }
      }
      if(jar&&originals&&exercise.mnemonic==='bomez')expect(knownClassBugDifferences).toBe(4);
    } finally {runtime.dispose();}
  });
});
