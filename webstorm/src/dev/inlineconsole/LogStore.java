package dev.inlineconsole;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.ControlFlowException;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.editor.event.DocumentEvent;
import com.intellij.openapi.editor.event.DocumentListener;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.util.SystemInfo;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.util.messages.Topic;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/** Receives log entries over HTTP on 127.0.0.1 and keeps the recent values of every logging line. */
@Service(Service.Level.APP)
public final class LogStore implements Disposable {
    /** values: each console argument in full (objects as pretty JSON); text: the one-line console rendering. */
    public record Entry(String kind, @Nullable String file, int line, String text, List<String> values,
                        @Nullable String stack, long ts, String source, int hits) {}

    public interface Listener {
        void added(Entry entry);

        void cleared();
    }

    public static final Topic<Listener> TOPIC = Topic.create("Inline Console entries", Listener.class);

    // entry kinds that aren't console output: a dev server saying it connected, a problem inside Inline Console
    public static final String HELLO = "hello";
    public static final String PROBLEM = "problem";
    // something Inline Console did for a project, e.g. hooking its Vite
    public static final String NOTE = "note";

    private static final Logger LOG = Logger.getInstance(LogStore.class);
    private static final int MAX_HISTORY = 5000;
    private static final int MAX_PER_LINE = 50;
    private static final int MAX_REPEATS_SHOWN = 3;

    private final Map<String, Integer> problemCounts = new ConcurrentHashMap<>();

    // file key -> line -> recent entries, oldest first
    private final Map<String, Map<Integer, ArrayDeque<Entry>>> latest = new ConcurrentHashMap<>();
    private final ArrayDeque<Entry> history = new ArrayDeque<>();
    private final Set<String> dirtyFiles = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean repaintScheduled = new AtomicBoolean();
    private final int port;
    private final String status;
    private @Nullable HttpServer server;

    public LogStore() {
        port = parsePort(System.getenv("INLINE_CONSOLE_PORT"));
        String status;
        try {
            server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 0);
            server.createContext("/log", this::handle);
            server.start();
            status = "Inline Console is listening on 127.0.0.1:" + port;
        } catch (IOException e) {
            server = null;
            status = "Inline Console could not listen on 127.0.0.1:" + port + " (" + e.getMessage()
                    + "), so no logs can arrive. Another IDE or program may be using the port: close it,"
                    + " or set INLINE_CONSOLE_PORT for both WebStorm and the dev server, then restart WebStorm.";
            problem(status, e);
        }
        this.status = status;

