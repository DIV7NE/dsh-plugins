# dsh-suggest-next-prompt — Design

**Date:** 2026-09-12
**Status:** Approved for planning
**Package:** `dsh-suggest-next-prompt` (entry id `suggest-next-prompt`)
**Location:** `dshpluginsdev/dsh-suggest-next-prompt/` (sibling of the root `dsh-run-in-terminal` package)

## 1. Context

DSH's web composer shows a fixed locale placeholder. There is no way for a plugin
to say what the user should send next.

This plugin makes the composer placeholder carry a model-generated next prompt,
drawn from the turn that just settled. `Tab` cycles the shortlist, `Enter` pastes
the highlighted candidate into the draft. The point is that a good next path is
always one keystroke away instead of something the user has to think up.

## 2. Goal

After an assistant turn settles, with an empty composer, the placeholder shows the
most useful next prompt for that conversation. Accepting it never submits; it only
fills the draft.

### Acceptance criteria

1. With an empty composer on an idle session, the placeholder text is a generated
   candidate, not `placeholder.default`.
2. `Tab` advances the shortlist cyclically; `Shift+Tab` steps back; a visible
   `n/N` stepper reflects position.
3. `Enter` with an empty draft and a visible candidate fills the draft with it and
   does **not** submit the message.
4. `Escape` dismisses the suggestion until the next turn settles.
5. Every candidate is a single line, within the character cap, and any
   `/command` it names exists in the live catalog for that session.
6. Any failure produces no visible error; the previous suggestion or the stock
   placeholder remains.
7. The plugin adds no runtime dependency and no lifecycle script.

### Non-goals

- No per-session token budget in v1.
- No rationale or expanded card; candidates are one line only.
- No suggestion surface outside the composer.
- No submission, ever: the plugin only calls `setDraft`.

## 3. Constraints discovered during design

These are facts read from the shipped bundles, not assumptions.

| Constraint | Source |
|---|---|
| No placeholder-provider extension point exists. `placeholder` is an owner prop of `conversation.composer.bar`, supplied by ui-conversation's own shell. | slot catalog; `ComposerBarOwnerProps` |
| The placeholder *is* a real DOM node: `<div data-composer-placeholder>` holding the placeholder text. | ui-conversation `lib/client.js` |
| Its styling is native and free: `position:absolute; inset:4px 8px auto 14px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; pointer-events:none`. A 2-line clamp variant exists. | same |
| `conversation.input.overlay` is `kind:list`, `scope:session`, `replaceRisk:"none"`, rendered inside the composer card. | slot catalog |
| Its standard props include `useInput: SnapshotSelectorHook<InputState>` and `inputActions: InputActions`. | slot catalog |
| The shipped composer keymap handles Enter/space/paste/menu; **Tab is unhandled**. | `input/editor/keymap.d.ts` |
| `ctx.commands.list(agent)` yields the effective descriptors. `ctx.agents.get(sessionId)` yields the Agent. | `dsh-commands`, `dsh-agent` |
| `ctx.llm.stream(options)` is the dispatch face. | `dsh-llm` |
| `SessionSnapshot` has `running` but **no** provider/model. | `dsh-api-session-controller/client/contract/snapshot.d.ts` |
| Client↔host plugin RPC (`ctx.remote`) needs generated Typert artifacts and is unavailable out of tree. A plugin-owned HTTP route is the transport. | `dsh-api-remotes` |

### Marketplace standards applied now

DSH-Store gates listing on a public GitHub repo pinned to a 40-char commit with no
`preinstall`/`install`/`postinstall`/`prepare`, no runtime dependencies for the
auto-approved path, a `dsh.compatibility.dshReleases` matrix, an explicit license,
and a README documenting permissions and risks. Its scan warns on obfuscation, so
build output must not be minified. Listing is deferred, but the code is built to
these standards from the first commit so listing stays a packaging step.

## 4. Architecture

Two halves in one package, installed through a bundle patch — the shape already
proven by `dsh-run-in-terminal`.

```
dsh-suggest-next-prompt/
├── package.json        dsh.bundle.patch, dsh.client{platform:'web'},
│                       dsh.compatibility.dshReleases
├── cordis.patch.yml    insert: [{ id: suggest-next-prompt, name: 'dsh-suggest-next-prompt' }]
├── README.md           purpose / install / config / permissions / risks
├── LICENSE
├── src/
│   ├── index.ts        host half
│   ├── protocol.ts     pure: caps, validation, framing, fence — shared, tested
│   └── client/
│       ├── index.ts       registers the overlay entry
│       ├── suggest.tsx    the overlay component
│       ├── transcript.ts  projection → compact transcript
│       ├── placeholder.ts applySuggestion(node, text) — the one DOM write
│       ├── fetch.ts       POST, abort, in-flight guard
│       ├── styles.ts      injected stylesheet (stepper, ghost reset)
│       └── types.ts       structural mirrors; the package imports no @deepseek-ai/*
├── scripts/build.mjs   esbuild, minify:false → lib/index.js + wrapped lib/client.js
└── test/
    ├── protocol.test.mjs   hermetic
    └── live-probe.mjs      non-hermetic
```

