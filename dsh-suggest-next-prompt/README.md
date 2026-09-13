# dsh-suggest-next-prompt

A DeepSeek Harness **web** plugin that puts a model-generated next prompt in the
chat composer's placeholder. Press **Tab** to cycle the shortlist, **Enter** to
paste the highlighted one into your draft.

The suggestion is drawn from the turn that just settled, so it reacts to what the
agent actually did: a next concrete action, a short reply like "yes, go ahead" or
"no, do it the lazy way", or a better alternative to the path the agent just took.

## What it does

When an assistant turn finishes, and the composer is empty, the plugin asks the
host for up to three candidate next prompts and shows the first where the
placeholder normally reads "Message or run a task". With more than one candidate
the position rides the placeholder text as a `1/3 ·` prefix — the same surface, so
nothing is ever positioned over the composer's own controls.

| Gesture | Effect |
|---|---|
| `Tab` | paste the highlighted candidate into the draft |
| `↑` / `↓` | cycle through the shortlist |
| `Escape` | dismiss until the next turn settles |

**Enter is deliberately not claimed by the plugin.** It keeps its normal meaning
throughout, so there is no binding that could send a message you did not mean to
send. Tab fills the draft and stops; you press Enter yourself to submit.

**Accepting does not consume the suggestion.** Paste it with Tab, delete the
text again, and the suggestion is still there to paste a second time. Only
Escape dismisses it, and only a new turn replaces it.

**It waits for your turn.** A suggestion only appears once a reply has actually
landed: the newest turn in the session must carry a completed response. A session
reporting itself idle between steps is not enough, because the turn that is still
open has no response yet.

**One generation per turn.** A suggestion belongs to a turn, not to a moment. It
is generated once when that turn finishes and then held, so it never changes
under you while you are reading it or deciding. The next suggestion arrives only
when the next turn finishes.

Tab accepts rather than cycles because a one-candidate suggestion would otherwise
make Tab a silent no-op, which reads as a broken feature rather than as a
shortlist of one. Shift+Tab is left to the browser.

The suggestion disappears the moment you type, when the agent is running, and
whenever no candidate survives validation — in which case the stock placeholder
returns.

## Install

```sh
cd <this directory>
npm install
npm run install:profile          # builds, packs, and installs into the web profile
```

Then **restart the DSH server for that profile** (`dsh web`) and reload the page.
A restart is required, not optional: the profile's bundle stack and the browser's
client-module graph are both composed at boot, so a new plugin cannot appear in a
running server.

`npm run install:profile` is the whole update loop — run it again after any source
change and restart. It takes a profile name as its first argument
(`node scripts/install-profile.mjs myprofile`, default `web`).

### Why a tarball and not a local link

The install goes through `npm pack` and `dsh plugin add <tarball>` rather than a
local directory link, because pnpm mis-creates the directory junction for a
cross-drive local dependency in this profile layout. A tarball installs as a real
directory and the bundle reconciles correctly. This mirrors the sibling
`dsh-run-in-terminal` plugin, where the failure was diagnosed.

## Configuration

The plugin works with **no configuration** when the session has a model selected:
it reads the route that session's next request would use. To pin a route instead,
add it to the bundle row:

