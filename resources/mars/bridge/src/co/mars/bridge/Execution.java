package co.mars.bridge;

import java.util.*;
import static co.mars.bridge.Reflect.*;

/** A single continuous MARS simulation preserves P7 timer and IRQ pipeline state. */
final class Execution {
    final MarsBridge bridge;
    final Main.Options options;
    Object simulator;
    long instructions;
    int fetchedPC,previousPC;
    boolean fetched,halted;
    RuntimeException observerFailure;
    CourseDomain domain;
    Execution(MarsBridge bridge) { this.bridge=bridge; this.options=bridge.options; }
    void run() throws Exception {
        validateHalt();
        bridge.installCanonicalStatements();
        bridge.installCourseInstructionHoles();
        simulator=call(type("mars.simulator.Simulator"),"getInstance");
        if(options.course()) domain=new CourseDomain(bridge,new CourseDomain.Failure() {
            public void reject(String diagnostic) { rejectDomain(diagnostic); }
        });
        Observer memoryObserver=new Observer() { public void update(Observable source,Object notice) {
            try {
                int address=integer(call(notice,"getAddress"));
                int access=integer(call(notice,"getAccessType"));
                if(access==0 && bridge.text.containsKey(unsigned(address)) && address==integer(call(bridge.registers,"getProgramCounter"))) {
                    previousPC=fetchedPC; fetchedPC=address; fetched=true; instructions++;
                    if(domain!=null) domain.fetched(bridge.text.get(unsigned(address)));
                } else if(access==1 && options.course() && fetched && Integer.compareUnsigned(address,0x3000)<0) {
                    int aligned=address&~3;
                    int value=integer(call(bridge.memory,"getWordNoNotify",aligned));
                    System.out.printf("@%08x: *%08x <= %08x%n",fetchedPC,aligned,value);
                }
            } catch(Exception error) { observerFailure=new IllegalStateException("MARS memory observation failed",error); }
        }};
        Observer registerObserver=new Observer() { public void update(Observable source,Object notice) {
            try {
                if(!fetched) return;
                int access=integer(call(notice,"getAccessType"));
                if(domain!=null) domain.register(source,access);
                if(access!=1||observerFailure!=null) return;
                int number=integer(call(source,"getNumber"));
                if(number>0&&number<32) System.out.printf("@%08x: $%d <= %08x%n",fetchedPC,number,integer(call(source,"getValueNoNotify")));
            } catch(Exception error) { observerFailure=new IllegalStateException("MARS register observation failed",error); }
        }};
        Observer pcObserver=new Observer() { public void update(Observable source,Object notice) {
            try {
                if(options.halt==null||!fetched||integer(call(notice,"getAccessType"))!=1) return;
                int pc=integer(call(source,"getValueNoNotify"));
                boolean terminalInstruction=options.delayed ? previousPC==options.halt&&fetchedPC==options.halt+4 : fetchedPC==options.halt;
                if(pc==options.halt&&terminalInstruction) {
                    // Set only the worker stop flag. Simulator.stopExecution clears its
                    // worker field too early for its own synchronous simulate() caller.
                    Object worker=field(simulator,"simulatorThread");
                    call(worker,"setStop",new Object[]{null}); halted=true;
                }
            } catch(Exception error) { observerFailure=new IllegalStateException("MARS halt observation failed",error); }
        }};
        call(bridge.memory,"addObserver",memoryObserver);
        if(options.course()) call(bridge.registers,"addRegistersObserver",registerObserver);
        Object pcRegister=call(bridge.registers,"getProgramCounterRegister");
        call(pcRegister,"addObserver",pcObserver);
        if(domain!=null) domain.observeTimers();
        boolean done;
        try { done=(Boolean)call(bridge.program,"simulate",options.maxSteps); }
        finally {
            call(bridge.memory,"deleteObserver",memoryObserver);
            if(options.course()) call(bridge.registers,"deleteRegistersObserver",registerObserver);
            call(pcRegister,"deleteObserver",pcObserver);
            if(domain!=null) domain.close();
        }
        if(observerFailure!=null) throw observerFailure;
        bridge.result.put("instructions",instructions);
        bridge.result.put("exitCode",field(bridge.globals,"exitCode"));
        if(halted) bridge.result.put("stopReason","halt-loop");
        else if(!done) bridge.result.put("stopReason","step-limit");
        else if(options.course()) throw new IllegalStateException("Course program exited or fell off text before executing its validated halt loop");
        else bridge.result.put("stopReason","exited");
    }
    void rejectDomain(String diagnostic) {
        if(observerFailure!=null) return;
        observerFailure=new IllegalStateException(diagnostic);
        try { call(field(simulator,"simulatorThread"),"setStop",new Object[]{null}); }
        catch(Exception error) { observerFailure.addSuppressed(error); }
    }
    void validateHalt() {
        if(options.halt==null) {
            if(options.course()) throw new IllegalArgumentException("Course execution requires --halt-pc");
            return;
        }
        long address=unsigned(options.halt);
        Integer word=bridge.text.get(address),nop=bridge.text.get(address+4);
        // Accept the course canonical unconditional self branch (beq $0,$0,-1)
        // and a direct self jump. Other loops need real execution evidence and
        // must not become successful halts merely because their PC repeats.
        int jump=0x08000000|((options.halt>>>2)&0x03ffffff);
        if(word==null||(word!=0x1000ffff&&word!=jump)||nop==null||nop!=0)
            throw new IllegalArgumentException("Halt PC must identify an unconditional self branch followed by nop");
    }
}
