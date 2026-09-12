# dshpluginsdev

DeepSeek Harness (DSH) **web** plugins, by [DIV7NE](https://github.com/DIV7NE).

Each plugin is a self-contained package in this repository. Every one of them
declares its own bundle patch, so installing a single directory is enough — the
DSH CLI appends it to the profile's bundle stack and no profile file is edited by
hand.

| Plugin | What it does |
|---|---|
| [`dsh-suggest-next-prompt/`](dsh-suggest-next-prompt/) | Puts a model-generated next prompt in the chat composer's placeholder. `Tab` pastes it, `↑`/`↓` cycle the shortlist, `Esc` dismisses. |
| [`dsh-chrome-agent/`](dsh-chrome-agent/) | Drives your real, already logged-in Chrome through a pinned companion extension, instead of a separate browser profile. |
| [dsh-run-in-terminal](#dsh-run-in-terminal) | A **Run** button on every chat code block, and an integrated terminal in the right sidebar to run it in. |

## Installing a plugin

```sh
git clone https://github.com/DIV7NE/dshpluginsdev
cd dshpluginsdev/<plugin>
npm install
npm run install:profile      # builds, packs, and installs into the web profile
```

Then **restart the DSH server for that profile** — a profile's bundle stack and
the browser's client-module graph are both composed at boot, so a new plugin
cannot appear in a running server. Once a plugin is in the graph, later changes
need only a page reload.

## The Chrome extension

`dsh-chrome-agent` ships two artifacts from one directory, and they are released
separately:

- the **DSH plugin** (this repository's package, installed like its siblings);
- the **Chrome extension**, a plain folder under `dsh-chrome-agent/extension/`
  packed by `scripts/pack-webstore.mjs` into a root-level zip, which is the
  artifact the Chrome Web Store uploads. It is built and attached to Releases,
  not published through the DSH plugin channel.

`npm run pack:webstore` in that directory regenerates the zip. CI runs it and
asserts the zip still contains `manifest.json` at its root, because the plugin's
own tests would not notice a broken packer.

## Repository layout

```
<plugin>/            one self-contained DSH plugin package
  src/               source
  lib/               committed build output (see below)
  cordis.patch.yml   the bundle patch that installs it
  test/              hermetic tests, plus a non-hermetic live probe
  README.md          what it does, how to configure it, its permissions and risks
docs/superpowers/    design, plan, and implementation notes
```

**Why `lib/` is committed.** A DSH plugin may not run a `prepare` or `postinstall`
script, so nothing may build it at install time. The build output therefore ships
in the repository, unminified. CI fails if it drifts from `src/`.

## Development

```sh
cd <plugin>
npm run build        # esbuild
npm run typecheck    # tsc --noEmit
npm test             # node:test — hermetic
npm run install:profile
```

`npm run build && npm run typecheck && npm test` is the same gate CI runs.

## Release status

Both plugins pass the DSH-Store fixed-source precheck. Submission issues:

| Plugin | Issue | Precheck |
|---|---|---|
| `dsh-suggest-next-prompt` | [#778](https://github.com/AI-Scarlett/DSH-Store/issues/778) | passed, 1 warning |
| `dsh-run-in-terminal` | [#779](https://github.com/AI-Scarlett/DSH-Store/issues/779) | passed, 2 warnings, partial scan |

The precheck is a bounded static read of the pinned commit. It is **not** a
security audit, not a runtime verification, and not an automatic listing — the
Catalog gate that follows re-pins the source and applies stricter licence,
dependency, lifecycle, bundle and runtime-source checks before anything appears
in the store.

Two known constraints, stated rather than hidden:

- **`scripts/install-profile.mjs`** in each plugin invokes `npm`, `npm pack` and
  the `dsh` CLI through `child_process` so that a rebuild-and-reinstall is one
  command. Both plugins' prechecks flag it. It is a local development helper: it
  is not in the `files` list, so it is never part of a published package, and no
  runtime code path reaches it. Arguments are fixed strings, not user input.
- **`dsh-run-in-terminal`'s committed browser bundle exceeds the scanner's
  256 KiB per-file limit**, because it inlines xterm. The store reports the scan
  surface as incomplete for that reason. The bundle cannot simply be shrunk —
  inlining is deliberate, since the shell does not seed xterm in its module
  table, and a plugin may not build at install time.

## License

MIT. See [LICENSE](LICENSE).

---

# dsh-run-in-terminal

A DeepSeek Harness **web** plugin that puts a **Run** button on every code
block in the chat and gives you a real terminal to run it in.

A fenced block in a reply grows a `Run` button next to the `Copy` button DSH
already draws. Clicking it opens an integrated terminal in the right sidebar,
pastes the snippet into it, and presses Enter. Right-click inside the terminal
for **Attach selection as context** (plus Copy / Paste / Select all): the
selected output is appended to the conversation draft as a fenced block, ready
to send.

## Install

```sh
cd <this directory>
npm install
npm run install:profile          # builds, packs, and installs into the web profile
```

Then **restart the DSH server for that profile** (`dsh web`) and reload the
page. A restart is required, not optional: the profile's bundle stack and the
browser's client-module graph are both composed at boot, so a new plugin cannot
appear in a running server.

`npm run install:profile` is the whole update loop — run it again after any
source change and restart. It takes a profile name as its first argument
(`node scripts/install-profile.mjs myprofile`, default `web`).

### Why a tarball and not a local link

`dsh plugin --profile web add <directory>` is the usual way to install an
out-of-tree plugin, and on this machine it does not work for a plugin that
lives on a different drive than the profile: pnpm creates the node_modules
junction with the wrong target (`<profile>\\D:\\projects\\dshpluginsdev`,
which resolves to nothing). The launcher then cannot read the package manifest,
never sees `dsh.bundle.patch`, and reports
`declares no dsh.bundle — installed as a plain dependency, not a profile layer`.
`scripts/install-profile.mjs` works around it by installing from an npm
tarball, which pnpm materialises as a real directory; the bundle then
reconciles correctly (verified: `dsh-run-in-terminal` is appended to
`dsh.profile.bundles`).

## What each half does

| File | Role |
|---|---|
| `src/index.ts` | Host half: one persistent pty per session, served over `GET /runterm/pty` (WebSocket), behind a browser-trust fence. |
| `src/client/index.tsx` | Registers the `runterminal` right-Sidebar page type and the code-block button pass. |
| `src/client/code-run.ts` | Watches the transcript for `.md-code-block` nodes and attaches the Run button. |
| `src/client/terminal-view.tsx` | The xterm pane, its socket, and the right-click menu. |
| `src/client/draft.ts` | Appends a terminal selection to the composer draft through the conversation service. |
| `scripts/build.mjs` | esbuild: the node bundle, and the browser bundle wrapped in the `window.__ModuleLoader__.load` boilerplate. |

## How the Run button reaches the shell

`openTab('runterminal', { params: { run } })` acts on the session whose
conversation is on screen and deduplicates by kind, so the click either creates
the terminal or re-navigates the one already open. The tab body watches
`navigation.revision`, writes the snippet to the pty as `{t:'run', code}`, and
the **host** turns a snippet into shell input:

- line endings become CR (a terminal sends Enter as CR) with one final CR to
  submit, so a backslash-continued command — the shape long commands take in
  chat code blocks — runs exactly as written;
- trailing blank lines are dropped, so a snippet that already ends in a newline
  does not submit an extra empty command.

Framing lives on the host deliberately: the bytes the shell reads have one
authority, and that is the part covered by `npm test`.

The code text itself is read back as `textContent` of the block's content
node. DSH draws line numbers with a CSS counter, never as DOM text, so this is
the exact snippet and not a numbered copy of it.

## Security

The route spawns processes, so every request passes a browser-trust fence
before it can reach one — the same fence the shipped `/api` gateway applies to
its own routes:

- the `Host` header must name a loopback authority (a name that merely
  resolves here from elsewhere is a DNS-rebinding attempt);
- a request a browser marks `Sec-Fetch-Site: cross-site` is refused;
- an `Origin`, when present, must name the same hostname.

This is a DNS-rebinding / cross-site defense, **not authentication**. It does
not distinguish one loopback page from another: a page served from the same
hostname on a different port shares the hostname and passes. If you bind DSH to
a non-loopback address, this route is exposed with everything else.

The pty starts in the session's workspace root when the client knows it, and in
the server's own working directory otherwise; a requested directory that is not
an existing directory is ignored.

## Configuration

Add `config.shell` to the plugin row to choose the shell:

```yaml
- id: run-in-terminal
  name: 'dsh-run-in-terminal'
  config:
    shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
```

The default is `pwsh.exe` on Windows when it is on `PATH` (`powershell.exe`
otherwise), and `$SHELL` — else `/bin/bash` — on POSIX, started as a login
shell.

## Known limitations

- One terminal per conversation session, keyed by session id. Closing the tab
  ends the process; hiding or switching away from it does not.
- A multi-line snippet is submitted line by line, so a shell control block
  (`for … do … done`, `if … { }`) run from a chat code block needs its
  continuation characters — the same as pasting into a terminal that lacks
  bracketed-paste support.
- The pane lives in DSH's native right Sidebar under its own kind
  (`runterminal`). It does not reuse and does not collide with the `terminal`
  kind that other sidebar plugins register.
- Strings are English-only; the plugin registers no locale namespace.

## Development

```sh
npm run build          # esbuild: lib/index.js + the wrapped lib/client.js
npm run typecheck      # tsc --noEmit
npm test               # node --test test/host.test.mjs   (hermetic)
npm run install:profile
```

The hermetic suite covers the byte framing, the transcript bound, shell
resolution, and the trust fence.

`test/live-probe.mjs` is the non-hermetic companion: point it at a running
server that has this plugin loaded and it asserts a same-origin handshake is
accepted, a Run frame round-trips through a real shell, and a foreign `Origin`
is refused.

```sh
node test/live-probe.mjs http://127.0.0.1:3080 probe
```

Browser bundle details: `react` and `@deepseek-ai/*` stay external (the shell
seeds them in its frozen module table), while xterm and its fit addon are
inlined, so the bundle needs no `dsh.client.external` entry.