package co.mars.bridge;

import java.lang.reflect.*;

/** Small reflection boundary: the bridge has no build-time MARS dependency. */
final class Reflect {
    private static final java.util.Map<String,Method> methodCache = new java.util.concurrent.ConcurrentHashMap<String,Method>();
    static Class<?> type(String name) throws Exception { return Class.forName(name); }
    static Object field(Object owner, String name) throws Exception {
        Class<?> type = owner instanceof Class ? (Class<?>) owner : owner.getClass();
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(owner instanceof Class ? null : owner);
    }
    static void field(Object owner, String name, Object value) throws Exception {
        Class<?> type = owner instanceof Class ? (Class<?>) owner : owner.getClass();
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        field.set(owner instanceof Class ? null : owner, value);
    }
    static Object call(Object owner, String name, Object... args) throws Exception {
        Class<?> type = owner instanceof Class ? (Class<?>) owner : owner.getClass();
        StringBuilder key = new StringBuilder(type.getName()).append('#').append(name);
        for(Object arg:args) key.append(':').append(arg==null?"null":arg.getClass().getName());
        Method cached=methodCache.get(key.toString());
        if(cached!=null) return invoke(cached,owner,args);
        java.util.List<Method> methods = new java.util.ArrayList<Method>();
        java.util.Collections.addAll(methods, type.getMethods());
        java.util.Collections.addAll(methods, type.getDeclaredMethods());
        for (Method method : methods) {
            if (!method.getName().equals(name) || method.getParameterTypes().length != args.length) continue;
            Class<?>[] params = method.getParameterTypes();
            boolean match = true;
            for (int i = 0; i < args.length; i++) {
                Class<?> p = params[i];
                if (p == int.class) p = Integer.class;
                if (p == boolean.class) p = Boolean.class;
                if (p == long.class) p = Long.class;
                if (args[i] != null && !p.isInstance(args[i])) match = false;
            }
            if (!match) continue;
            method.setAccessible(true);
            methodCache.put(key.toString(),method);
            return invoke(method,owner,args);
        }
        throw new NoSuchMethodException(type.getName() + "." + name);
    }
    private static Object invoke(Method method,Object owner,Object[] args) throws Exception {
            try { return method.invoke(owner instanceof Class ? null : owner, args); }
            catch (InvocationTargetException e) {
                Throwable cause = e.getCause();
                if (cause instanceof Exception) throw (Exception) cause;
                throw e;
            }
    }
    static int integer(Object value) { return ((Number) value).intValue(); }
    static long unsigned(int value) { return Integer.toUnsignedLong(value); }
    private Reflect() {}
}
