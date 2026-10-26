package dev.inlineconsole;

import com.intellij.execution.filters.OpenFileHyperlinkInfo;
import com.intellij.execution.filters.TextConsoleBuilderFactory;
import com.intellij.execution.ui.ConsoleView;
import com.intellij.execution.ui.ConsoleViewContentType;
import com.intellij.icons.AllIcons;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.project.DumbAwareToggleAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import org.jetbrains.annotations.NotNull;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;

/** "Inline Console" tool window: every entry for this project, newest at the bottom, with file:line links. */
public final class LogToolWindowFactory implements ToolWindowFactory, DumbAware {
    static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss.SSS").withZone(ZoneId.systemDefault());

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        LogStore store = LogStore.getInstance();
        ConsoleView console = TextConsoleBuilderFactory.getInstance().createBuilder(project).getConsole();
        Content content = ContentFactory.getInstance().createContent(console.getComponent(), "", false);
        Disposer.register(content, console);
        toolWindow.getContentManager().addContent(content);
        toolWindow.setTitleActions(List.of(new DumbAwareAction("Clear", "Clear inline values and logs", AllIcons.Actions.GC) {
            @Override
            public void actionPerformed(@NotNull AnActionEvent e) {
                store.clear();
            }
        }, new DumbAwareToggleAction("Auto-Connect Vite and Next.js", "Hook this project's Vite or Next.js dev server with no config change", AllIcons.Actions.Lightning) {
            @Override
            public boolean isSelected(@NotNull AnActionEvent e) {
                return AutoConnect.enabled();
            }

            @Override
            public void setSelected(@NotNull AnActionEvent e, boolean state) {
                AutoConnect.setEnabled(state);
            }

            @Override
            public @NotNull ActionUpdateThread getActionUpdateThread() {
                return ActionUpdateThread.BGT;
            }
        }));

        List<LogStore.Entry> history = store.history();
        if (store.listening()) {
            console.print(store.status() + "\nHover a value at the end of a line to see all its values in full, with copy.\n",
                    ConsoleViewContentType.SYSTEM_OUTPUT);
            if (history.stream().noneMatch(e -> LogStore.HELLO.equals(e.kind()))) {
                console.print("""
                        Waiting for a dev server. If nothing shows up:
                          1. Vite and Next.js: keep Auto-Connect (⚡ above) on; or add inlineConsole() to
                             vite.config / withInlineConsole() to next.config
                          2. restart the dev server; its terminal should say "● connected to WebStorm"
                          3. open the app so it runs some console.log calls
                        """, ConsoleViewContentType.SYSTEM_OUTPUT);
            }
            content.setDisplayName("waiting for a dev server");
        } else {
            content.setDisplayName("not listening");
        }
        String base = project.getBasePath();
        for (LogStore.Entry entry : history) {
            if (belongs(entry, base)) show(project, console, content, entry);
        }
        ApplicationManager.getApplication().getMessageBus().connect(content).subscribe(LogStore.TOPIC, new LogStore.Listener() {
            @Override
            public void added(LogStore.Entry entry) {
                if (belongs(entry, base)) ApplicationManager.getApplication().invokeLater(() -> show(project, console, content, entry));
            }

            @Override
            public void cleared() {
                ApplicationManager.getApplication().invokeLater(console::clear);
            }
        });
    }

    // Printing must never fail loudly; a broken entry goes to idea.log (not problem(), which would print again).
    private static void show(Project project, ConsoleView console, Content content, LogStore.Entry entry) {
        try {
            if (project.isDisposed()) return;
            if (LogStore.HELLO.equals(entry.kind())) {
                content.setDisplayName(entry.source() + " connected");
                console.print(TIME.format(Instant.ofEpochMilli(entry.ts())) + "  ● " + entry.text() + "\n",
                        ConsoleViewContentType.LOG_INFO_OUTPUT);
            } else if (LogStore.NOTE.equals(entry.kind())) {
                console.print(TIME.format(Instant.ofEpochMilli(entry.ts())) + "  ℹ " + entry.text() + "\n",
                        ConsoleViewContentType.SYSTEM_OUTPUT);
            } else if (LogStore.PROBLEM.equals(entry.kind())) {
                console.print(TIME.format(Instant.ofEpochMilli(entry.ts())) + "  ⚠ Inline Console problem: " + entry.text() + "\n",
                        ConsoleViewContentType.ERROR_OUTPUT);
            } else {
                print(project, console, entry);
            }
        } catch (RuntimeException e) {
            LogStore.rethrowControlFlow(e);
            Logger.getInstance(LogToolWindowFactory.class).warn("Inline Console: couldn't print an entry", e);
        }
    }

    // Entries without a location (e.g. warnings from libraries) show in every project.
    private static boolean belongs(LogStore.Entry entry, String base) {
        return entry.file() == null || base == null || LogStore.key(entry.file()).startsWith(LogStore.key(base) + "/");
    }

    private static void print(Project project, ConsoleView console, LogStore.Entry entry) {
        ConsoleViewContentType type = switch (entry.kind()) {
            case "error" -> ConsoleViewContentType.ERROR_OUTPUT;
            case "warn" -> ConsoleViewContentType.LOG_WARNING_OUTPUT;
            case "info" -> ConsoleViewContentType.LOG_INFO_OUTPUT;
            case "debug" -> ConsoleViewContentType.LOG_DEBUG_OUTPUT;
            default -> ConsoleViewContentType.NORMAL_OUTPUT;
        };
        console.print(TIME.format(Instant.ofEpochMilli(entry.ts())) + "  " + entry.source() + "  ", ConsoleViewContentType.LOG_DEBUG_OUTPUT);
        if (entry.file() != null) {
            VirtualFile file = LocalFileSystem.getInstance().findFileByPath(entry.file().replace('\\', '/'));
            String name = entry.file().substring(entry.file().replace('\\', '/').lastIndexOf('/') + 1);
            String label = name + (entry.line() > 0 ? ":" + entry.line() : "");
            if (file != null) console.printHyperlink(label, new OpenFileHyperlinkInfo(project, file, Math.max(0, entry.line() - 1)));
            else console.print(label, ConsoleViewContentType.NORMAL_OUTPUT);
            console.print("  ", ConsoleViewContentType.NORMAL_OUTPUT);
        }
        console.print(entry.text() + "\n", type);
        if (entry.stack() != null && !entry.stack().isBlank()) {
            console.print(entry.stack().replaceAll("(?m)^", "    ") + "\n", ConsoleViewContentType.ERROR_OUTPUT);
        }
    }
}