`lib/` is committed. No lifecycle script may build it at install time, so the built
output ships in the repo, unminified.

### Why no `@deepseek-ai/*` imports

The plugin is built and installed out of tree. It mirrors only the faces it reads,
in `src/client/types.ts` and the host half's local interfaces, so the package needs
no upstream type dependency and cannot break on a type-only change. This is the
established convention in `dsh-run-in-terminal`.

## 5. Components

### 5.1 `src/protocol.ts` — the tested core

Pure, zero imports, shared by both halves.

Constants:

| Name | Value | Meaning |
|---|---|---|
| `SUGGEST_PATH` | `/suggestnext/next` | the one route |
| `MAX_CANDIDATES` | 3 | shortlist length |
| `MAX_CANDIDATE_CHARS` | 100 | one-line ceiling |
| `MAX_MESSAGES` | 12 | transcript window |
| `MAX_MESSAGE_BYTES` | 8192 | per message |
| `MAX_BODY_BYTES` | 262144 | whole request body |

These constants are the defaults for the matching config keys in §5.2 and the
host clamps every configured value into their range.

Functions:

- `parseRequest(raw, byteLength) → Request | ProtocolFailure` — rejects an
  over-size body rather than truncating it, rejects unknown fields, non-array
  transcripts, bad roles, non-string text, and per-message overflow.
- `sanitizeCandidates(values, catalogue) → string[]` — drops any value that is
  empty after trim, multi-line, over the character cap, or contains control
  characters; drops any `/token` whose name is absent from `catalogue`; dedupes;
  returns at most `MAX_CANDIDATES`.
- `buildPrompt(request, catalogue) → messages` — the JSON-framed instruction,
  deterministic so the test can assert both framing and the byte ceiling.
- `isTrustedRequest(headers)` — the loopback / `Sec-Fetch-Site` / `Origin` fence,
  ported verbatim from `dsh-run-in-terminal`.

Framing and validation live here because this is where the bytes are read; that
gives the wire contract one authority, covered by `npm test`.

### 5.2 Host half — `src/index.ts`

```ts
export const name = 'suggest-next-prompt'
export const inject = ['webServer', 'llm', 'commands', 'agents']
```

Registers one exact route. Handler order:

1. `isTrustedRequest` → 403 on failure.
2. Read the body with a hard byte cap → 413 when exceeded.
3. `parseRequest` → 400 on failure.
4. `ctx.agents.get(sessionId)` → 404 when there is no such agent.
5. `ctx.commands.list(agent)` → command names for the catalogue.
6. Resolve the route (§5.3).
7. `ctx.llm.stream(...)` once, under one `AbortController` and a hard timeout,
   aborted on client disconnect.
8. Parse the model's JSON array, `sanitizeCandidates`, respond
   `{ candidates: string[] }`.

An empty `candidates` array means "nothing good enough this turn": the client
keeps whatever it currently shows rather than clearing the placeholder. A non-200
status has the same client-side effect.

The host never throws at the browser: every failure becomes a status plus a short
machine-readable body, and the client treats all of them the same way.

Configuration:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch; when false the route is not registered and the client's request simply 404s, which it treats as "no suggestion" |
| `provider` / `model` | unset | explicit route override; must be supplied together |
| `maxCandidates` | 3 | clamped to 1–3 |
| `timeoutMs` | 8000 | hard deadline per generation |
| `maxOutputTokens` | 200 | auxiliary output cap |

### 5.3 Route resolution — the one unresolved seam

`SessionSnapshot` carries `running` but not the session's provider/model, so the
route cannot simply be read on either side without reaching further in.

The ladder, first hit wins:

1. `config.provider` + `config.model`.
2. The session's route as reported by the client, **if** the client can reach it
   from an out-of-tree plugin.
3. Neither available → generate nothing, silently. No assumed default model.

**This is the design's one open risk.** The plan's first task is a bounded probe
that answers whether (2) exists — which client-side service exposes the session's
current route, and whether it is reachable without depending on a private surface
of `dsh-client-ui-model-selection`. If it is not reachable, the ladder collapses
to (1), the README documents that the route must be configured, and that is a
stated downgrade rather than a silent one.

### 5.4 Client half — `src/client/`

`inject = ['slots', 'sessions']`. Registers exactly one
`conversation.input.overlay` entry:

```ts
ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register(
  { name: 'conversation.input.overlay', id: 'suggest-next-prompt', order: 100 },
  SuggestOverlay,
))
```

A fresh id, so it is added beside the shipped entries (`command-popup`,
`slash-menu`, `feedback-dialog`) and replaces none of them.

The component consumes standard props only: `useInput`, `inputActions`,
`useSession`, `sessionId`.

"Empty draft" means empty after trim, matching the shell's own rule for hiding
the native placeholder. "Cycle" means the order the candidates came back in,
wrapping at both ends.

