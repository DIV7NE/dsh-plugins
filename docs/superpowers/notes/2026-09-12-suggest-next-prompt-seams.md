# dsh-suggest-next-prompt — seam record

**Date:** 2026-09-12
**Task:** 1 of docs/superpowers/plans/2026-09-12-suggest-next-prompt.md
**Verdict:** ROUTE_SEAM: client-service

---

## 1. The session route — ROUTE_SEAM: client-service

The route `{ provider, model }` that `ctx.llm.stream(options)` requires is readable
from an out-of-tree browser plugin, through two public faces. Neither is private
and neither needs the session log, so approach B (host reads the durable log) is
not required.

### Path A — from the session binding (preferred: read only, no extra service)

```ts
const binding = ctx.sessions.binding(sessionId)          // SessionBinding | undefined
const face = binding.session.projections.faceOf('modelSelection')
const value = face.getSnapshot() as { next?: ModelSelection | null; lastUsed?: ModelSelection | null } | undefined
```

Verified from:

- `dsh-api-session-controller/lib/types/client/sessions/service.d.ts:312` — `binding(id: SessionId): SessionBinding | undefined`
- `.../service.d.ts:103-110` — `SessionBinding { sessionId, session: SessionFace, eventSource, ctx }`
- `.../contract/session.d.ts:48-56` — `ProjectionsFace.faceOf(key): ObservableSnapshot<unknown>`, "absence is an `undefined` snapshot, never a missing face"
- `.../contract/session.d.ts:61-62` — `ISession.projections: ProjectionsFace`
- `dsh-api-session-controller/lib/types/types.d.ts:90-95` — `ModelSelectionProjection { lastUsed: ModelSelection | null; next: ModelSelection | null }`
- `dsh-api-session-controller/lib/types/types.d.ts:77-81` — `ModelSelection { provider: string; model: string; reasoningEffort?: string }`

`ObservableSnapshot` exposes `getSnapshot()` and `subscribe(listener)`
(`dsh-client-store`), so this is both a one-shot read and a live subscription.
There is no client-side folding involved: the value is the host-computed,
higher-seq-wins projection.

### Path B — the model-selection service (already-loaded UI package)

```ts
const models = ctx.get('modelDirectories')
const directory = models.directoryFor(sessionId)          // throws for an unknown session
const state = directory.store.getSnapshot()                // ModelDirectoryState
const selection = state.current                            // ModelSelection | null
```

Verified from:

- `dsh-client-ui-model-selection/lib/client.js:272` — `super(ctx, "modelDirectories")`, so the service key is exactly `modelDirectories`
- `.../lib/types/client/service.d.ts` — `directoryFor(sessionId: SessionId): ModelDirectory`, "unknown sessions fail loud"
- `.../lib/types/client/directory.d.ts` — `ModelDirectory.store: SnapshotStore<ModelDirectoryState>`, and `ModelDirectoryState.current: ModelSelection | null` documented as "durable next-request projection, then Host default"

### Decision

**Path A is the one to implement.** It reads a projection the shell already
computes for every session that has the model-selection UI mounted, and it needs
no service that this plugin would otherwise not touch. Path B is recorded because
it is a legitimate fallback if `modelSelection` turns out not to be among the
projection keys registered in a given profile — a one-line change at the call
site, and the value shapes are identical (`ModelSelection`).

### What this means for the plan

- The route ladder in the spec (§5.3) keeps all three rungs: `config.provider` +
  `config.model` wins, then the session's own route, then silence. No rung is
  dead.
- The client therefore **does** send the optional `route` field it was already
  allowed to send, and no README line about "you must configure a model" is
  needed as the default path. Task 7's `requestSuggestions` gains the route
  parameter; that is the follow-up named in the plan's self-review.
- `reasoningEffort` is present in the projection but is **not** forwarded:
  `GenerateOptions` has no such field in this version, and the auxiliary call is
  short-output by construction.

---

## 2. The transcript — confirmed: the `turnOutline` session projection

`useProjection('turnOutline')` is a standard prop of a
`conversation.input.overlay` entry, so no private coupling is needed.

```ts
readonly TurnOutlineEntry[] | undefined
interface TurnOutlineEntry {
  readonly turn: number
  readonly seq: SessionSeq
  readonly prompt: string     // bounded first-human-prompt preview, '' until a prompt lands
  readonly response: string   // bounded final-response preview, up to three rail lines, '' until the turn ends
}
```

Verified from `dsh-session-turn-outline/lib/types/types.d.ts` (the declaration
merges `turnOutline` into `SessionProjectionMap`).

Consequences, recorded honestly:

- The transcript is **bounded previews**, not full text. One line per human
  prompt, up to three lines per response. That is a deliberate trade for "what
  should the user say next" — cheaper, and focused on turn substance — but it is
  a ceiling on suggestion quality, and the README says so.
- `undefined` means the projection unit is not mounted (capability absent). That
  is a first-class outcome: no suggestion, no error.
- A client-side replacement for this seam, if it ever proves too thin, is the
  `useChat` snapshot's node order, which carries full assistant text. It is not
  used here: it couples to a second package and is a larger surface for no
  demonstrated benefit yet.

---

## 3. The auxiliary call — confirmed shape

Build `options` exactly as `dsh-session-title-llm` does, which is the working
reference in this deployment:

```ts
{
  provider, model,                     // mandatory strings (dsh-llm/lib/types/types.d.ts:404-407)
  system: prompt.system,
  messages: [{
    id: 'suggest-next-prompt-<n>',
    role: 'user',
    content: [{ type: 'text', text: prompt.user }],
    source: { kind: 'plugin', plugin: 'dsh-suggest-next-prompt' },
  }],
  maxTokens: settings.maxOutputTokens,
  sessionId,
  signal,
}
```

Verified from:

- `dsh-llm/lib/types/types.d.ts:404-443` — `GenerateOptions` with mandatory
  `provider: string` and `model: string`, and optional `system`, `messages`,
  `temperature`, `signal`
- `dsh-llm/lib/types/message.d.ts:120-129` — `Message { id, role, content, source }`
- `dsh-llm/lib/types/message.d.ts:94-104` — `source: { kind: 'plugin', plugin: string }`
- `dsh-llm/lib/types/types.d.ts:359-389` — `StreamChunk`; text arrives as
  `{ type: 'text-delta', index, text }` and ends with `{ type: 'finish', reason }`
- `dsh-session-title-llm/lib/index.js:197-218` — the same construction in shipped
  code, including `createUserMessage`

### Recorded cost characteristic — the auxiliary call may think

`purpose` (`dsh-llm/lib/types/types.d.ts:443`) is a **closed union**:
`'compaction' | 'session-title'`. The DeepSeek adapter maps `session-title` to
thinking-disabled. This plugin cannot claim either value — doing so would misreport
its own request in the session log — so it omits `purpose` and accepts that the
call may spend reasoning tokens before emitting the short JSON array.

The output cap (`maxOutputTokens`, default 200) bounds only the visible answer.
**The real per-turn cost is unknown until measured**, and measuring it is the
first thing to do if the feature feels expensive. This goes in the README's
permissions section.

---

## 3b. As shipped

The client half implements **Path A**, in `src/client/route.ts`:
`ctx.sessions.binding(sessionId).session.projections.faceOf('modelSelection')`,
taking `next` then falling back to `lastUsed`. The value is sent as the optional
`route` field; when it is absent the host falls back to its configured pair, and
when that is absent too it answers 200 with an empty shortlist. All three rungs of
the ladder are live.

Path B (`ctx.modelDirectories`) is not used. It remains the documented fallback if
`modelSelection` turns out not to be registered in some profile shape — a one-line
change in `route.ts`, with identical value shapes.

Task 1's seam hunt also settled two adjacent questions:

- the transcript comes from `useProjection('turnOutline')`, a standard prop, so no
  private coupling was needed for it;
- the auxiliary call shape is the shipped `dsh-session-title-llm` construction,
  verified in that package's built output.

## 3c. Post-implementation findings — three defects only a live call exposed

The hermetic suite (33 tests) passed through all three. None is reachable without a
real adapter, which is a gap in the plan's verification strategy, not bad luck.

### 1. Stream consumption was wrong and silently truncated every reply

The first implementation compared `finish.reason !== 'stop'`. `FinishReason` is a
**discriminated union of objects** (`{ kind: 'stop' }`, `{ kind: 'error', failure }`),
never a bare string — see `dsh-llm/lib/types/types.d.ts:107-127`. The comparison was
therefore always true, and the resulting `return ''` sat **inside** a `for await`
loop, which aborts the iterator and discards every pending chunk. The call drained
one chunk and reported empty text.

The shipped `dsh-session-title-llm` never does this: it drains the whole stream into
a `BlockAssembler`, then reads `finish.kind` and the assembled blocks
(`lib/index.js:228-238`). The fix mirrors that: accumulate per block index from
`text-delta`, let `block-end` overwrite with the assembled block (so a
non-streaming adapter reads correctly), and interpret `kind` only at the end.

### 2. Thinking consumed the entire output budget

`purpose` is a closed union of `'compaction' | 'session-title'`, and the spec
concluded thinking could not be disabled without misreporting the request. True —
but incomplete. `GenerateOptions.reasoningEffort` (`types.d.ts:409`) takes adapter-owned
effort ids, and the DeepSeek adapter maps `'off'` to `{ thinking: 'disabled' }`
(`dsh-llm-deepseek/lib/index.js:26-38`).

Without it, the reasoning pass consumed the whole budget: `finish: 'max-tokens'` with
zero visible text. The shipped default is now `reasoningEffort: 'off'` with
`maxOutputTokens: 400`. **The spec's cost warning was over-pessimistic and the README
has been corrected.**

### 3. The provider name is deployment-specific

The probe assumed `deepseek`; this deployment registers `deepseek-official`
(`agent-default-model` in `settings.yaml`), and the call failed with
`no adapter registered for provider "deepseek"`. The route is read from the session,
so this only affects hand-written probes and a pinned `config.provider`.

## 4. What was NOT verified

- Whether the `modelSelection` projection key is populated in every profile
  shape. Path A can read `undefined` here too, which is why the ladder's third
  rung (silence) exists and why the route field is optional end to end.
- The live behaviour of the placeholder node's React re-write, and the Tab/Enter
  interception against the shipped Lexical keymap. Both are manual-acceptance
  items in Task 8, not automatable without jsdom.
- Real end-to-end suggestion quality. That needs the running plugin and a real
  turn.
