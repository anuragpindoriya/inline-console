package dev.inlineconsole;

import com.intellij.icons.AllIcons;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.editor.LogicalPosition;
import com.intellij.openapi.editor.event.EditorEventMulticaster;
import com.intellij.openapi.editor.event.EditorMouseEvent;
import com.intellij.openapi.editor.event.EditorMouseEventArea;
import com.intellij.openapi.editor.event.EditorMouseListener;
import com.intellij.openapi.editor.event.EditorMouseMotionListener;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileTypes.FileType;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.fileTypes.PlainTextFileType;
import com.intellij.openapi.ide.CopyPasteManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.popup.JBPopup;
import com.intellij.openapi.ui.popup.JBPopupFactory;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.util.Ref;
import com.intellij.openapi.util.text.StringUtil;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.CollectionListModel;
import com.intellij.ui.EditorTextField;
import com.intellij.ui.OnePixelSplitter;
import com.intellij.ui.ColoredListCellRenderer;
import com.intellij.ui.SimpleTextAttributes;
import com.intellij.ui.awt.RelativePoint;
import com.intellij.ui.render.RenderingUtil;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBList;
import com.intellij.ui.components.JBScrollPane;
import com.intellij.util.ui.JBDimension;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.AbstractAction;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.KeyStroke;
import javax.swing.ListCellRenderer;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.FlowLayout;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.datatransfer.StringSelection;
import java.awt.event.ActionEvent;
import java.awt.event.KeyEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.time.Instant;
import java.util.List;
import java.util.function.IntConsumer;
import java.util.stream.Collectors;

/**
 * Hovering (or clicking) the inline value after a line's code opens that line's recent values:
 * a list, newest first, and the selected value in full (objects as pretty JSON), with Copy / Copy all.
 * Each row has a delete button (or the Delete key); Clear line forgets all of the line's values.
 */
final class ValuesPopup implements EditorMouseMotionListener, EditorMouseListener {
    private record Target(Editor editor, VirtualFile file, int line, Point point) {
        String key() {
            return LogStore.key(file.getPath()) + ":" + line;
        }
    }

    private final Timer hoverDelay = new Timer(400, e -> showPending());
    private @Nullable Target pending;
    private @Nullable JBPopup popup;
    private @Nullable String popupKey;

    static void install(Disposable parent) {
        ValuesPopup listener = new ValuesPopup();
        listener.hoverDelay.setRepeats(false);
        EditorEventMulticaster multicaster = EditorFactory.getInstance().getEventMulticaster();
        multicaster.addEditorMouseMotionListener(listener, parent);
        multicaster.addEditorMouseListener(listener, parent);
        Disposer.register(parent, listener.hoverDelay::stop);
    }

    // Mouse handlers run for every editor: any failure is reported, never thrown into the editor.
    private static void guarded(String what, Runnable action) {
        try {
            action.run();
        } catch (RuntimeException e) {
            LogStore.rethrowControlFlow(e);
            LogStore.getInstance().problem("couldn't " + what, e);
        }
    }

    @Override
    public void mouseMoved(@NotNull EditorMouseEvent e) {
        guarded("track the mouse over inline values", () -> onMove(e));
    }

    @Override
    public void mouseClicked(@NotNull EditorMouseEvent e) {
        guarded("open the values popup", () -> onClick(e));
    }

    private void onMove(EditorMouseEvent e) {
        Target target = target(e);
        if (target == null) {
            hoverDelay.stop();
            pending = null;
            return;
        }
        if (popup != null && popup.isVisible() && target.key().equals(popupKey)) return;
        pending = target;
        hoverDelay.restart();
    }

    private void onClick(EditorMouseEvent e) {
        Target target = target(e);
        if (target == null) return;
        hoverDelay.stop();
        show(target);
    }

    private void showPending() {
        Target target = pending;
        if (target != null) guarded("open the values popup", () -> show(target));
    }