        // Edits shift lines, so a file's inline values are dropped until the app logs again.
        EditorFactory.getInstance().getEventMulticaster().addDocumentListener(new DocumentListener() {
            @Override
            public void documentChanged(@NotNull DocumentEvent event) {
                try {
                    VirtualFile file = FileDocumentManager.getInstance().getFile(event.getDocument());
                    if (file != null && latest.remove(key(file.getPath())) != null) repaintLater(key(file.getPath()));
                } catch (RuntimeException e) {
                    rethrowControlFlow(e);
                    problem("couldn't clear inline values after an edit", e);
                }
            }
        }, this);
        ValuesPopup.install(this);
    }

    public boolean listening() {
        return server != null;
    }

    /**
     * A problem inside Inline Console: logged to idea.log and shown in the tool window (the first few times
     * per message), instead of surfacing as an IDE error.
     */
    public void problem(String message, @Nullable Throwable error) {
        LOG.warn("Inline Console: " + message, error);
        int seen = problemCounts.merge(message, 1, Integer::sum);
        if (seen > MAX_REPEATS_SHOWN) return;
        String text = message + (error != null ? " [" + error + "]" : "")
                + (seen == MAX_REPEATS_SHOWN ? " (further repeats are hidden; see idea.log)" : "");
        record(new Entry(PROBLEM, null, 0, text, List.of(), null, System.currentTimeMillis(), "ide", 1));
    }

    /** file: decides which project's tab shows the note. */
    public void note(String file, String text) {
        record(new Entry(NOTE, file, 0, text, List.of(), null, System.currentTimeMillis(), "ide", 1));
    }

    // IntelliJ's cancellation signals must pass through untouched
    static void rethrowControlFlow(Throwable e) {
        if (e instanceof ControlFlowException) throw (RuntimeException) e;
    }

    public static LogStore getInstance() {
        return ApplicationManager.getApplication().getService(LogStore.class);
    }

    public String status() {
        return status;
    }

    public @Nullable Entry latest(String path, int line) {
        ArrayDeque<Entry> entries = lineEntries(path, line);
        if (entries == null) return null;
        synchronized (entries) {
            return entries.peekLast();
        }
    }

    /** Recent values logged at this line, newest first. */
    public List<Entry> values(String path, int line) {
        ArrayDeque<Entry> entries = lineEntries(path, line);
        if (entries == null) return List.of();
        synchronized (entries) {
            List<Entry> copy = new ArrayList<>(entries);
            Collections.reverse(copy);
            return copy;
        }
    }

    private @Nullable ArrayDeque<Entry> lineEntries(String path, int line) {
        Map<Integer, ArrayDeque<Entry>> lines = latest.get(key(path));
        return lines == null ? null : lines.get(line);
    }

    public List<Entry> history() {
        synchronized (history) {
            return new ArrayList<>(history);
        }
    }

    public void clear() {
        latest.clear();
        synchronized (history) {
            history.clear();
        }
        publisher().cleared();
        ApplicationManager.getApplication().invokeLater(() -> {
            for (Editor editor : EditorFactory.getInstance().getAllEditors()) editor.getContentComponent().repaint();
        });
    }

    static String key(String path) {
        String k = path.replace('\\', '/');
        return SystemInfo.isWindows ? k.toLowerCase(Locale.ROOT) : k;
    }

    // Nothing a client sends can take this server down: bad input is reported and answered with 400.
    private void handle(HttpExchange exchange) {
        int code = 204;
        try {
            if ("POST".equals(exchange.getRequestMethod())) {
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                for (JsonElement element : JsonParser.parseString(body).getAsJsonArray()) {
                    try {
                        add(parse(element.getAsJsonObject()));
                    } catch (RuntimeException e) {
                        code = 400;
                        problem("skipped a log entry it couldn't read", e);
                    }
                }
            }
        } catch (Throwable e) {
            code = 400;
            problem("skipped a batch of logs that wasn't valid JSON", e);
        } finally {
            try {
                exchange.sendResponseHeaders(code, -1);
            } catch (IOException ignored) {
                // the dev server hung up; nothing to answer
            }
            exchange.close();
        }
    }

    private void add(Entry entry) {
        if (PROBLEM.equals(entry.kind())) {
            // reported by the dev server or the app (vite, browser, node, next.js)
            problem(entry.source() + ": " + entry.text(), null);
            return;
        }
        if (HELLO.equals(entry.kind())) {
            record(entry);
            return;
        }
        if (entry.file() != null && entry.line() > 0) {
            String k = key(entry.file());
            ArrayDeque<Entry> entries = latest.computeIfAbsent(k, x -> new ConcurrentHashMap<>())
                    .computeIfAbsent(entry.line(), x -> new ArrayDeque<>());
            synchronized (entries) {
                Entry previous = entries.peekLast();
                entry = new Entry(entry.kind(), entry.file(), entry.line(), entry.text(), entry.values(), entry.stack(),
                        entry.ts(), entry.source(), previous == null ? 1 : previous.hits() + 1);
                entries.addLast(entry);
                if (entries.size() > MAX_PER_LINE) entries.removeFirst();
            }
            repaintLater(k);
        }
        // the log keeps only the one-line text; full values live per line (bounded) for the popup
        record(new Entry(entry.kind(), entry.file(), entry.line(), entry.text(), List.of(), entry.stack(),
                entry.ts(), entry.source(), entry.hits()));
    }

    private void record(Entry entry) {
        synchronized (history) {
            history.addLast(entry);
            if (history.size() > MAX_HISTORY) history.removeFirst();
        }
        try {
            publisher().added(entry);
        } catch (RuntimeException e) {
            LOG.warn("Inline Console: a tool window couldn't show an entry", e); // not problem(): it would loop
        }
    }

    private static Entry parse(JsonObject o) {
        List<String> values = new ArrayList<>();
        if (o.has("values") && o.get("values").isJsonArray()) {
            for (JsonElement v : o.getAsJsonArray("values")) values.add(v.isJsonPrimitive() ? v.getAsString() : v.toString());
        }
        return new Entry(
                string(o, "kind", "log"),
                string(o, "file", null),
                o.has("line") && !o.get("line").isJsonNull() ? o.get("line").getAsInt() : 0,
                string(o, "text", ""),
                values,
                string(o, "stack", null),
                o.has("ts") && !o.get("ts").isJsonNull() ? o.get("ts").getAsLong() : System.currentTimeMillis(),
                string(o, "source", ""),
                1);
    }

    private static String string(JsonObject o, String name, String fallback) {
        JsonElement value = o.get(name);
        return value == null || value.isJsonNull() ? fallback : value.getAsString();
    }

    private static int parsePort(@Nullable String value) {
        try {
            return value == null ? 47321 : Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            return 47321;
        }
    }

    private Listener publisher() {
        return ApplicationManager.getApplication().getMessageBus().syncPublisher(TOPIC);
    }

    // Coalesces bursts of entries into one repaint of the affected editors.
    private void repaintLater(String fileKey) {
        dirtyFiles.add(fileKey);
        if (!repaintScheduled.compareAndSet(false, true)) return;
        ApplicationManager.getApplication().invokeLater(() -> {
            repaintScheduled.set(false);
            try {
                Set<String> files = new HashSet<>(dirtyFiles);
                dirtyFiles.removeAll(files);
                for (Editor editor : EditorFactory.getInstance().getAllEditors()) {
                    VirtualFile file = FileDocumentManager.getInstance().getFile(editor.getDocument());
                    if (file != null && files.contains(key(file.getPath()))) editor.getContentComponent().repaint();
                }
            } catch (RuntimeException e) {
                rethrowControlFlow(e);
                problem("couldn't refresh the editors showing new values", e);
            }
        });
    }

    @Override
    public void dispose() {
        if (server != null) server.stop(0);
    }
}
