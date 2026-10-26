package dev.inlineconsole;

import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Zero-config Vite and Next.js: keeps one guarded line at the top of each open project's Vite / Next.js
 * entry file that loads Inline Console's js/auto.mjs (Vite) or js/auto-next.cjs (Next.js). Those add the
 * plugin in memory when the dev server loads its config. So it works however the dev server starts
 * (terminal, run configuration, a script that spawns it) and the config file stays untouched. The line is
 * a try/catch around the load: if this plugin is ever removed, it fails quietly and the tool starts as
 * usual. Turning auto-connect off removes the line.
 */
final class AutoConnect {
    private static final String ENABLED_KEY = "dev.inlineconsole.autoConnectVite"; // named before Next.js joined
    private static final String START = "/* inline-console:auto */";
    private static final String END = "/* inline-console:auto-end */";

    /** entry: the tool's CLI file; script: what our line loads from the plugin's js/ folder; esm: how. */
    record Hook(String tool, String entry, String script, boolean esm) {}

    // ponytail: the project root's node_modules only; look deeper when monorepos with per-app installs need it
    private static final List<Hook> HOOKS = List.of(
            new Hook("Vite", "node_modules/vite/bin/vite.js", "auto.mjs", true),
            new Hook("Vite", "node_modules/vite/dist/vite/bin/vite.js", "auto.mjs", true), // Vite+
            new Hook("Next.js", "node_modules/next/dist/bin/next", "auto-next.cjs", false));
    private static final Set<Path> announced = ConcurrentHashMap.newKeySet();
    private static final Set<String> warned = ConcurrentHashMap.newKeySet(); // it runs every 10 s: say each problem once

    private AutoConnect() {}

    static boolean enabled() {
        return PropertiesComponent.getInstance().getBoolean(ENABLED_KEY, true);
    }

    static void setEnabled(boolean on) {
        PropertiesComponent.getInstance().setValue(ENABLED_KEY, on, true);
        AppExecutorUtil.getAppExecutorService().execute(AutoConnect::checkAll);
    }

    /** Checks every 10 s: projects open over time, and `npm install` replaces the tool's files (and our line). */
    static void start() {
        AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(AutoConnect::checkAll, 2, 10, TimeUnit.SECONDS);
    }

    private static synchronized void checkAll() {
        try {
            Path js = enabled() ? pluginJs() : null;
            for (Project project : ProjectManager.getInstance().getOpenProjects()) {
                String base = project.isDisposed() ? null : project.getBasePath();
                if (base == null) continue;
                for (Hook hook : HOOKS) {
                    Path file = Path.of(base).resolve(hook.entry());
                    try {
                        if (Files.isRegularFile(file)) update(base, file, hook, js == null ? null : lineFor(js.resolve(hook.script()), hook.esm()));
                    } catch (IOException e) {
                        problemOnce("auto-connect couldn't update " + file + "; add Inline Console to the " + hook.tool() + " config instead", e);
                    }
                }
            }
        } catch (Throwable e) {
            LogStore.rethrowControlFlow(e);
            problemOnce("auto-connect couldn't check the open projects", e); // caught, so the schedule keeps running
        }
    }

    // line == null removes our line; otherwise it is added, or replaced when it points somewhere else
    private static void update(String base, Path entry, Hook hook, @Nullable String line) throws IOException {
        Path file = entry.toRealPath(); // pnpm links node_modules/<tool> into its store
        String content = Files.readString(file, StandardCharsets.UTF_8);
        String updated = withLine(content, line, hook.esm());
        if (updated == null) return;
        // write a new file and swap it in: never a half-written entry, and a pnpm hard link to the store stays intact
        Path temp = file.resolveSibling(file.getFileName() + ".inline-console.tmp");
        Files.writeString(temp, updated, StandardCharsets.UTF_8);
        Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        String shown = Path.of(base).relativize(entry).toString().replace('\\', '/');
        if (line == null) {
            announced.remove(file);
            LogStore.getInstance().note(entry.toString(), "Auto-connect off: removed Inline Console's line from " + shown + ".");
        } else if (announced.add(file)) {
            LogStore.getInstance().note(entry.toString(), "Auto-connect: hooked " + shown + ". Start (or restart) the "
                    + hook.tool() + " dev server and it connects, with no config change.");
        }
    }

