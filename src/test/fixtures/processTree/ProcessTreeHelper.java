import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Real JVM parent/grandchild fixture for the cross-platform process supervisor gate. */
public final class ProcessTreeHelper {
    private ProcessTreeHelper() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !(args[0].equals("parent") || args[0].equals("child"))) {
            throw new IllegalArgumentException("usage: ProcessTreeHelper parent|child <pid-file>");
        }
        Path pidFile = Path.of(args[1]);
        if (args[0].equals("child")) {
            Files.writeString(pidFile, Long.toString(ProcessHandle.current().pid()), StandardCharsets.UTF_8);
            System.out.println("grandchild-ready");
            System.out.flush();
            waitForever();
            return;
        }

        String javaExecutable = Path.of(
            System.getProperty("java.home"),
            "bin",
            System.getProperty("os.name").toLowerCase().contains("win") ? "java.exe" : "java"
        ).toString();
        String classPath = System.getProperty("java.class.path");
        Process child = new ProcessBuilder(
            javaExecutable,
            "-cp",
            classPath,
            ProcessTreeHelper.class.getName(),
            "child",
            pidFile.toString()
        ).inheritIO().start();
        System.out.println("parent-ready:" + child.pid());
        System.out.flush();
        waitForever();
    }

    private static void waitForever() throws InterruptedException, IOException {
        while (true) {
            Thread.sleep(1000L);
        }
    }
}
