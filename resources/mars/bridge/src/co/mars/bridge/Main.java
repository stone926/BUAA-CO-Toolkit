package co.mars.bridge;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** File-result protocol keeps MIPS stdout and stdin available to ordinary syscalls. */
public final class Main {
    static Map<String,Object> object(Object... pairs) {
        Map<String,Object> map = new LinkedHashMap<String,Object>();
        for (int i=0;i<pairs.length;i+=2) map.put((String)pairs[i],pairs[i+1]);
        return map;
    }
    public static void main(String[] args) {
        Options options = null;
        Map<String,Object> result = object("protocolVersion",1,"ok",false,"javaVersion",System.getProperty("java.version"),
            "segments",new ArrayList<Object>(),"customInstructions",new ArrayList<Object>());
        try {
            options = new Options(args);
            new MarsBridge(options,result).run();
            result.put("ok",true);
        } catch (Throwable error) {
            result.put("stopReason","error");
            String message = error.getMessage();
            try {
                Object errors = Reflect.call(error,"errors");
                if (errors != null) message = String.valueOf(Reflect.call(errors,"generateErrorAndWarningReport"));
            } catch (Exception ignored) { }
            result.put("diagnostic",error.getClass().getSimpleName()+": "+(message == null ? error.toString() : message));
        }
        try {
            if (options == null) {
                for (int i=0;i+1<args.length;i++) if ("--result".equals(args[i])) {
                    Files.write(Paths.get(args[i+1]),Json.encode(result).getBytes(StandardCharsets.UTF_8)); return;
                }
                System.err.println(Json.encode(result));
            } else {
                Path target = Paths.get(options.result);
                Files.write(target,Json.encode(result).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception error) { System.err.println("MARS bridge could not write result: "+error); System.exit(2); }
    }
    static final class Options {
        String mode="assemble", source, layout="Default", profile="ordinary", result, expected;
        boolean delayed=false; int maxSteps=1000000; Integer halt;
        final List<String> classes=new ArrayList<String>();
        final ArrayList<Integer> interrupts=new ArrayList<Integer>();
        Options(String[] args) {
            for (int i=0;i<args.length;i+=2) {
                if (i+1>=args.length) throw new IllegalArgumentException("Missing value for "+args[i]);
                String key=args[i],value=args[i+1];
                if ("--mode".equals(key)) mode=value;
                else if ("--source".equals(key)) source=value;
                else if ("--layout".equals(key)) layout=value;
                else if ("--profile".equals(key)) profile=value;
                else if ("--result".equals(key)) result=value;
                else if ("--expected-image".equals(key)) expected=value;
                else if ("--delayed".equals(key)) {
                    if (!"true".equals(value)&&!"false".equals(value)) throw new IllegalArgumentException("Invalid delayed policy");
                    delayed=Boolean.parseBoolean(value);
                } else if ("--max-steps".equals(key)) maxSteps=Integer.parseInt(value);
                else if ("--halt-pc".equals(key)) halt=parseAddress(value);
                else if ("--class".equals(key)) classes.add(value);
                else if ("--interrupt".equals(key)) {
                    if (!value.isEmpty()) for (String pc:value.split(",")) interrupts.add(parseAddress(pc));
                } else throw new IllegalArgumentException("Unknown option "+key);
            }
            if (source==null||result==null) throw new IllegalArgumentException("--source and --result are required");
            if (!Arrays.asList("assemble","execute","console").contains(mode)) throw new IllegalArgumentException("Invalid mode "+mode);
            if (!Arrays.asList("ordinary","P3","P4","P5","P6","P7").contains(profile)) throw new IllegalArgumentException("Invalid profile "+profile);
            if (maxSteps<=0) throw new IllegalArgumentException("--max-steps must be positive");
            if (course() && delayed != ("P5".equals(profile)||"P6".equals(profile)||"P7".equals(profile))) throw new IllegalArgumentException("Course delayed policy does not match "+profile);
            if (!"P7".equals(profile)&&!interrupts.isEmpty()) throw new IllegalArgumentException("Interrupt schedule requires P7");
            if (course() && !"CompactLargeText".equals(layout)) throw new IllegalArgumentException("Course profile requires CompactLargeText layout");
            if ("console".equals(mode)&&course()) throw new IllegalArgumentException("Console mode requires ordinary profile");
        }
        boolean course() { return !"ordinary".equals(profile); }
        static int parseAddress(String value) {
            long n=value.startsWith("0x") ? Long.parseLong(value.substring(2),16) : Long.parseLong(value);
            if (n<0||n>0xffffffffL) throw new IllegalArgumentException("Address outside uint32"); return (int)n;
        }
    }
}
