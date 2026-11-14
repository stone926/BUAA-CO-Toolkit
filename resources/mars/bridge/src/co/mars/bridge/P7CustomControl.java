package co.mars.bridge;

import java.lang.reflect.*;
import static co.mars.bridge.Reflect.*;

/** Adapts legacy extension classes to the modded simulator's P7 BD/EPC protocol. */
final class P7CustomControl {
    static void attach(final MarsBridge bridge,Object instruction,final boolean control,final boolean unresolved) throws Exception {
        if(!"P7".equals(bridge.options.profile)) return;
        final Object delegate=call(instruction,"getSimulationCode");
        final Class<?> delayed=type("mars.simulator.DelayedBranch");
        Class<?> simulation=type("mars.mips.instructions.SimulationCode");
        Object proxy=Proxy.newProxyInstance(simulation.getClassLoader(),new Class<?>[]{simulation},new InvocationHandler() {
            public Object invoke(Object proxy,Method method,Object[] arguments) throws Throwable {
                if(!"simulate".equals(method.getName())) return invokeDelegate(method,arguments);
                int before=integer(call(bridge.registers,"getProgramCounter"));
                if(control&&(Boolean)call(delayed,"isTriggered")) {
                    bridge.execution.rejectDomain("Course execution is outside the supported domain: a custom control transfer executes in a branch delay slot");
                    return null;
                }
                // This hook runs inside SimulationCode, after hardware IRQ
                // preemption. Reachable branch intent includes untaken paths.
                if(control) call(delayed,"setTryjbranch");
                Object result=invokeDelegate(method,arguments);
                boolean registered=(Boolean)call(delayed,"isRegistered");
                int after=integer(call(bridge.registers,"getProgramCounter"));
                if(!control&&(registered||after!=before)) {
                    if(unresolved) bridge.execution.rejectDomain("Custom instruction changes control flow through unresolved reflective/dynamic calls; P7 delay-slot metadata is unavailable");
                    else if(registered) call(delayed,"setTryjbranch");
                }
                // A likely/annul branch that directly skips its slot must not
                // mark the instruction after the skipped slot as BD=1.
                if(control&&!registered&&after!=before) call(delayed,"tryClean");
                return result;
            }
            Object invokeDelegate(Method method,Object[] arguments) throws Throwable {
                try { return method.invoke(delegate,arguments); }
                catch(InvocationTargetException error) { throw error.getCause(); }
            }
        });
        field(instruction,"simulationCode",proxy);
    }
    private P7CustomControl() {}
}
