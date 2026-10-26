package dev.inlineconsole;

import com.intellij.openapi.editor.EditorLinePainter;
import com.intellij.openapi.editor.LineExtensionInfo;
import com.intellij.openapi.editor.markup.TextAttributes;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.JBColor;
import org.jetbrains.annotations.NotNull;

import java.awt.Font;
import java.util.Collection;
import java.util.List;

/** Draws the latest logged value at the end of the line that logged it. */
public final class InlineLinePainter extends EditorLinePainter {
    private static final int MAX_LENGTH = 150;
    private static final TextAttributes LOG = attributes(new JBColor(0x808080, 0x8C8C8C));
    private static final TextAttributes WARN = attributes(new JBColor(0xB07800, 0xD9A343));
    private static final TextAttributes ERROR = attributes(new JBColor(0xC62828, 0xF07178));

    // Runs on every editor repaint: a failure here must never break the editor, only skip the value.
    @Override
    public Collection<LineExtensionInfo> getLineExtensions(@NotNull Project project, @NotNull VirtualFile file, int lineNumber) {
        try {
            return extension(file, lineNumber);
        } catch (RuntimeException e) {
            LogStore.rethrowControlFlow(e);
            LogStore.getInstance().problem("couldn't draw an inline value", e);
            return null;
        }
    }

    private static Collection<LineExtensionInfo> extension(VirtualFile file, int lineNumber) {
        LogStore.Entry entry = LogStore.getInstance().latest(file.getPath(), lineNumber + 1);
        if (entry == null) return null;
        // first line only: an Error's text carries its whole stack; the tool window shows everything
        String text = entry.text().strip();
        int newline = text.indexOf('\n');
        if (newline >= 0) text = text.substring(0, newline).strip() + " …";
        text = text.replaceAll("\\s+", " ");
        if (text.length() > MAX_LENGTH) text = text.substring(0, MAX_LENGTH) + "…";
        String hits = entry.hits() > 1 ? "  ×" + entry.hits() : "";
        TextAttributes style = switch (entry.kind()) {
            case "error" -> ERROR;
            case "warn" -> WARN;
            default -> LOG;
        };
        return List.of(new LineExtensionInfo("    " + text + hits, style));
    }

    private static TextAttributes attributes(JBColor color) {
        return new TextAttributes(color, null, null, null, Font.ITALIC);
    }
}
