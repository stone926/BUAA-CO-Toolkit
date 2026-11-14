package co.mars.bridge;

import java.util.*;
import static co.mars.bridge.Reflect.*;

/**
 * Projects allocation addresses from MARS-validated tokens. MARS deliberately
 * does not write .space/.extern bytes to memory, so observing memory alone
 * loses these zero-filled reservations. Parsing, macro substitution, numeric
 * decoding and directive sizes remain owned by MARS.
 */
final class DataReservations {
    final MarsBridge bridge;
    final int[] address;
    boolean data,align,macroDefinition;
    int space;
    String directive;
    long macroCounter;
    String instructionSection="text";
    DataReservations(MarsBridge bridge) throws Exception {
        this.bridge=bridge;
        address=new int[]{integer(field(bridge.memoryType,"dataBaseAddress")),integer(field(bridge.memoryType,"kernelDataBaseAddress"))};
    }
    void collect(List<?> programs,Object assembler) throws Exception {
        for(Object program:programs) {
            data=false;align=true;macroDefinition=false;directive=".word";
            for(Object tokens:(List<?>)call(program,"getTokenList")) process(program,tokens,0,-1);
        }
        int[] actual=(int[])field(field(assembler,"dataAddress"),"address");
        if(!Arrays.equals(address,actual)) throw new IllegalStateException("MARS data allocation metadata could not be projected reliably");
        long externalBase=unsigned(integer(field(bridge.memoryType,"externBaseAddress")));
        long externalEnd=unsigned(integer(field(assembler,"externAddress")));
        reserve(externalBase,externalEnd-externalBase);
    }
    void process(Object program,Object tokenList,int depth,int invocationLine) throws Exception {
        if(depth>128) throw new IllegalStateException("MARS macro allocation recursion limit exceeded");
        List<Object> tokens=new ArrayList<Object>();
        for(Object token:(List<?>)field(tokenList,"tokenList")) {
            String kind=String.valueOf(call(token,"getType"));
            if("COMMENT".equals(kind)) break;
            if(!"DELIMITER".equals(kind)) tokens.add(token);
        }
        while(tokens.size()>1&&":".equals(value(tokens.get(1)))) { tokens.remove(0);tokens.remove(0); }
        if(tokens.isEmpty()) return;
        if(invocationLine<0) invocationLine=integer(call(tokens.get(0),"getOriginalSourceLine"));
        String first=value(tokens.get(0));
        if(".macro".equals(first)) { macroDefinition=true;return; }
        if(".end_macro".equals(first)) { macroDefinition=false;return; }
        if(macroDefinition) return;
        if(!first.startsWith(".")) {
            // Use MARS' own macro matcher, substitution and tokenizer, including
            // argument lists and macros that allocate data or invoke macros.
            Object invocation=type("mars.assembler.TokenList").getDeclaredConstructor().newInstance();
            for(int i=0;i<tokens.size();i++) {
                String value=value(tokens.get(i));
                if(i==1&&"(".equals(value)) continue;
                if(i==tokens.size()-1&&")".equals(value)) continue;
                call(invocation,"add",tokens.get(i));
            }
            Object macro=call(call(program,"getLocalMacroPool"),"getMatchingMacro",invocation,integer(call(tokens.get(0),"getOriginalSourceLine")));
            if(macro!=null) {
                long counter=macroCounter++;
                Object errors=type("mars.ErrorList").getDeclaredConstructor().newInstance();
                for(int line=integer(call(macro,"getFromLine"))+1;line<integer(call(macro,"getToLine"));line++) {
                    String substituted=(String)call(macro,"getSubstitutedLine",line,invocation,counter,errors);
                    Object expanded=call(call(program,"getTokenizer"),"tokenizeLine",line,substituted,errors);
                    process(program,expanded,depth+1,invocationLine);
                }
                return;
            }
        }
        if(".data".equals(first)||".kdata".equals(first)) {
            data=true;align=true;space=".data".equals(first)?0:1;
            if(tokens.size()>1) address[space]=number(value(tokens.get(1)));
            return;
        }
        if(".text".equals(first)||".ktext".equals(first)) { data=false;instructionSection=".text".equals(first)?"text":"ktext";return; }
        if(!data) {
            if(!first.startsWith(".")) {
                Map<String,String> sections=bridge.sourceSections.get(program);
                if(sections==null) { sections=new HashMap<String,String>();bridge.sourceSections.put(program,sections); }
                sections.put(invocationLine+":"+integer(call(tokens.get(0),"getSourceLine")),instructionSection);
            }
            return;
        }
        if(".space".equals(first)) {
            int length=number(value(tokens.get(1)));
            reserve(unsigned(address[space]),length);address[space]+=length;return;
        }
        if(".align".equals(first)) {
            int boundary=number(value(tokens.get(1)));
            if(boundary==0) align=false;
            else address[space]=aligned(address[space],1L<<boundary);
            return;
        }
        boolean explicit=Arrays.asList(".word",".half",".byte",".float",".double",".ascii",".asciiz").contains(first);
        if(first.startsWith(".")&&!explicit) return;
        if(explicit) directive=first;
        int start=explicit?1:0;
        if(".ascii".equals(directive)||".asciiz".equals(directive)) {
            for(int i=start;i<tokens.size();i++) {
                String quoted=value(tokens.get(i));int count=0;
                for(int c=1;c<quoted.length()-1;c++) { if(quoted.charAt(c)=='\\') c++;count++; }
                int length=count+(".asciiz".equals(directive)?1:0);
                reserve(unsigned(address[space]),length);address[space]+=length;
            }
            return;
        }
        Object marsDirective=call(type("mars.assembler.Directives"),"matchDirective",directive);
        int size=integer(call(type("mars.assembler.DataTypes"),"getLengthInBytes",marsDirective));
        int count=tokens.size()-start;
        if(count==3&&":".equals(value(tokens.get(start+1)))) count=number(value(tokens.get(start+2)));
        if(count>0) {
            if(align) address[space]=aligned(address[space],size);
            reserve(unsigned(address[space]),(long)size*count);
            address[space]+=size*count;
        }
    }
    void reserve(long start,long length) {
        if(length<0||length>4*1024*1024||start+length>0x100000000L) throw new IllegalStateException("MARS data reservation exceeds bridge bounds");
        if(length==0) return;
        for(long a=start&~3L;a<start+length;a+=4) bridge.writtenData.add(a);
    }
    static int aligned(int address,long alignment) { return (int)((unsigned(address)+alignment-1)&-alignment); }
    static String value(Object token) throws Exception { return (String)call(token,"getValue"); }
    static int number(String value) throws Exception { return integer(call(type("mars.util.Binary"),"stringToInt",value)); }
}