    /** The file with our line set to `line` (null: removed), or null when nothing needs to change. */
    static @Nullable String withLine(String content, @Nullable String line, boolean esm) {
        int at = content.indexOf(START);
        if (at >= 0) {
            int end = content.indexOf(END, at);
            if (end < 0) return null; // someone edited our line; leave the file alone
            int lineEnd = content.indexOf('\n', end);
            lineEnd = lineEnd < 0 ? content.length() : lineEnd + 1;
            if (content.substring(at, lineEnd).equals(line)) return null;
            return content.substring(0, at) + (line == null ? "" : line) + content.substring(lineEnd);
        }
        if (line == null) return null;
        // an ES module line uses top-level await, so only ES module entries get one (Vite's is ESM since Vite 3);
        // a CommonJS line in an ES module would only fail inside its try
        if (esm && !(content.startsWith("import ") || content.contains("\nimport "))) return null;
        int insertAt = content.startsWith("#!") ? content.indexOf('\n') + 1 : 0;
        // after "use strict": a directive only counts while it comes first
        for (String directive : List.of("\"use strict\";\n", "'use strict';\n", "\"use strict\";\r\n", "'use strict';\r\n")) {
            if (content.startsWith(directive, insertAt)) insertAt += directive.length();
        }
        return content.substring(0, insertAt) + line + content.substring(insertAt);
    }

    static String lineFor(Path script, boolean esm) {
        String load = esm ? "await import(" + quote(script.toUri().toString()) + ")" : "require(" + quote(script.toString()) + ")";
        return START + " try { " + load + "; } catch {} " + END + "\n";
    }

    private static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static @Nullable Path pluginJs() {
        IdeaPluginDescriptor plugin = PluginManagerCore.getPlugin(PluginId.getId("dev.inlineconsole"));
        Path js = plugin == null ? null : plugin.getPluginPath().resolve("js");
        if (js != null && Files.isRegularFile(js.resolve("auto.mjs")) && Files.isRegularFile(js.resolve("auto-next.cjs"))) return js;
        problemOnce("auto-connect is off: the plugin's js folder is incomplete; reinstall Inline Console", null);
        return null;
    }

    /** Self-check, run by build.ps1: java -cp "build/classes;<WebStorm>/lib/*" dev.inlineconsole.AutoConnect */
    public static void main(String[] args) {
        Path tmp = Path.of(System.getProperty("java.io.tmpdir"));
        String vite = "#!/usr/bin/env node\nimport { performance } from 'node:perf_hooks'\nawait import('../dist/node/cli.js')\n";
        String line = lineFor(tmp.resolve("a b").resolve("auto.mjs"), true);
        String hooked = withLine(vite, line, true);
        check(hooked != null && hooked.startsWith("#!/usr/bin/env node\n" + line + "import "), "adds the line after the shebang");
        check(line.contains("file:///") && line.contains("a%20b") && line.endsWith(END + "\n"), "imports a file URL");
        check(withLine(hooked, line, true) == null, "leaves a current line alone");
        String moved = withLine(hooked, lineFor(tmp.resolve("other").resolve("auto.mjs"), true), true);
        check(moved != null && moved.contains("other") && moved.indexOf(START) == moved.lastIndexOf(START), "replaces an outdated line");
        check(vite.equals(withLine(hooked, null, true)), "removing restores the file exactly");
        check(withLine(vite, null, true) == null, "nothing to remove");
        check(withLine("#!/usr/bin/env node\nrequire('../dist/node/cli.js')\n", line, true) == null, "no ES module line in a CommonJS entry");
        check(withLine(hooked.replace(END, ""), null, true) == null, "leaves an edited line alone");

        String next = "#!/usr/bin/env node\n\"use strict\";\nObject.defineProperty(exports, \"__esModule\", {\n";
        String cjs = lineFor(Path.of("C:\\Users\\a b\\js\\auto-next.cjs"), false);
        check(cjs.contains("require(\"C:\\\\Users\\\\a b\\\\js\\\\auto-next.cjs\")"), "requires an escaped Windows path");
        String nextHooked = withLine(next, cjs, false);
        check(nextHooked != null && nextHooked.startsWith("#!/usr/bin/env node\n\"use strict\";\n" + cjs + "Object."), "goes after \"use strict\"");
        check(next.equals(withLine(nextHooked, null, false)), "removing restores Next's entry exactly");
        System.out.println("ok");
    }

    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }

    private static void problemOnce(String message, @Nullable Throwable error) {
        if (warned.add(message)) LogStore.getInstance().problem(message, error);
    }
}
