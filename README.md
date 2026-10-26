# Inline Console for WebStorm

Shows `console.log` / `info` / `warn` / `error` / `debug` values at the end of the line that produced them, right in WebStorm, plus an **Inline Console** tool window with every entry and a clickable `file:line`. Uncaught errors land on the line that threw.

Written from scratch and MIT-licensed (see [LICENSE](LICENSE)).

```
your app (browser or Node) ──► dev server / preload ──► POST 127.0.0.1:47321/log ──► WebStorm plugin
```

| Folder | What it is |
|---|---|
| `webstorm/` | The WebStorm plugin (Java, built with plain `javac`) |
| `js/` | The `inline-console` npm package: Vite plugin (`inline-console/vite`), Next.js wrapper (`inline-console/next`) and Node preload (`inline-console/register`) |

## 1. Install the WebStorm plugin

```powershell
.\webstorm\build.ps1            # finds your WebStorm install; or pass -Ide "<path to WebStorm>"
```

Then in WebStorm 2026.2: **Settings → Plugins → ⚙ → Install Plugin from Disk…** → `webstorm\build\inline-console.zip`, and restart. Open **View → Tool Windows → Inline Console**: its first line says whether the server is listening on `127.0.0.1:47321`.

## 2. Install the npm package in your app

Not needed for Vite or Next.js with auto-connect (steps 3 and 4). For Node, for the manual setups, and until the package is published to a registry, install it as a real copy:

```bash
cd js && npm pack                              # creates inline-console-<version>.tgz
cd <your app> && npm i -D <path>/inline-console-<version>.tgz
```

## 3. Browser apps on Vite

**Zero-config (default).** Nothing to install or add: open the project in WebStorm and (re)start the dev server. The terminal says `● connected to WebStorm … · vite (auto)` and the tab says `ℹ Auto-connect: hooked node_modules/vite/bin/vite.js`.

How it works:

- **The entry line.** The plugin adds one marked line at the top of the project's Vite entry: `node_modules/vite/bin/vite.js`, or `node_modules/vite/dist/vite/bin/vite.js` for Vite+ (`vp dev`). It works the same way however the dev server starts: terminal, run configuration, or a script that spawns it. Console Ninja does the same kind of entry-file patch.

  ```js
  /* inline-console:auto */ try { await import("file:///…/plugins/inline-console/js/auto.mjs"); } catch {} /* inline-console:auto-end */
  ```

- **The config hook.** Inside the Vite process, that module hooks the moment Vite loads its config and adds `inlineConsole()` to the plugins **in memory**. `vite.config` is never touched. `vite build` and `vite preview` are left alone.
- **Re-checks.** The line is checked every 10 s, so it comes back after `npm install` replaces `node_modules/vite`.
- **Turning it off.** Click the ⚡ **Auto-Connect Vite and Next.js** toggle in the tab's toolbar: the line is removed from every open project. Or set `INLINE_CONSOLE_AUTO=0` for a single run.
- **Safe if the plugin goes away.** If you uninstall the plugin, the line stays behind but does nothing: the import fails inside `try`, and Vite starts as usual. Turn the toggle off before uninstalling to remove it, or reinstall `vite`.

Limits:

- Only the project root's `node_modules` is hooked. In a monorepo with per-app installs, use the manual setup below.
- Node needs 18.19+ or 20.6+ to hook config loading. On older versions the terminal says why and Vite runs unchanged.

