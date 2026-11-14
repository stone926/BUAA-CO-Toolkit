package co.mars.bridge;

import java.util.*;
import static co.mars.bridge.Reflect.*;

/** Rejects executions for which a course CPU has no deterministic MARS oracle. */
final class CourseDomain {
    interface Failure { void reject(String diagnostic); }
    final MarsBridge bridge;
    final Failure failure;
    final Object[] registers;
    boolean hiDefined,loDefined,custom;
    boolean timerUsed,timerActivated;
    int word;
    final List<Object> timers=new ArrayList<Object>();
    Observer timerObserver;
    CourseDomain(MarsBridge bridge,Failure failure) throws Exception {
        this.bridge=bridge;this.failure=failure;
        registers=(Object[])call(bridge.registers,"getRegisters");
    }
    void fetched(int word) throws Exception {
        this.word=word;custom=false;
        for(Object metadata:bridge.custom) {
            Map<?,?> instruction=(Map<?,?>)metadata;
            int mask=((Number)instruction.get("mask")).intValue(),value=((Number)instruction.get("value")).intValue();
            if((word&mask)==value) { custom=true;break; }
        }
        if(!custom&&bridge.options.delayed&&nativeControlTransfer(word)
            &&(Boolean)call(type("mars.simulator.DelayedBranch"),"isTriggered"))
            failure.reject("Course execution is outside the supported domain: a native control transfer was fetched in a branch delay slot");
        if(timerActivated&&integer(call(bridge.registers,"getProgramCounter"))==0x4180) {
            for(Object register:(Object[])call(type("mars.mips.hardware.Coprocessor0"),"getRegisters"))
                if(integer(call(register,"getNumber"))==13) {
                    int cause=integer(call(register,"getValueNoNotify"));
                    if((cause&0x7c)==0&&(cause&0xc00)!=0) markTimerTimingObserved();
                }
        }
    }
    void register(Object register,int access) throws Exception {
        String name=(String)call(register,"getName");
        if("hi".equalsIgnoreCase(name)||"lo".equalsIgnoreCase(name)) {
            boolean high="hi".equalsIgnoreCase(name);
            if(access==1) { if(high) hiDefined=true;else loDefined=true; }
            else if(access==0&&!(high?hiDefined:loDefined))
                failure.reject("Course execution is outside the supported domain: "+name.toUpperCase(Locale.ROOT)+" was read before an instruction defined it");
        }
        if(access!=0||custom) return;
        // A native instruction's actual operand read establishes that execution
        // reached its simulation code; a pending IRQ may have preempted a fetch.
        int opcode=word>>>26,funct=word&63;
        if(opcode==0&&(funct==26||funct==27)) {
            int dividend=value((word>>>21)&31),divisor=value((word>>>16)&31);
            if(divisor==0) failure.reject("Course execution is outside the supported domain: division by zero");
            else if(funct==26&&dividend==Integer.MIN_VALUE&&divisor==-1)
                failure.reject("Course execution is outside the supported domain: signed division overflow (MIN_INT / -1)");
        }
        if("P7".equals(bridge.options.profile)&&memoryOpcode(opcode)) {
            int address=value((word>>>21)&31)+(short)word;
            if(address>=0x7f00&&address<=0x7f1b) markTimerUsed();
            if(timerActivated&&(opcode>=0x20&&opcode<=0x26||opcode==0x30)
                &&(address==0x7f00||address==0x7f08||address==0x7f10||address==0x7f18)) markTimerTimingObserved();
        }
    }
    void observeTimers() throws Exception {
        if(!"P7".equals(bridge.options.profile)) return;
        timerObserver=new Observer() { public void update(Observable source,Object notice) {
            try {
                // MARS bypasses MemoryAccessNotice for timers. Observe actual
                // peripheral CTRL writes instead, covering native and custom
                // Memory APIs alike without inferring custom instruction logic.
                if(integer(call(notice,"getAccessType"))==1&&integer(call(source,"getNumber"))==0
                    &&(integer(call(source,"getValueNoNotify"))&1)!=0) {
                    markTimerUsed();timerActivated=true;bridge.result.put("timerActivated",true);
                }
                int number=integer(call(source,"getNumber"));
                boolean timingRead=timerActivated&&integer(call(notice,"getAccessType"))==0&&(number==0||number==2);
                if(custom&&(!timerUsed||timingRead)) for(StackTraceElement frame:Thread.currentThread().getStackTrace())
                    if("simulate".equals(frame.getMethodName())&&!"mars.simulator.Simulator".equals(frame.getClassName())) {
                        markTimerUsed();if(timingRead) markTimerTimingObserved();break;
                    }
            } catch(Exception error) { failure.reject("Configured MARS Timer access could not be observed reliably: "+error); }
        }};
        for(String name:Arrays.asList("mars.mips.hardware.TimerOne","mars.mips.hardware.TimerTwo")) {
            try {
                Class<?> timer=type(name);
                call(timer,"addRegistersObserver",timerObserver);timers.add(timer);
            } catch(Exception error) {
                close();throw new IllegalStateException("Configured MARS lacks observable P7 Timer registers; exact course oracle is unavailable",error);
            }
        }
    }
    void close() throws Exception { for(Object timer:timers) call(timer,"deleteRegistersObserver",timerObserver);timers.clear(); }
    int value(int register) throws Exception { return integer(call(registers[register],"getValueNoNotify")); }
    void markTimerUsed() { timerUsed=true;bridge.result.put("timerUsed",true); }
    void markTimerTimingObserved() { bridge.result.put("timerTimingObserved",true); }
    static boolean memoryOpcode(int opcode) { return opcode>=0x20&&opcode<=0x26||opcode>=0x28&&opcode<=0x2b||opcode==0x2e||opcode==0x30||opcode==0x31||opcode==0x35||opcode==0x38||opcode==0x39||opcode==0x3d; }
    static boolean nativeControlTransfer(int word) {
        int opcode=word>>>26,funct=word&63;
        return opcode==0&&(funct==8||funct==9)||opcode>=1&&opcode<=7
            ||opcode>=0x14&&opcode<=0x17||word==0x42000018;
    }
}
