# Inline Console for WebStorm

See your `console.log` values **right next to the line that logged them**, inside WebStorm. Free and open source (MIT).

Console Ninja only works in VS Code, so WebStorm users ended up running two editors. This plugin brings the same idea to WebStorm. It's written from scratch.

> ⭐ **If this saves you time, please star the repo.** It helps other WebStorm users find it.
> Ideas, bug reports and pull requests are very welcome. See [Contributing](#contributing).

## What you get

- **Values inline.** `console.log`, `info`, `warn`, `error` and `debug` values show at the end of their line. A line that runs often shows its latest value and a `×N` count.
- **Full values on hover.** Hover a value to see its last 50 values in full, with pretty JSON. Use **Copy** for one value or **Copy all** for every one. Remove a value with its **×** (or the Delete key), or all of the line's values with **Clear line**.
- **A log window.** The **Inline Console** tool window lists every entry with a clickable `file:line`.
- **Errors where they happen.** Uncaught errors show on the line that threw.

| Your app | Setup needed |
|---|---|
| Vite (React, Vue, …), including Vite+ | **None.** It connects automatically |
| Next.js (Turbopack or webpack) | **None.** It connects automatically |
| Node (Express, scripts) | One flag. See [Node apps](#node-apps) |

## Install

You need WebStorm 2026.2 or newer.

**1. Get the plugin zip**

Download `inline-console-<version>.zip` from the [Releases](https://github.com/anuragpindoriya/inline-console/releases) page.

<details>
<summary>Or build it yourself (JDK 25, Windows PowerShell)</summary>

```powershell
.\webstorm\build.ps1
```

This creates `webstorm\build\inline-console.zip`. The script finds your WebStorm by itself. If it can't, pass the folder: `.\webstorm\build.ps1 -Ide "C:\Program Files\JetBrains\WebStorm 2026.2"`.

</details>

**2. Install it in WebStorm**

**Settings → Plugins → ⚙ → Install Plugin from Disk…** → pick the zip → restart WebStorm.

**3. Run your app**

Open your project in WebStorm and start your dev server as usual (`npm run dev`). The terminal shows:

```
[Inline Console] ● connected to WebStorm on 127.0.0.1:47321 · vite (auto)
```

Open the app in the browser, and values appear next to your code. That's all you need for Vite and Next.js.

## Node apps

Node needs the npm package. It isn't on npm yet, so build it from this repo:

```bash
cd js && npm pack                                  # creates inline-console-0.1.0.tgz
cd <your app> && npm i -D <path>/inline-console-0.1.0.tgz
```

Then start your app with the preload:

```bash
node --require inline-console/register server.js
```

Or set `NODE_OPTIONS=--require inline-console/register` in a WebStorm run configuration. For TypeScript, keep source maps on (`tsx`, `ts-node`, or `node --enable-source-maps`) so line numbers match.

## Nothing showing up?

Look at the **Inline Console** tab first. Its title tells you the state:

| Tab title | What to do |
|---|---|
| `waiting for a dev server` | Restart the dev server after installing the plugin, then open the app so some `console.log` calls run |
| `vite (auto) connected`, `next.js (auto) connected`, … | It's working. Run the code that logs |
| `not listening` | Another program is using port 47321. Close it, or set `INLINE_CONSOLE_PORT` for both WebStorm and the app |

Also check:

- **Start the dev server from the project folder.** Auto-connect only hooks the project root's `node_modules`. For a monorepo app in a subfolder, use the [manual setup](#manual-setup-optional).
- **Lines marked `⚠ Inline Console problem`** in the tab explain anything that went wrong.

## Manual setup (optional)

Use this when auto-connect can't reach your app (a monorepo, `next dev <dir>`), or for teammates who don't have the plugin. Install the npm package as shown in [Node apps](#node-apps), then add one line to your config. Using it together with auto-connect is fine: only one copy runs.

```js
// vite.config.js
import inlineConsole from "inline-console/vite";

export default defineConfig({
    plugins: [inlineConsole(), /* your other plugins */],
});
```

```js
// next.config.mjs
import withInlineConsole from "inline-console/next";

export default withInlineConsole({
    /* your existing config */
});
```

## How it works

- **Auto-connect.** The plugin adds one marked line to the entry file of Vite (`node_modules/vite/…/bin/vite.js`) or Next.js (`node_modules/next/dist/bin/next`). When the dev server starts, that line adds Inline Console to your config **in memory**. Your `vite.config` / `next.config` is never edited.
- **Rewriting calls.** While serving your code, the dev server tags each `console.*` call with its file and line. The values travel to WebStorm on `127.0.0.1:47321`, and only on your machine.
- **Dev only.** `vite build` and `next build` are never touched.
- **Turning it off.** Click the ⚡ toggle in the Inline Console tab to remove the line from your projects, or set `INLINE_CONSOLE_AUTO=0` for one run.

## Your app is safe

A failure inside Inline Console never breaks, freezes or changes your app:

- **Your `console.log` always runs,** even if capturing its value fails.
- **No surprise side effects.** Getters on logged objects are never called, and huge or circular values are cut off.
- **Files are never broken.** A file that can't be rewritten safely is served untouched.
- **Nothing breaks when WebStorm is closed.** Logs are simply dropped.
- **Removing the plugin is safe.** The auto-connect line fails quietly, and your dev server runs as usual.

## Limits

- `.vue` and `.svelte` files aren't rewritten yet; `.js`, `.jsx`, `.ts` and `.tsx` are.
- Next.js support has been tested on a fresh Next.js 16 app, not yet on a large real project.
- Auto-connect needs Node 18.19+ or 20.6+.

## Contributing

Contributions are welcome, big or small:

- **Issues:** report a bug (include the lines from the Inline Console tab) or suggest an idea.
- **Pull requests:** fixes, docs, new framework support.
- **Good first areas:**
  - `.vue` / `.svelte` support
  - a Gradle build and JetBrains Marketplace publishing
  - a build script for macOS and Linux
  - more frameworks (Nuxt, Remix, Astro)

To work on it:

```bash
cd js && node test.cjs          # self-checks for the npm package (prints "ok")
```

```powershell
.\webstorm\build.ps1            # builds the plugin and runs its self-check
```

| Folder | What's inside |
|---|---|
| `webstorm/` | The WebStorm plugin (Java) |
| `js/` | The `inline-console` npm package: Vite plugin, Next.js wrapper, Node preload, auto-connect |
| `.github/workflows/` | The build that runs on GitHub |

**Builds and releases.** Every push to `main` builds the plugin on GitHub Actions. The zip is kept on the run's page under **Artifacts**; unzip the download once to get the plugin zip. To publish a release:

1. Go to **Actions → Build plugin → Run workflow**.
2. Enter a version, for example `0.2.0`.
3. After a successful build, the workflow commits that version, tags it `v0.2.0`, and publishes a release with the zip attached.

## Support the project

- ⭐ **Star this repo.** It's the easiest way to help.
- Share it with a WebStorm user who still keeps VS Code open just for Console Ninja.

## License

[MIT](LICENSE)
