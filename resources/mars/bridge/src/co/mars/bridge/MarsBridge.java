package co.mars.bridge;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import static co.mars.bridge.Reflect.*;
import static co.mars.bridge.Main.object;

/** MARS API adaptation, with no jar modification or bundled MARS implementation. */
final class MarsBridge {
    final Main.Options options;
    final Map<String,Object> result;
    Class<?> globals,registers,memoryType;
    Object settings,memory,program;
    Execution execution;
    final Map<Long,Integer> text=new TreeMap<Long,Integer>();
    final Set<Long> writtenData=new TreeSet<Long>();
    final Map<Long,String> textNames=new HashMap<Long,String>();
    final List<Object> sourceMap=new ArrayList<Object>();
    final List<Object> custom=new ArrayList<Object>();
    final List<Object> customObjects=new ArrayList<Object>();
    final Map<Object,Map<String,String>> sourceSections=new IdentityHashMap<Object,Map<String,String>>();
    MarsBridge(Main.Options options,Map<String,Object> result) { this.options=options; this.result=result; }
    void run() throws Exception {
        globals=type("mars.Globals"); registers=type("mars.mips.hardware.RegisterFile"); memoryType=type("mars.mips.hardware.Memory");
        call(globals,"initialize",false);
        settings=call(globals,"getSettings"); memory=field(globals,"memory");
        // Never persist settings to the user's MARS preferences.
        setting("DELAYED_BRANCHING_ENABLED",options.delayed,true);
        setting("START_AT_MAIN",false,true);
        setting("SELF_MODIFYING_CODE_ENABLED",false,true);
        setting("IGNORE_ARITHMETIC_OVERFLOW",options.course()&&!"P7".equals(options.profile),false);
        setting("EXCEPTION_FOR_COURSE","P7".equals(options.profile),"P7".equals(options.profile));
        stringSetting("OUTPUT_LOGGING_LEVEL","0");
        Object layout=call(type("mars.mips.hardware.MemoryConfigurations"),"getConfigurationByName",options.layout);
        if (layout==null) throw new IllegalStateException("Configured MARS does not support memory layout "+options.layout);
        call(type("mars.mips.hardware.MemoryConfigurations"),"setCurrentConfiguration",layout);
        call(memory,"clear");
        loadClasses();
        program=type("mars.MIPSprogram").getDeclaredConstructor().newInstance(); field(globals,"program",program);
        ArrayList<String> filenames=new ArrayList<String>(); filenames.add(new File(options.source).getCanonicalPath());
        Object programs=call(program,"prepareFilesForAssembly",filenames,filenames.get(0),null);
        Observer allocation=new Observer() { public void update(Observable o,Object notice) {
            try {
                if (integer(call(notice,"getAccessType")) != 1) return;
                int address=integer(call(notice,"getAddress")),length=integer(call(notice,"getLength"));
                if ((Boolean)call(memoryType,"inDataSegment",address)||(Boolean)call(memoryType,"inKernelDataSegment",address)) {
                    for (long a=unsigned(address)&~3L;a<unsigned(address)+length;a+=4) writtenData.add(a);
                }
            } catch(Exception e) { throw new IllegalStateException(e); }
        }};
        call(memory,"addObserver",allocation);
        Object assembler=type("mars.assembler.Assembler").getDeclaredConstructor().newInstance();
        Object machine=call(assembler,"assemble",programs,true,false);
        field(program,"machineList",machine);
        field(program,"backStepper",type("mars.simulator.BackStepper").getDeclaredConstructor().newInstance());
        call(memory,"deleteObserver",allocation);
        new DataReservations(this).collect((List<?>)programs,assembler);
        TreeMap<Long,Object> origins=new TreeMap<Long,Object>();
        Map<Long,String> originSections=new HashMap<Long,String>();
        for(Object sourceProgram:(List<?>)programs) for(Object original:(List<?>)call(sourceProgram,"getParsedList")) {
            long address=unsigned(integer(call(original,"getAddress")));
            origins.put(address,original);originSections.put(address,sectionFor(original));
        }
        for (Object statement:(List<?>)machine) {
            long address=unsigned(integer(call(statement,"getAddress")));
            if(text.put(address,integer(call(statement,"getBinaryStatement")))!=null)
                throw new IllegalStateException("MARS source allocates overlapping instructions at "+Long.toHexString(address));
            Map.Entry<Long,Object> originEntry=origins.floorEntry(address);
            if(originEntry==null) throw new IllegalStateException("MARS instruction has no source origin");
            Object origin=originEntry.getValue();
            String path=(String)call(origin,"getSourceFile"); int line=integer(call(origin,"getSourceLine"));
            Object tokens=call(origin,"getOriginalTokenList");
            if(tokens!=null&&integer(call(tokens,"size"))>0) {
                Object token=call(tokens,"get",0),original=call(token,"getOriginalProgram");
                if(original!=null) path=(String)call(original,"getFilename");
                line=integer(call(token,"getOriginalSourceLine"));
            }
            sourceMap.add(object("address",address,"path",path,"line",line));
            textNames.put(address,originSections.get(originEntry.getKey()));
        }
        List<Object> segments=image();
        result.put("segments",segments); result.put("sourceMap",sourceMap); result.put("customInstructions",custom);
        result.put("symbols",symbols((List<?>)programs));
        if (options.expected!=null) validateExpected(segments);
        if (!"assemble".equals(options.mode)) {
            if(options.course()) for(Long address:writtenData) {
                if(integer(call(memory,"getWordNoNotify",address.intValue()))!=0)
                    throw new IllegalStateException("Course CPU requires zero-initialized data memory; nonzero .data/.kdata cannot be loaded into the DUT");
            }
            reset();
            execution=new Execution(this);execution.run();
        }
    }
    void setting(String name,boolean value,boolean required) throws Exception {
        try { call(settings,"setBooleanSettingNonPersistent",integer(field(type("mars.Settings"),name)),value); }
        catch(NoSuchFieldException error) { if(required) throw new IllegalStateException("Configured MARS lacks required setting "+name); }
    }
    void stringSetting(String name,String value) throws Exception {
        try { call(settings,"setStringSettingNonPersistent",integer(field(type("mars.Settings"),name)),value); }
        catch(NoSuchFieldException ignored) { }
    }
    void loadClasses() throws Exception {
        if (options.classes.isEmpty()) { result.put("classSupport",supportsClasses()?"available":"unavailable"); result.put("classStatus","none"); return; }
        if (!supportsClasses()) throw new IllegalStateException("Configured MARS does not support custom instruction .class loading");
        Object set=field(globals,"instructionSet");
        List<?> instructions=(List<?>)call(set,"getInstructionList");
        for (String path:options.classes) {
            File file=new File(path);
            if (!file.isAbsolute()||!file.isFile()) throw new IllegalArgumentException("Instruction class does not exist: "+path);
            int before=instructions.size();
            try { call(type("mars.mips.instructions.LoadInstruction"),"loadClass",file.getCanonicalPath()); }
            catch(Exception error) { throw new IllegalStateException("Custom instruction class loading failed: "+path+" ("+error+")",error); }
            if (instructions.size()!=before+1) throw new IllegalStateException("MARS did not register custom instruction class "+path);
            Object instruction=instructions.get(before);
            customObjects.add(instruction);
            Object simulation=call(instruction,"getSimulationCode");
            ControlFlowIntent intent=new ControlFlowIntent(simulation.getClass());
            boolean control=intent.analyze();
            custom.add(object("mnemonic",call(instruction,"getName"),"mask",unsigned(integer(call(instruction,"getOpcodeMask"))),
                "value",unsigned(integer(call(instruction,"getOpcodeMatch"))),"template",call(instruction,"getExampleFormat"),
                "controlTransfer",control,"unresolvedDynamicCalls",intent.unresolvedDynamic));
            P7CustomControl.attach(this,instruction,control,intent.unresolvedDynamic);
        }
        configureCustomPrecedence(set,instructions);
        result.put("classSupport","available"); result.put("classStatus","loaded");
    }
    @SuppressWarnings({"rawtypes","unchecked"})
    void configureCustomPrecedence(Object set,List instructions) throws Exception {
        for(int i=0;i<custom.size();i++) for(int j=0;j<i;j++) {
            Map a=(Map)custom.get(i),b=(Map)custom.get(j);
            int am=((Number)a.get("mask")).intValue(),bm=((Number)b.get("mask")).intValue();
            int av=((Number)a.get("value")).intValue(),bv=((Number)b.get("value")).intValue();
            if(((av^bv)&(am&bm))==0) throw new IllegalStateException("Ambiguous overlapping custom instruction encodings: "+a.get("mnemonic")+" and "+b.get("mnemonic"));
        }
        instructions.removeAll(customObjects);instructions.addAll(0,customObjects);
        call(set,"initialize");
        // The MARS name matcher selects first, but initialize() overwrites equal
        // binary patterns with last. Give both entry points explicit precedence.
        Map<Integer,HashMap<Integer,Object>> groups=new LinkedHashMap<Integer,HashMap<Integer,Object>>();
        for(Object instruction:customObjects) {
            int mask=integer(call(instruction,"getOpcodeMask")),value=integer(call(instruction,"getOpcodeMatch"));
            HashMap<Integer,Object> matches=groups.get(mask);
            if(matches==null) { matches=new HashMap<Integer,Object>();groups.put(mask,matches); }
            matches.put(value,instruction);
        }
        java.lang.reflect.Constructor<?> constructor=type("mars.mips.instructions.InstructionSet$MatchMap").getDeclaredConstructor(int.class,HashMap.class);
        constructor.setAccessible(true);
        ArrayList<Object> maps=new ArrayList<Object>();
        for(Map.Entry<Integer,HashMap<Integer,Object>> entry:groups.entrySet()) maps.add(constructor.newInstance(entry.getKey(),entry.getValue()));
        maps.addAll((List)field(set,"opcodeMatchMaps"));field(set,"opcodeMatchMaps",maps);
        for(Object instruction:customObjects) if(call(set,"findByBinaryCode",integer(call(instruction,"getOpcodeMatch")))!=instruction)
            throw new IllegalStateException("Configured MARS custom instruction binary precedence could not be established");
    }
    boolean supportsClasses() { try { type("mars.mips.instructions.LoadInstruction").getMethod("loadClass",String.class); return true; } catch(Exception ignored) { return false; } }
    String sectionFor(Object statement) throws Exception {
        Object source=call(statement,"getSourceMIPSprogram");
        Object tokens=call(statement,"getOriginalTokenList");
        if(tokens!=null&&integer(call(tokens,"size"))>0) {
            Object token=call(tokens,"get",0);
            Map<String,String> sections=sourceSections.get(source);
            if(sections!=null) {
                String section=sections.get(integer(call(statement,"getSourceLine"))+":"+integer(call(token,"getSourceLine")));
                if(section!=null) return section;
            }
        }
        throw new IllegalStateException("MARS source section metadata could not be projected reliably");
    }
    List<Object> image() throws Exception {
        List<Object> segments=new ArrayList<Object>();
        appendInstructionRuns(segments);
        Map<Long,Integer> data=new TreeMap<Long,Integer>(); Map<Long,String> names=new HashMap<Long,String>();
        for(Long address:writtenData) {
            data.put(address,integer(call(memory,"getWordNoNotify",address.intValue())));
            names.put(address,(Boolean)call(memoryType,"inKernelDataSegment",address.intValue())?"kdata":"data");
        }
        appendDense(segments,data,names);
        return segments;
    }
    void appendInstructionRuns(List<Object> segments) {
        Set<String> emitted=new HashSet<String>();
        long previous=-8;String previousName=null;List<Object> words=null;
        for(Map.Entry<Long,Integer> entry:text.entrySet()) {
            String name=textNames.get(entry.getKey());
            if(entry.getKey()!=previous+4||!name.equals(previousName)) {
                String unique=emitted.add(name)?name:name+"@"+String.format("%08x",entry.getKey());
                words=new ArrayList<Object>();segments.add(object("name",unique,"baseAddress",entry.getKey(),"words",words));
            }
            words.add(unsigned(entry.getValue()));previous=entry.getKey();previousName=name;
        }
    }
    void appendDense(List<Object> segments,Map<Long,Integer> values,Map<Long,String> names) throws Exception {
        Map<String,SortedMap<Long,Integer>> groups=new LinkedHashMap<String,SortedMap<Long,Integer>>();
        for(Map.Entry<Long,Integer> entry:values.entrySet()) {
            String name=names.get(entry.getKey());
            SortedMap<Long,Integer> group=groups.get(name);
            if(group==null) { group=new TreeMap<Long,Integer>();groups.put(name,group); }
            group.put(entry.getKey(),entry.getValue());
        }
        List<long[]> ranges=new ArrayList<long[]>();
        for(Map.Entry<String,SortedMap<Long,Integer>> entry:groups.entrySet()) {
            SortedMap<Long,Integer> group=entry.getValue();
            long start=group.firstKey(),end=group.lastKey()+4;
            if(end-start>4*1024*1024) throw new IllegalStateException("MARS normalized "+entry.getKey()+" interval exceeds 4 MiB");
            for(long[] range:ranges) if(start<range[1]&&end>range[0])
                throw new IllegalStateException("MARS normalized segment intervals overlap; split text and kernel text into disjoint address ranges");
            ranges.add(new long[]{start,end});
        }
        for(Map.Entry<String,SortedMap<Long,Integer>> entry:groups.entrySet()) {
            SortedMap<Long,Integer> group=entry.getValue();
            long start=group.firstKey(),end=group.lastKey()+4;
            List<Object> words=new ArrayList<Object>();
            for(long address=start;address<end;address+=4) {
                Integer word=group.get(address);
                if(word==null) word=0;
                words.add(unsigned(word));
            }
            segments.add(object("name",entry.getKey(),"baseAddress",start,"words",words));
        }
    }
    void installCourseInstructionHoles() throws Exception {
        if(!options.course()||text.isEmpty()) return;
        long end=((TreeMap<Long,Integer>)text).lastKey()+4;
        if(end<0x3000||end-0x3000>4*1024*1024) throw new IllegalStateException("Course instruction interval exceeds 4 MiB");
        for(long address=0x3000;address<end;address+=4) if(!text.containsKey(address)) {
            Object statement=type("mars.ProgramStatement").getConstructor(int.class,int.class).newInstance(0,(int)address);
            call(memory,"setStatement",(int)address,statement);
            text.put(address,0);
        }
    }
    void installCanonicalStatements() throws Exception {
        // Source objects are for diagnostics only. A DUT consumes words, so a
        // word must select identical simulation code regardless of source alias.
        for(Map.Entry<Long,Integer> entry:text.entrySet()) {
            Object statement=type("mars.ProgramStatement").getConstructor(int.class,int.class).newInstance(entry.getValue(),entry.getKey().intValue());
            call(memory,"setStatement",entry.getKey().intValue(),statement);
        }
    }
    List<Object> symbols(List<?> programs) throws Exception {
        Map<String,Object> result=new LinkedHashMap<String,Object>(); List<Object> tables=new ArrayList<Object>(); tables.add(field(globals,"symbolTable"));
        for(Object p:programs) tables.add(call(p,"getLocalSymbolTable"));
        for(Object table:tables) for(Object symbol:(List<?>)call(table,"getAllSymbols")) {
            String name=(String)call(symbol,"getName"); int address=integer(call(symbol,"getAddress")); boolean data=(Boolean)call(symbol,"getType");
            String segment=data?((Boolean)call(memoryType,"inKernelDataSegment",address)?"kdata":"data"):textNames.get(unsigned(address));
            result.put(name,object("name",name,"value",unsigned(address),"kind",data?"data":"text","segment",segment));
        }
        return new ArrayList<Object>(result.values());
    }
    void validateExpected(List<Object> actual) throws Exception {
        Object parsed=Json.decode(new String(Files.readAllBytes(Paths.get(options.expected)),StandardCharsets.UTF_8));
        if(!(parsed instanceof Map)||!((Map<?,?>)parsed).containsKey("segments")) throw new IllegalArgumentException("Expected image must contain segments");
        Map<String,Long> actualWords=flatten(actual),expectedWords=flatten((List<?>)((Map<?,?>)parsed).get("segments"));
        if(!canonicalWords(actualWords).equals(canonicalWords(expectedWords))||!instructionBounds(actualWords).equals(instructionBounds(expectedWords)))
            throw new IllegalStateException("Reassembled MARS image differs from authoritative expected image");
    }
    Map<String,Long> flatten(List<?> segments) {
        Map<String,Long> words=new TreeMap<String,Long>();
        for(Object item:segments) { Map<?,?> s=(Map<?,?>)item; long base=((Number)s.get("baseAddress")).longValue();
            String name=String.valueOf(s.get("name"));
            if(name.matches("(?:text|ktext)(?:@[0-9a-fA-F]{8})?")) name="im";
            for(Object word:(List<?>)s.get("words")) { String key=name+":"+base;
                if(words.put(key,((Number)word).longValue())!=null) throw new IllegalArgumentException("Overlapping image segment"); base+=4;
            }
        }
        return words;
    }
    Map<String,Long> canonicalWords(Map<String,Long> words) {
        Map<String,Long> result=new TreeMap<String,Long>(words);
        for(Map.Entry<String,Long> entry:words.entrySet()) if(entry.getKey().startsWith("im:")&&entry.getValue()==0) result.remove(entry.getKey());
        return result;
    }
    List<Long> instructionBounds(Map<String,Long> words) {
        long min=Long.MAX_VALUE,max=-1;
        for(String key:words.keySet()) if(key.startsWith("im:")) { long address=Long.parseLong(key.substring(3));min=Math.min(min,address);max=Math.max(max,address); }
        return Arrays.asList(min,max);
    }
    void reset() throws Exception {
        call(registers,"resetRegisters"); call(type("mars.mips.hardware.Coprocessor0"),"resetRegisters");
        call(type("mars.mips.hardware.Coprocessor1"),"resetRegisters");
        call(type("mars.simulator.DelayedBranch"),"clear");
        if(options.course()) {
            for(Long address:writtenData) if(address>=0x3000)
                throw new IllegalStateException("Course initial data allocation must be inside zero-initialized DM (0x0000..0x2fff)");
            for(Object register:(Object[])call(registers,"getRegisters")) call(register,"setValueNoNotify",0);
            for(Object register:(Object[])call(type("mars.mips.hardware.Coprocessor0"),"getRegisters")) call(register,"setValueNoNotify",0);
            call(registers,"initializeProgramCounter",0x3000);
            if(!text.containsKey(0x3000L)) throw new IllegalStateException("Course image has no instruction at reset PC 0x3000");
        }
        if("P7".equals(options.profile)) {
            call(type("mars.mips.hardware.TimerOne"),"resetRegisters");
            call(type("mars.mips.hardware.TimerTwo"),"resetRegisters");
            field(globals,"HWInt",0);
            if(integer(field(memoryType,"exceptionHandlerAddress"))!=0x4180) throw new IllegalStateException("P7 exception vector is not 0x4180");
            if(!options.interrupts.isEmpty()) {
                try { call(settings,"setP7IrqPcList",options.interrupts); }
                catch(NoSuchMethodException error) { throw new IllegalStateException("Configured MARS lacks P7 interrupt schedule support"); }
            }
        }
    }
}
