package dev.inlineconsole;

import com.intellij.ide.AppLifecycleListener;
import org.jetbrains.annotations.NotNull;

import java.util.List;

/** Starts the log server and Vite auto-connect with the IDE, before any editor or tool window is opened. */
public final class Startup implements AppLifecycleListener {
    @Override
    public void appFrameCreated(@NotNull List<String> commandLineArgs) {
        LogStore.getInstance();
        AutoConnect.start();
    }
}