**Trigger.** Watch `useSession(s => s.running)`. On a true→false edge, and only
when the draft is empty and no request is in flight, build a compact transcript
from the projection already on screen and POST. A running session, a non-empty
draft, or a pending request all suppress generation. The client clamps the
transcript to `MAX_MESSAGES` and each message to `MAX_MESSAGE_BYTES` before
sending; the host re-checks both and rejects rather than trusting them.

**Render.** When a candidate exists and the draft is empty, resolve the composer's
`[data-composer-placeholder]` node from our own element's ancestor and set its
`textContent`. Re-assert on every render. The native placeholder styling —
absolute position, nowrap, ellipsis, caption colour, and its own hide-when-nonempty
behaviour — applies unchanged; this plugin styles nothing about it.

A small `n/N` stepper is rendered in the overlay anchor so a shortlist does not
read as a single string.

**Keys.** One capture-phase `keydown` listener on the composer input's ancestor.
Capture on an ancestor is deliberately chosen: at the target node, listeners fire
in registration order, so an ancestor capture listener is the only place guaranteed
to run before Lexical's own handler.

| Key | Condition | Effect |
|---|---|---|
| `Tab` | candidate visible, draft empty | cycle forward, `preventDefault` |
| `Shift+Tab` | same | cycle backward, `preventDefault` |
| `Enter` | candidate visible, draft empty | `inputActions.setDraft(candidate)`, `preventDefault` |
| `Escape` | candidate visible | dismiss until the next settled turn |

## 6. Data flow

```
assistant turn settles
  → client sees running true→false
  → POST /suggestnext/next { sessionId, transcript, route? }
  → fence → body cap → parseRequest
  → ctx.agents.get(sessionId) → ctx.commands.list(agent) → route ladder
  → one ctx.llm.stream call
  → parse → sanitizeCandidates
  → { candidates: [...] }
  → client stores the shortlist, index 0
  → placeholder textContent = candidate
  → Tab cycles
  → Enter → inputActions.setDraft(candidate)
  → ordinary composer submit
  → suggestion cleared
```

## 7. Error handling

Every failure path — DNS/network, 4xx, 5xx, timeout, malformed model output, no
surviving candidate — leaves the previous suggestion in place or shows nothing at
all. No toast and no banner: a suggestion feature that interrupts is worse than no
suggestion feature.

Requests are bounded before they can reach a prompt: over-size bodies are rejected
with 413, per-message overflow with 400, and client-supplied text is capped before
framing. The route sits behind the same loopback fence the shipped `/api` gateway
applies, which is a DNS-rebinding and cross-site defense, **not** authentication —
the README states this plainly.

The plugin never submits. Acceptance is always `inputActions.setDraft`; the user
presses Enter a second time to send.

## 8. Testing

**Hermetic — `test/protocol.test.mjs`.** Framing and byte ceiling;
`parseRequest` accept/reject table including the over-size body and unknown
fields; `sanitizeCandidates` table covering multi-line, over-cap, control
characters, unknown `/command`, duplicates, and the empty result; the
`isTrustedRequest` accept/reject matrix (loopback host, DNS-rebinding host,
`Sec-Fetch-Site: cross-site`, foreign `Origin`, absent `Origin`).

**The DOM write** is isolated behind `applySuggestion(node, text)` and tested
against a fake `{ textContent }`. One function, one assert, no jsdom and no added
devDependency.

**Non-hermetic — `test/live-probe.mjs`**, mirroring the sibling: against a running
server with the plugin loaded, a same-origin request is accepted, a foreign
`Origin` is refused, and a real suggestion round-trips end to end.

**Manual acceptance** on a one-off profile: the seven acceptance criteria in §2,
observed in the browser.

Not covered by automation: the placeholder node's React re-write behaviour, and
the Tab/Enter interception against the live Lexical keymap. Both are covered by the
manual acceptance pass and recorded in the README's known-limitations section.

## 9. Known limitations and accepted couplings

1. **`[data-composer-placeholder]` is a private DOM contract.** React re-writes
   that node whenever the shell's own placeholder text changes (for example
   toggling plan mode), so the write is re-asserted on every render. If DSH adds a
   placeholder-provider slot, the write moves there and nothing else changes.
2. **The DOM coupling is confined to `placeholder.ts`** — one module, one exported
   function, so the eventual replacement is local.
3. **The route may need explicit configuration** (§5.3) if the probe finds no
   reachable client-side seam.
4. **One auxiliary model call per completed turn.** No budget, no debounce beyond
   the running/empty/in-flight guards.
5. **Suggestions can be wrong.** Nothing is submitted without a deliberate Enter.
6. **English-only.** The plugin registers no locale namespace.
7. **Build output is committed and unminified** — a marketplace constraint, not an
   oversight.

## 10. Deferred: marketplace listing

Not part of this work, but the code is built so listing is packaging only:

- `git init` and a public remote for `dshpluginsdev`.
- A catalog entry with `manifestPath` and `installPath` pointing at
  `dsh-suggest-next-prompt/`, pinned to a 40-character commit.
- `dsh.compatibility.dshReleases` filled with real per-version evidence.
- Submission through the marketplace's plugin-submission issue template, which
  runs the fixed-source preflight.
