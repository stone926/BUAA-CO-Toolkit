package co.mars.bridge;

import java.io.*;
import java.util.*;
import org.objectweb.asm.*;

/** Bounded, reachable bytecode call graph; no mnemonic or class-name heuristics. */
final class ControlFlowIntent {
    final ClassLoader loader;
    final String root;
    final Map<String,ClassInfo> classes=new HashMap<String,ClassInfo>();
    final Set<String> visited=new HashSet<String>();
    boolean unresolvedDynamic;
    int classBytes,parsedMethods;
    ControlFlowIntent(Class<?> simulationClass) { loader=simulationClass.getClassLoader();root=simulationClass.getName().replace('.','/'); }
    boolean analyze() throws IOException { return reachesControl(new Call(root,"simulate","(Lmars/ProgramStatement;)V",Opcodes.INVOKEVIRTUAL)); }
    boolean reachesControl(Call call) throws IOException {
        if(sink(call.owner,call.name)) return true;
        if(external(call.owner)) return false;
        String owner=call.owner;
        if(call.opcode==Opcodes.INVOKEVIRTUAL||call.opcode==Opcodes.INVOKEINTERFACE) {
            try {
                Class<?> declared=Class.forName(owner.replace('/','.'),false,loader),actual=Class.forName(root.replace('/','.'),false,loader);
                if(declared.isAssignableFrom(actual)) owner=root;
            } catch(ClassNotFoundException ignored) { }
        }
        MethodInfo method=null;String resolved=owner;
        while(resolved!=null&&!external(resolved)) {
            ClassInfo info=read(resolved);
            if(info==null) { unresolvedDynamic=true;return false; }
            method=info.methods.get(call.name+call.descriptor);
            if(method!=null) break;
            resolved=info.parent;
            if(resolved!=null&&sink(resolved,call.name)) return true;
        }
        if(method==null) return false;
        if(!visited.add(resolved+"#"+call.name+call.descriptor)) return false;
        if(visited.size()>2048) throw new IOException("Custom instruction call graph exceeds 2048 methods");
        if(method.dynamic) unresolvedDynamic=true;
        for(Call next:method.calls) if(reachesControl(next)) return true;
        return false;
    }
    static boolean sink(String owner,String name) {
        return "mars/simulator/DelayedBranch".equals(owner)&&"register".equals(name)
            ||"mars/mips/instructions/BranchOperation".equals(owner)&&("processBranch".equals(name)||"processJump".equals(name))
            ||"mars/mips/hardware/RegisterFile".equals(owner)&&("setProgramCounter".equals(name)||"initializeProgramCounter".equals(name)||"incrementPC".equals(name));
    }
    static boolean external(String owner) {
        return owner.startsWith("java/")||owner.startsWith("javax/")||owner.startsWith("sun/")||owner.startsWith("jdk/")
            ||owner.startsWith("org/objectweb/asm/")||owner.startsWith("mars/");
    }
    ClassInfo read(String owner) throws IOException {
        if(classes.containsKey(owner)) return classes.get(owner);
        if(classes.size()>=128) throw new IOException("Custom instruction call graph exceeds 128 classes");
        InputStream input=loader==null?ClassLoader.getSystemResourceAsStream(owner+".class"):loader.getResourceAsStream(owner+".class");
        if(input==null) { classes.put(owner,null);return null; }
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        try {
            byte[] buffer=new byte[8192];int length;
            while((length=input.read(buffer))!=-1) {
                if(bytes.size()+length>4*1024*1024) throw new IOException("Custom instruction class exceeds 4 MiB");
                if(classBytes+bytes.size()+length>16*1024*1024) throw new IOException("Custom instruction call graph exceeds 16 MiB of class data");
                bytes.write(buffer,0,length);
            }
        } finally { input.close(); }
        classBytes+=bytes.size();
        final ClassInfo info=new ClassInfo();classes.put(owner,info);
        try {
            new ClassReader(bytes.toByteArray()).accept(new ClassVisitor(Opcodes.ASM9) {
                @Override public void visit(int version,int access,String name,String signature,String parent,String[] interfaces) { info.parent=parent; }
                @Override public MethodVisitor visitMethod(int access,String name,String descriptor,String signature,String[] exceptions) {
                    if(++parsedMethods>8192) throw new IllegalStateException("Custom instruction class metadata exceeds 8192 methods");
                    final MethodInfo method=new MethodInfo();method.dynamic=(access&Opcodes.ACC_ABSTRACT)!=0;info.methods.put(name+descriptor,method);
                    return new MethodVisitor(Opcodes.ASM9) {
                        @Override public void visitMethodInsn(int opcode,String owner,String name,String descriptor,boolean isInterface) {
                            method.calls.add(new Call(owner,name,descriptor,opcode));
                            if("java/lang/reflect/Method".equals(owner)&&"invoke".equals(name)
                                ||owner.startsWith("java/lang/invoke/MethodHandle")) method.dynamic=true;
                        }
                        @Override public void visitInvokeDynamicInsn(String name,String descriptor,Handle bootstrap,Object... arguments) {
                            boolean lambda="java/lang/invoke/LambdaMetafactory".equals(bootstrap.getOwner());
                            if(lambda) {
                                for(Object argument:arguments) if(argument instanceof Handle) {
                                    Handle target=(Handle)argument;
                                    int opcode=target.getTag()==Opcodes.H_INVOKESTATIC?Opcodes.INVOKESTATIC:Opcodes.INVOKEVIRTUAL;
                                    method.calls.add(new Call(target.getOwner(),target.getName(),target.getDesc(),opcode));
                                }
                            } else if(!"java/lang/invoke/StringConcatFactory".equals(bootstrap.getOwner())) method.dynamic=true;
                        }
                    };
                }
            },ClassReader.SKIP_DEBUG|ClassReader.SKIP_FRAMES);
        } catch(RuntimeException error) { throw new IOException("Custom instruction bytecode metadata is invalid or unsupported: "+owner,error); }
        return info;
    }
    static final class Call {
        final String owner,name,descriptor;final int opcode;
        Call(String owner,String name,String descriptor,int opcode) { this.owner=owner;this.name=name;this.descriptor=descriptor;this.opcode=opcode; }
    }
    static final class MethodInfo { final List<Call> calls=new ArrayList<Call>();boolean dynamic; }
    static final class ClassInfo { String parent;final Map<String,MethodInfo> methods=new HashMap<String,MethodInfo>(); }
}