```yaml
- insert:
    - id: suggest-next-prompt
      name: 'dsh-suggest-next-prompt'
      config:
        provider: deepseek
        model: deepseek-chat
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch; when false the route is never registered |
| `provider` / `model` | unset | explicit route override; supplied together or not at all |
| `maxCandidates` | 3 | shortlist length, clamped to 1–3 |
| `timeoutMs` | 8000 | hard deadline per generation, clamped to 500–30000 |
| `maxOutputTokens` | 400 | auxiliary output cap, clamped to 32–2000 |
| `reasoningEffort` | `off` | adapter-owned reasoning effort; `off` disables thinking for this call |

The route ladder is: the plugin's configured pair, then the session's own
projected route, then nothing. When neither is available the plugin generates
nothing and shows the stock placeholder — it will not silently default to a model
you did not choose.

## Permissions

This is the section that matters most, so it is stated plainly.

- **Network: one route, loopback only.** `POST /suggestnext/next`, registered on
  the harness web server. Every request passes the same browser-trust fence the
  shipped `/api` gateway applies to its own routes: the `Host` header must name a
  loopback authority, a request a browser marks `Sec-Fetch-Site: cross-site` is
  refused, and an `Origin`, when present, must name the same hostname.
- **This fence is a DNS-rebinding and cross-site defense, NOT authentication.**
  It does not distinguish one loopback page from another: a page served from the
  same hostname on a different port shares the hostname and passes. If you bind
  DSH to a non-loopback address, this route is exposed with everything else.
- **Model spend: one auxiliary call per completed turn.** The route calls
  `ctx.llm.stream` once, with the session's own route by default, and caps the
  visible output at `maxOutputTokens`. There is no per-session budget in this
  version; the guards are only "the session is idle", "the composer is empty", and
  "no request is already in flight".
- **Every call is recorded in the session log as `session/suggest-llm-request`**,
  carrying the route, the output cap, the finish reason, the candidate count, and
  the provider's token accounting. This is the only accounting these calls get:
  the harness tracks the agent loop's requests and nothing else, so without the
  record the cost is real and invisible. Recording never fails the route — if the
  session cannot be written, the suggestion is still returned.
- **Thinking is disabled for the auxiliary call.** `GenerateOptions.purpose` is a
  closed union of `'compaction' | 'session-title'`, and this plugin cannot claim
  either value without misreporting its own request in the session log. It sets
  `reasoningEffort: 'off'` instead, which the DeepSeek adapter maps to
  thinking-disabled — verified live: without it, the reasoning pass consumed the
  whole output budget and the call returned no visible text at all. The effort is
  configurable, but a value the route's adapter rejects fails the call terminally
  and the plugin stays silent.
- **File access: none.** The plugin reads no file, writes no file, and touches no
  directory.
- **Process access: none.** No subprocess, no shell, no dynamic code evaluation.
- **Runtime dependencies: none.** `package.json` declares no `dependencies` at
  all, and no lifecycle script (`preinstall` / `install` / `postinstall` /
  `prepare`) runs on install. `lib/` is committed.
- **What is sent to the host:** the session id, at most 12 transcript messages,
  and the session's model route. The transcript is not full text — see the
  limitation below.

## Known limitations and risks

- **The placeholder is a private DOM contract.** DSH renders the composer
  placeholder as `<div data-composer-placeholder>`. There is no placeholder-provider
  extension point, so the plugin writes that node's `textContent` directly. React
  re-writes the node whenever the shell's own placeholder text changes (toggling
  plan mode, for example), so the plugin re-asserts on every render. The coupling
  is confined to one module, `src/client/placeholder.ts`, behind one function; if
  DSH ever ships a placeholder-provider slot, the write moves there and nothing
  else changes.
- **Tab and Enter are intercepted** while a suggestion is visible and the draft is
  empty, through one capture-phase listener on the composer input's ancestor. The
  shipped composer keymap does not claim Tab, so nothing is shadowed — but a
  future shell change that claims Tab would collide here.
- **The transcript is bounded previews, not full text.** It comes from the
  `turnOutline` session projection: one line per human prompt and up to three
  lines per response. That is a deliberate trade for cheapness and focus, and it
  is a ceiling on suggestion quality on long tool-heavy turns.
- **Suggestions can be wrong or generic.** Nothing is submitted without a
  deliberate second Enter.
- **English only.** The plugin registers no locale namespace, so it adds no UI
  copy to any dictionary and does not follow a locale switch.
- **Build output is committed and unminified**, so a source review sees exactly
  what runs.

## Development

```sh
npm run build          # esbuild: lib/index.js, lib/protocol.js, lib/placeholder.js, lib/client.js
npm run typecheck      # tsc --noEmit
npm test               # node --test test/*.test.mjs   (hermetic)
npm run install:profile
```

The hermetic suite covers the wire contract: the trust fence accept/reject matrix,
request validation including the byte ceiling, candidate sanitation (multi-line,
over-cap, control characters, unknown `/command`, duplicates), prompt framing, the
route's failure behaviour, the placeholder write, and the composer key decision
table.

`test/live-probe.mjs` is the non-hermetic companion: point it at a running server
that has this plugin loaded and it asserts the route is mounted, a same-origin
request is admitted, a foreign `Origin` is refused, a non-POST is refused, and an
oversized body is refused.

```sh
node test/live-probe.mjs http://127.0.0.1:3080
```

A `405` on every line means the plugin row is not loaded — check
`dsh --profile web --dump-config` and restart the server before looking anywhere
else.

Browser bundle details: `react` and `@deepseek-ai/*` stay external (the shell seeds
them in its frozen module table), while everything else is inlined, so the bundle
needs no `dsh.client.external` entry.

## License

MIT. See `LICENSE`.