**Manual setup** (for teammates without the plugin's auto-connect, or for Vite outside the project root). Add the plugin to `vite.config.js`. It only runs on the dev server (`apply: 'serve'`), so build output is untouched. Using both is fine: only one copy runs.

```js
import { defineConfig } from "vite";
import inlineConsole from "inline-console/vite";

export default defineConfig({
    plugins: [inlineConsole(), /* your other plugins */],
});
```

Run your dev server as usual. Values from the browser travel over Vite's own HMR websocket to the dev server, which forwards them to WebStorm. So it also works inside desktop webviews (Tauri, Electron) without any CSP or CORS changes.

## 4. Next.js (webpack or Turbopack)

Tested on a throwaway Next.js 16 App Router app, with both Turbopack and `--webpack`. Not yet tried on a real app.

**Zero-config (default).** Same as Vite: open the project in WebStorm and (re)start `next dev`. The terminal says `● connected to WebStorm … · next.js (auto)`.

How it works:

- **The entry line.** The plugin adds one marked line to `node_modules/next/dist/bin/next`, just after its `"use strict"`. That file is CommonJS, so the line uses `require(…)` instead of `import()`. It loads `js/auto-next.cjs`.
- **A copy inside the app.** In the `next` process, `auto-next.cjs` copies the package into the app's `node_modules/inline-console`, with a `.inline-console-auto` marker file:
  - Turbopack only loads loaders and modules from inside the project.
  - Rewritten files import `inline-console/runtime`.

  A copy you installed yourself, without the marker, is used as is and never overwritten. `npm install` may delete our copy; it comes back on the next `next dev` start or dev-server restart.
- **The config hook.** `next dev` forks a separate dev server process. Only that one process gets `--require` of the copy, not every child. It hooks the moment Next loads `next.config` (`.ts`, `.mjs` or `.js`) and wraps it with `withInlineConsole()` **in memory**. `next.config` is never touched.
- **What's left alone:** `next build`, `next start`, and runs with `INLINE_CONSOLE_AUTO=0`.
- **Both setups at once:** if `next.config` already uses `withInlineConsole()`, only that one runs; nothing is rewritten twice.

Limits:

- Run `next dev` from the app's folder: `next dev <dir>` from elsewhere isn't hooked.
- Only the project root's `node_modules/next` is hooked.

**Manual setup.** With the package installed, wrap the config. It only activates for `next dev`; builds are untouched:

```js
// next.config.mjs
import withInlineConsole from "inline-console/next";

export default withInlineConsole({
    // your existing config (an object or a (phase) => config function)
});
```

How it works:

- **Loader.** A loader runs on your original source before SWC and tags each `console.*` call with its file:line. It's added to webpack as a `pre` rule and to Turbopack as `turbopack.rules` (`experimental.turbo` on Next 15.0–15.2).
- **Runtime per bundle.** Each rewritten file imports `inline-console/runtime`, and the package's export conditions pick the runtime:
  - **Browser code:** posts straight to WebStorm on `127.0.0.1:47321`, as a plain-text request that needs no CORS setup.
  - **Server code** (server components, API routes, SSR): uses the same runtime as the Node preload, so no `NODE_OPTIONS` is needed.
  - **Edge code** (middleware): left alone; edge has no Node APIs to send with.

For the manual setup, install it as a real copy (step 2): Turbopack may refuse a symlinked `file:` install outside the project root.

Known gaps:
- Uncaught browser errors arrive without a file:line (they show in the tool window with their stack).
- A Turbopack rule you already have for the same extension (e.g. `*.tsx`) takes precedence; a warning is printed.
- Opening the app via a LAN IP instead of `localhost` can make Chrome block the request to `127.0.0.1`.

## 5. Node apps (Express, scripts, tsx)

Preload the hook:

```bash
node --require inline-console/register server.js
```

Or set it once for a terminal or a WebStorm run configuration's environment:

```bash
NODE_OPTIONS="--require inline-console/register"
```

Line numbers come from the call stack, so TypeScript needs source maps on (`tsx`, `ts-node`, or `node --enable-source-maps`).

## Good to know

- **Status in your dev terminal:** a colored `Inline Console` line shows whether the dev server reached WebStorm:
  - `● connected to WebStorm on 127.0.0.1:47321 · vite`
  - `○ WebStorm isn't listening …`
  - `○ lost WebStorm …`

  It prints only when that state changes, once per terminal, so `npm` → `node` won't repeat it. Set `NO_COLOR` for plain text, or `FORCE_COLOR=1` to keep colors in piped output.
- **Port:** the default is `47321`. Set `INLINE_CONSOLE_PORT` for both WebStorm and the app to change it.
- **WebStorm not running:** entries are dropped silently, and the app is never slowed down or broken.
- **Editing a file** clears its inline values, because lines shift. They come back the next time the code runs (HMR).
- **Repeated lines:** a line that logs repeatedly shows the latest value and a `×N` count. The tool window keeps every entry (the last 5000).
- **Full values:** hover (or click) the value at the end of a line to open its last 50 values, newest first. Objects show as pretty JSON with highlighting and folding. **Copy** copies the selected value and **Copy all** copies every one. Each argument is captured up to 100,000 characters, and arrays and objects up to 1,000 items.
- **Not covered yet:** `.vue` / `.svelte` files. In browser DevTools, the column (not the line) of a rewritten `console` call can be off by the length of the inserted prefix.

## Your app is never at risk

A failure inside Inline Console never breaks, freezes or changes your app:

- **Rewritten calls can't throw.** `console.log(...__icAt(file, line), x)` uses a function that never throws and always returns `[]`. If our runtime is missing entirely, `?.` / `??` make the call a plain `console.log(x)`.
- **Your console call always runs,** even when capturing its value fails. Console methods that don't exist are left alone.
- **Getters are never run.** Logging an object shows accessors as `[Getter]`, so lazy-loading or tracking getters don't fire just because you logged.
- **No freezes or leaks:**
  - capture is cut off at 12 levels deep and 20,000 values per argument
  - a `toJSON()` that logs can't loop back into the capture
  - entries waiting for a connection are capped at 1,000
- **Builds never fail because of us:**
  - Vite re-parses every file it rewrites and serves the original if the rewrite would break it
  - the Next.js loader skips files (and says why) when the app can't resolve the package
- **You still find out:** each problem prints once as `[inline-console] … Your app is unaffected.` in the browser console (or stderr for Node), and goes to the WebStorm tab.

## When nothing shows up

Inline Console never crashes your app or the IDE on its own account. Every failure is caught, the original code or `console` call still runs, and the reason lands in the **Inline Console** tab:

- **The tab's title** says the state:
  - `waiting for a dev server`
  - `vite connected` / `next.js connected`
  - `not listening` (the port is taken; the tab says what to do)
- **`● … connected from <folder> (pid …)`** lines show each dev server or script that reached WebStorm. If yours never appears, check the dev terminal for the `Inline Console` status line.
- **`⚠ Inline Console problem: …`** lines give the reason something didn't work. Examples:
  - a file left untouched because rewriting it would break its syntax
  - a value that couldn't be captured
  - a batch WebStorm couldn't read

  Each message shows up to 3 times; everything also goes to `idea.log`.

## Develop

```bash
cd js && node test.cjs          # rewriter, serializer, source maps, browser client, Next loader + config, auto-connect
```

`build.ps1` also runs the plugin's own self-check: the add, replace and remove logic for the auto-connect line.
