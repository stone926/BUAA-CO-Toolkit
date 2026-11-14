package co.mars.bridge;

import java.util.*;

/** Dependency-free protocol JSON, including the expected-image request. */
final class Json {
    static String encode(Object value) {
        if (value == null) return "null";
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        if (value instanceof Map) {
            StringBuilder b = new StringBuilder("{");
            for (Object entryObject : ((Map<?, ?>) value).entrySet()) {
                Map.Entry<?, ?> e = (Map.Entry<?, ?>) entryObject;
                if (b.length() > 1) b.append(',');
                b.append(encode(e.getKey().toString())).append(':').append(encode(e.getValue()));
            }
            return b.append('}').toString();
        }
        if (value instanceof Iterable) {
            StringBuilder b = new StringBuilder("[");
            for (Object item : (Iterable<?>) value) {
                if (b.length() > 1) b.append(',');
                b.append(encode(item));
            }
            return b.append(']').toString();
        }
        StringBuilder b = new StringBuilder("\"");
        for (char c : value.toString().toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 32) b.append(String.format("\\u%04x", (int)c));
            else b.append(c);
        }
        return b.append('"').toString();
    }
    static Object decode(String text) {
        Parser p = new Parser(text); Object result = p.value(); p.space();
        if (p.i != text.length()) throw new IllegalArgumentException("Trailing JSON content");
        return result;
    }
    private static final class Parser {
        final String s; int i;
        Parser(String s) { this.s = s; }
        void space() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
        char next() { if (i >= s.length()) throw new IllegalArgumentException("Incomplete JSON"); return s.charAt(i++); }
        Object value() {
            space(); char c = next();
            if (c == '"') return string();
            if (c == '{') {
                Map<String,Object> map = new LinkedHashMap<String,Object>(); space();
                if (i < s.length() && s.charAt(i) == '}') { i++; return map; }
                do { space(); if (next() != '"') throw new IllegalArgumentException("JSON key expected");
                    String key = string(); space(); if (next() != ':') throw new IllegalArgumentException("JSON colon expected");
                    map.put(key, value()); space(); c = next();
                } while (c == ',');
                if (c != '}') throw new IllegalArgumentException("JSON object expected"); return map;
            }
            if (c == '[') {
                List<Object> list = new ArrayList<Object>(); space();
                if (i < s.length() && s.charAt(i) == ']') { i++; return list; }
                do { list.add(value()); space(); c = next(); } while (c == ',');
                if (c != ']') throw new IllegalArgumentException("JSON array expected"); return list;
            }
            int start = i - 1;
            while (i < s.length() && ",]} \r\n\t".indexOf(s.charAt(i)) < 0) i++;
            String token = s.substring(start,i);
            if ("true".equals(token)) return true;
            if ("false".equals(token)) return false;
            if ("null".equals(token)) return null;
            return Long.valueOf(token);
        }
        String string() {
            StringBuilder b = new StringBuilder(); char c;
            while ((c = next()) != '"') {
                if (c == '\\') { c = next();
                    if (c == 'u') { b.append((char)Integer.parseInt(s.substring(i,i+4),16)); i += 4; continue; }
                    int k = "\"\\/bfnrt".indexOf(c);
                    if (k < 0) throw new IllegalArgumentException("Invalid JSON escape");
                    c = "\"\\/\b\f\n\r\t".charAt(k);
                }
                b.append(c);
            }
            return b.toString();
        }
    }
    private Json() {}
}