    // Only the space after a line's code, where the inline value is drawn, on lines that logged something.
    private static @Nullable Target target(EditorMouseEvent e) {
        if (e.getArea() != EditorMouseEventArea.EDITING_AREA) return null;
        Editor editor = e.getEditor();
        VirtualFile file = FileDocumentManager.getInstance().getFile(editor.getDocument());
        if (editor.getProject() == null || file == null) return null;
        Point point = e.getMouseEvent().getPoint();
        Document document = editor.getDocument();
        int line = editor.xyToLogicalPosition(point).line;
        if (line < 0 || line >= document.getLineCount()) return null;
        if (point.x < editor.offsetToXY(document.getLineEndOffset(line)).x + JBUI.scale(12)) return null;
        if (LogStore.getInstance().latest(file.getPath(), line + 1) == null) return null;
        return new Target(editor, file, line + 1, point);
    }

    private void show(Target target) {
        Editor editor = target.editor();
        Project project = editor.getProject();
        LogStore store = LogStore.getInstance();
        String path = target.file().getPath();
        List<LogStore.Entry> entries = store.values(path, target.line());
        if (entries.isEmpty() || project == null || editor.isDisposed()) return;
        if (popup != null) popup.cancel();
        Ref<JBPopup> self = new Ref<>();

        CollectionListModel<LogStore.Entry> model = new CollectionListModel<>(entries);
        JBList<LogStore.Entry> list = new JBList<>(model) {
            @Override
            public boolean getScrollableTracksViewportWidth() {
                return true; // long rows get cut, so each row's delete button stays in view
            }
        };
        list.setExpandableItemsEnabled(false); // the full-row tooltip would cover the delete button
        RowRenderer rows = new RowRenderer();
        list.setCellRenderer(rows);
        JBLabel count = new JBLabel(countText(entries));

        // the store renumbers newer values after a delete, so the list is reloaded from it
        IntConsumer delete = index -> guarded("delete the value", () -> {
            if (index < 0 || index >= model.getSize()) return;
            store.remove(path, target.line(), model.getElementAt(index));
            List<LogStore.Entry> fresh = store.values(path, target.line());
            if (fresh.isEmpty()) {
                self.get().cancel();
                return;
            }
            model.replaceAll(fresh);
            list.setSelectedIndex(Math.min(index, fresh.size() - 1));
            count.setText(countText(fresh));
        });
        MouseAdapter deleteButtons = new MouseAdapter() {
            @Override
            public void mouseMoved(MouseEvent ev) {
                guarded("track the delete buttons", () -> {
                    int index = deleteButtonAt(list, ev.getPoint());
                    if (index != rows.hovered) {
                        rows.hovered = index;
                        list.repaint();
                    }
                    list.setCursor(Cursor.getPredefinedCursor(index >= 0 ? Cursor.HAND_CURSOR : Cursor.DEFAULT_CURSOR));
                });
            }

            @Override
            public void mouseExited(MouseEvent ev) {
                rows.hovered = -1;
                list.repaint();
            }

            @Override
            public void mouseClicked(MouseEvent ev) {
                int index = deleteButtonAt(list, ev.getPoint());
                if (index >= 0) delete.accept(index);
            }
        };
        list.addMouseListener(deleteButtons);
        list.addMouseMotionListener(deleteButtons);
        list.getInputMap().put(KeyStroke.getKeyStroke(KeyEvent.VK_DELETE, 0), "inlineConsole.deleteValue");
        list.getActionMap().put("inlineConsole.deleteValue", new AbstractAction() {
            @Override
            public void actionPerformed(ActionEvent ev) {
                delete.accept(list.getSelectedIndex());
            }
        });
        EditorTextField viewer = new EditorTextField(EditorFactory.getInstance().createDocument(""), project,
                PlainTextFileType.INSTANCE, true, false);
        viewer.addSettingsProvider(ed -> {
            ed.setVerticalScrollbarVisible(true);
            ed.setHorizontalScrollbarVisible(true);
            ed.getSettings().setUseSoftWraps(true);
            ed.getSettings().setLineNumbersShown(true);
            ed.getSettings().setFoldingOutlineShown(true);
        });
        list.addListSelectionListener(ev -> guarded("show the selected value", () -> {
            LogStore.Entry selected = list.getSelectedValue();
            if (!ev.getValueIsAdjusting() && selected != null) {
                String text = fullText(selected);
                viewer.setNewDocumentAndFileType(fileType(selected), EditorFactory.getInstance().createDocument(text));
                scrollToTop(viewer);
            }
        }));
        list.setSelectedIndex(0);

        JButton copy = new JButton("Copy");
        copy.addActionListener(ev -> guarded("copy the value", () -> {
            LogStore.Entry selected = list.getSelectedValue();
            if (selected != null) copy(fullText(selected));
        }));
        JButton copyAll = new JButton("Copy all");
        copyAll.addActionListener(ev -> guarded("copy all values", () -> copy(model.getItems().stream()
                .map(e -> "// " + time(e) + "\n" + fullText(e))
                .collect(Collectors.joining("\n\n")))));
        JButton clear = new JButton("Clear line");
        clear.setToolTipText("Remove every value logged at this line. The Inline Console tab keeps its log.");
        clear.addActionListener(ev -> guarded("clear the line", () -> {
            store.clearLine(path, target.line());
            self.get().cancel();
        }));

        JPanel buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT, JBUI.scale(6), 0));
        buttons.add(copy);
        buttons.add(copyAll);
        buttons.add(clear);
        JPanel bottom = new JPanel(new BorderLayout());
        bottom.setBorder(JBUI.Borders.empty(4, 8));
        bottom.add(count, BorderLayout.WEST);
        bottom.add(buttons, BorderLayout.EAST);

        OnePixelSplitter split = new OnePixelSplitter(true, 0.3f);
        split.setFirstComponent(new JBScrollPane(list));
        split.setSecondComponent(viewer);
        JPanel panel = new JPanel(new BorderLayout());
        panel.add(split, BorderLayout.CENTER);
        panel.add(bottom, BorderLayout.SOUTH);
        panel.setPreferredSize(new JBDimension(720, 420));

        popup = JBPopupFactory.getInstance().createComponentPopupBuilder(panel, list)
                .setTitle(target.file().getName() + ":" + target.line())
                .setResizable(true)
                .setMovable(true)
                .setRequestFocus(false)
                .setCancelOnClickOutside(true)
                .setCancelKeyEnabled(true)
                .setCancelOnMouseOutCallback(ev -> !overLine(target, ev) && !nearPopup(target, panel, ev))
                .setDimensionServiceKey(project, "InlineConsole.Values", false)
                .createPopup();
        self.set(popup);
        popupKey = target.key();
        int belowLine = editor.logicalPositionToXY(new LogicalPosition(target.line(), 0)).y;
        popup.show(new RelativePoint(editor.getContentComponent(), new Point(target.point().x, belowLine)));
        scrollToTop(viewer);
    }

    private static String countText(List<LogStore.Entry> entries) {
        int hits = entries.get(0).hits();
        return hits > entries.size()
                ? "Latest " + entries.size() + " of " + hits + " values, newest first"
                : entries.size() + (entries.size() == 1 ? " value" : " values, newest first");
    }

    /** A value's row: its time and one-line text, then a delete button. */
    private static final class RowRenderer implements ListCellRenderer<LogStore.Entry> {
        static final int DELETE_WIDTH = 28; // icon plus padding, before scaling
        private final ColoredListCellRenderer<LogStore.Entry> text = new ColoredListCellRenderer<>() {
            @Override
            protected void customizeCellRenderer(@NotNull JList<? extends LogStore.Entry> l, LogStore.Entry e, int index,
                                                 boolean selected, boolean focused) {
                append(time(e) + "   ", SimpleTextAttributes.GRAYED_ATTRIBUTES);
                append(oneLine(e.text()));
            }
        };
        private final JBLabel delete = new JBLabel();
        private final JPanel row = new JPanel(new BorderLayout());
        int hovered = -1; // row whose delete button is under the mouse

        RowRenderer() {
            delete.setBorder(JBUI.Borders.empty(0, 6));
        }

        @Override
        public Component getListCellRendererComponent(JList<? extends LogStore.Entry> list, LogStore.Entry e, int index,
                                                      boolean selected, boolean focused) {
            Component cell = text.getListCellRendererComponent(list, e, index, selected, focused);
            row.removeAll();
            row.add(cell, BorderLayout.CENTER);
            row.add(delete, BorderLayout.EAST);
            // from the list, not the cell: an unselected cell is see-through and still reports the last selected color
            row.setBackground(RenderingUtil.getBackground(list, selected));
            delete.setIcon(index == hovered ? AllIcons.Actions.CloseHovered : AllIcons.Actions.Close);
            row.setToolTipText(index == hovered ? "Delete this value (Delete key)" : null);
            return row;
        }
    }

    // index of the row whose delete button is under the point, or -1
    private static int deleteButtonAt(JList<?> list, Point p) {
        int index = list.locationToIndex(p);
        Rectangle row = index < 0 ? null : list.getCellBounds(index, index);
        return row != null && row.contains(p) && p.x >= row.x + row.width - JBUI.scale(RowRenderer.DELETE_WIDTH) ? index : -1;
    }

    // the viewer's editor is created lazily, so scroll once it exists
    private static void scrollToTop(EditorTextField viewer) {
        viewer.setCaretPosition(0);
        SwingUtilities.invokeLater(() -> {
            Editor ed = viewer.getEditor();
            if (ed != null) ed.getScrollingModel().scrollVertically(0);
        });
    }

    // forgiving zone around the popup, stretched up to the logged line, so moving toward it doesn't close it
    private static boolean nearPopup(Target target, JComponent panel, MouseEvent ev) {
        if (!panel.isShowing()) return false;
        Rectangle zone = new Rectangle(panel.getLocationOnScreen(), panel.getSize());
        zone.grow(JBUI.scale(40), JBUI.scale(40));
        Component content = target.editor().getContentComponent();
        if (content.isShowing()) {
            int lineTop = content.getLocationOnScreen().y
                    + target.editor().logicalPositionToXY(new LogicalPosition(target.line() - 1, 0)).y;
            zone.add(new Point(zone.x, lineTop));
        }
        return zone.contains(ev.getLocationOnScreen());
    }

    // keeps the popup open while the mouse is still on the line it came from
    private static boolean overLine(Target target, MouseEvent ev) {
        Component content = target.editor().getContentComponent();
        if (!content.isShowing() || ev.getComponent() == null || !ev.getComponent().isShowing()) return false;
        Point p = SwingUtilities.convertPoint(ev.getComponent(), ev.getPoint(), content);
        return p.x >= 0 && p.x <= content.getWidth() && target.editor().xyToLogicalPosition(p).line == target.line() - 1;
    }

    static String fullText(LogStore.Entry e) {
        String text = e.values().isEmpty() ? e.text() : String.join("\n\n", e.values());
        if (e.values().isEmpty() && e.stack() != null && !e.stack().isBlank()) text += "\n\n" + e.stack();
        return StringUtil.convertLineSeparators(text);
    }

    // JSON highlighting when every argument is an object/array; JS when objects are mixed with labels.
    private static FileType fileType(LogStore.Entry e) {
        long objects = e.values().stream().map(String::trim).filter(v -> v.startsWith("{") || v.startsWith("[")).count();
        if (objects == 0) return PlainTextFileType.INSTANCE;
        return FileTypeManager.getInstance().getFileTypeByExtension(objects == e.values().size() ? "json" : "js");
    }

    private static String time(LogStore.Entry e) {
        return LogToolWindowFactory.TIME.format(Instant.ofEpochMilli(e.ts()));
    }

    private static String oneLine(String text) {
        String line = text.replaceAll("\\s+", " ").trim();
        return line.length() > 160 ? line.substring(0, 160) + "…" : line;
    }

    private static void copy(String text) {
        CopyPasteManager.getInstance().setContents(new StringSelection(text));
    }
}
