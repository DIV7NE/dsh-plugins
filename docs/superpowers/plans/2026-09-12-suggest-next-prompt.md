# dsh-suggest-next-prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This workspace has no git repository, so each task ends with a Checkpoint step instead of a commit.

**Goal:** Make the DSH web composer's placeholder carry a model-generated next prompt drawn from the turn that just settled, with Tab cycling a shortlist and Enter pasting the highlighted candidate into the draft.

**Architecture:** One out-of-tree bundle package with two halves. The host half owns a single loopback-fenced HTTP route that resolves the session's agent, reads the live slash-command catalog, makes one auxiliary `ctx.llm` call, and returns validated one-line candidates. The browser half registers one `conversation.input.overlay` entry that reads the transcript from the `turnOutline` session projection, writes candidate 0 into the shipped placeholder node, and owns the Tab/Enter keys. A pure `protocol` module is shared by both halves and is where every cap, rejection, and framing rule lives.

**Tech Stack:** TypeScript, Cordis plugin container, React (external, supplied by the shell), Lexical-backed composer (never imported), Node `node:test` for tests, esbuild for the two bundles.

**Spec:** @docs/superpowers/specs/2026-09-12-suggest-next-prompt-design.md

## Global Constraints

- Package name `dsh-suggest-next-prompt`; bundle entry id `suggest-next-prompt`; directory `dsh-suggest-next-prompt/` (sibling of the root `dsh-run-in-terminal` package).
- **Zero runtime dependencies.** No `dependencies` block. No `@deepseek-ai/*` import, value or type. Every host and browser face is mirrored structurally.
- **No `preinstall` / `install` / `postinstall` / `prepare` scripts.** `lib/` is built by `npm run build` and committed. Build output must not be minified.
- Caps, copied verbatim from the spec: `MAX_CANDIDATES = 3`, `MAX_CANDIDATE_CHARS = 100`, `MAX_MESSAGES = 12`, `MAX_MESSAGE_BYTES = 8192`, `MAX_BODY_BYTES = 262144`. Config defaults: `timeoutMs = 8000`, `maxOutputTokens = 200`, `maxCandidates = 3`.
- Route path `/suggestnext/next`, registered `kind: 'exact'`.
- Node >= 20. ESM only (`"type": "module"`).
- **This workspace has no git repository.** Every task ends with a Checkpoint step (build + tests) instead of a commit. Do not run `git init`; the owner explicitly deferred it.
- English only. No locale namespace is registered.
- The plugin never submits. Acceptance is always `inputActions.setDraft(candidate)`.

---

## File Structure

| File | Responsibility |
|---|---|
| `dsh-suggest-next-prompt/package.json` | npm manifest plus the `dsh.bundle` / `dsh.client` / `dsh.compatibility` declarations |
| `dsh-suggest-next-prompt/tsconfig.json` | typecheck only, no emit |
| `dsh-suggest-next-prompt/cordis.patch.yml` | the bundle patch inserting the one plugin row |
| `dsh-suggest-next-prompt/scripts/build.mjs` | esbuild: node bundle and loader-wrapped browser bundle |
| `dsh-suggest-next-prompt/src/protocol.ts` | the wire contract: caps, request validation, candidate sanitation, prompt framing, the trust fence. Pure, no imports |
| `dsh-suggest-next-prompt/src/index.ts` | host half: the route, agent and catalog lookup, the one model call |
| `dsh-suggest-next-prompt/src/client/types.ts` | structural mirrors of every browser face the client half touches |
| `dsh-suggest-next-prompt/src/client/index.ts` | client plugin body: registers the overlay entry |
| `dsh-suggest-next-prompt/src/client/placeholder.ts` | the one DOM write, isolated |
| `dsh-suggest-next-prompt/src/client/transcript.ts` | `turnOutline` projection to the wire transcript |
| `dsh-suggest-next-prompt/src/client/fetch.ts` | POST with abort and the in-flight guard |
| `dsh-suggest-next-prompt/src/client/suggest.tsx` | the overlay component: trigger, render, keys |
| `dsh-suggest-next-prompt/src/client/styles.ts` | injected stylesheet for the stepper |
| `dsh-suggest-next-prompt/test/protocol.test.mjs` | hermetic wire-contract tests |
| `dsh-suggest-next-prompt/test/host.test.mjs` | hermetic route tests against a fake context |
| `dsh-suggest-next-prompt/test/placeholder.test.mjs` | the DOM write against a fake node |
| `dsh-suggest-next-prompt/test/live-probe.mjs` | non-hermetic end-to-end probe |
| `docs/superpowers/notes/2026-09-12-suggest-next-prompt-seams.md` | Task 1's deliverable: the client-seam findings and the route decision |

---

### Task 1: Pin the session-route seam

**Files:**
- Create: `docs/superpowers/notes/2026-09-12-suggest-next-prompt-seams.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the decision string `ROUTE_SEAM`, either `client-service` or `config-only`, plus the name of the client service if one exists. Task 7 reads this decision.

**Why this task exists:** spec section 5.3 leaves one seam open. Reading `SessionSnapshot` and all eight projection keys proved the route is not available from either. `ctx.llm.stream(options)` requires `provider` and `model` as mandatory strings (verified: `dsh-llm/lib/types/types.d.ts` lines 404-407), so this seam decides whether the plugin can work with no configuration at all, or must require `config.provider` and `config.model`.

- [ ] **Step 1: Look for a client-side route surface**

Run:

```powershell
Select-String -Path "$env:APPDATA
pm
ode_modules@deepseek-aidsh
ode_modules@deepseek-aidsh-client-ui-model-selectionlibclient.js" -Pattern 'ctx.provide|Service|selection|provider|model' -AllMatches | Select-Object -First 40
Get-ChildItem "$env:APPDATA
pm
ode_modules@deepseek-aidsh
ode_modules@deepseek-aidsh-client-ui-model-selectionlib	ypes" -Recurse -Filter *.d.ts | Select-Object -ExpandProperty FullName
```

- [ ] **Step 2: Decide reachability**

A service counts as reachable only if it is registered on the client context by name and the session's current route is readable from a public method, not a private field. Write down the service name and the exact method, or write `none`.

- [ ] **Step 3: Write the findings note**

Create `docs/superpowers/notes/2026-09-12-suggest-next-prompt-seams.md` containing:

- the route decision line: `ROUTE_SEAM: <client-service|config-only>`, with the service name and method when client-service;
- the transcript seam, already confirmed: `useProjection('turnOutline')` returns `readonly TurnOutlineEntry[]` with `{ turn, seq, prompt, response }`, a bounded first-human-prompt preview and a bounded final-response preview per turn, declared in `dsh-session-turn-outline/lib/types/types.d.ts`. This is a standard prop of a `conversation.input.overlay` entry, so no private coupling is needed. If the projection unit is not mounted the hook answers `undefined`, which means no suggestion;
- the auxiliary-call seam, already confirmed: build `options` as `{ provider, model, messages, system, maxTokens, sessionId, signal }` and pass a user message of the literal shape `{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-suggest-next-prompt' } }`. This mirrors the working call in `dsh-session-title-llm/lib/index.js` lines 197-218. `purpose` is a closed union of `'compaction' | 'session-title'`, so it is deliberately omitted — which is also why thinking is not disabled for this call. Record that cost characteristic.

- [ ] **Step 4: Checkpoint**

Confirm the note exists and states all three seams. No build yet.

---

### Task 2: Package scaffold and build pipeline

**Files:**
- Create: `dsh-suggest-next-prompt/package.json`
- Create: `dsh-suggest-next-prompt/tsconfig.json`
- Create: `dsh-suggest-next-prompt/cordis.patch.yml`
- Create: `dsh-suggest-next-prompt/LICENSE`
- Create: `dsh-suggest-next-prompt/scripts/build.mjs`
- Create: `dsh-suggest-next-prompt/src/protocol.ts` (a single exported constant for now; Task 3 fills it)
- Create: `dsh-suggest-next-prompt/src/index.ts` (a stub `apply`; Task 5 fills it)
- Create: `dsh-suggest-next-prompt/src/client/index.ts` (a stub; Task 6 fills it)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run build` emitting `lib/index.js` and `lib/client.js`; `npm run typecheck`; `npm test`.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "dsh-suggest-next-prompt",
  "version": "0.1.0",
  "description": "DSH web plugin: a model-generated next prompt in the chat composer placeholder, accepted with Tab.",
  "type": "module",
  "license": "MIT",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib/", "cordis.patch.yml", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "install:profile": "node scripts/install-profile.mjs",
    "typecheck": "tsc --noEmit",
    "test": "node --test test/*.test.mjs"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" },
    "compatibility": {
      "dshReleases": { "0.1.5-rc.1": "unknown", "0.1.5-rc.2": "unknown" }
    }
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/react": "^18.3.17",
    "esbuild": "^0.24.2",
    "typescript": "^5.7.2"
  }
}
```

There is deliberately no `dependencies` block, no `preinstall`/`install`/`postinstall`/`prepare`, and no `dsh.client.inject` entry — the client half reaches the shell only through `ctx.inject` at runtime, so no declared dependency is needed.

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.mjs"]
}
```

- [ ] **Step 3: Write cordis.patch.yml**

```yaml
# dsh-suggest-next-prompt bundle patch.
#
# Installing this package through the DSH CLI reconciles the profile bundle list
# against installed packages and, seeing this declaration, appends
# dsh-suggest-next-prompt to the stack. The boot merge then inserts the row
# below, so no profile file is edited by hand.
#
# To pin the model route, add it to the row:
#
#   config:
#     provider: deepseek
#     model: deepseek-chat
#
- insert:
    - id: suggest-next-prompt
      name: 'dsh-suggest-next-prompt'
```

The `- insert:` ids here are the `entryIds` a marketplace catalog entry must match.

- [ ] **Step 4: Write LICENSE**

MIT, copyright line for the repository owner. Keep the name byte-identical to the `license` field in package.json.

- [ ] **Step 5: Write scripts/build.mjs**

```js
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const CLIENT_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime']
const out = 'lib'

await mkdir(out, { recursive: true })

// Host half: a plain Node ESM bundle. protocol.ts is inlined, so the plugin
// needs no internal runtime resolution at install time.
await build({
  entryPoints: ['src/index.ts'],
  outfile: out + '/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: false,
})

// Browser half: react and every @deepseek-ai module stay external (the shell
// seeds them in its frozen module table); everything else is inlined.
await build({
  entryPoints: ['src/client/index.ts'],
  outfile: out + '/client.body.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: '__dshSuggestNextPrompt',
  target: 'es2022',
  minify: false,
  sourcemap: false,
  external: CLIENT_EXTERNALS,
  jsx: 'automatic',
})

const body = await readFile(out + '/client.body.js', 'utf8')
const wrapped = [
  'window.__ModuleLoader__.load({',
  "  id: 'dsh-suggest-next-prompt',",
  '  factory: (require) => {',
  '    const module = { exports: {} };',
  '    const exports = module.exports;',
  body,
  '    return module.exports;',
  '  },',
  '});',
].join('
')
await writeFile(out + '/client.js', wrapped)
```

If the shell reports a loader-contract mismatch on boot, copy the exact wrapper booleans from `dsh-run-in-terminal/scripts/build.mjs` — that file is the working reference for this shell version. Do not change the `load(` argument shape to a bare function.

- [ ] **Step 6: Add the src stubs**

`src/protocol.ts`:

```ts
export const SUGGEST_PATH = '/suggestnext/next'
```

`src/index.ts`:

```ts
export const name = 'suggest-next-prompt'
export const inject = ['webServer', 'llm', 'commands', 'agents']
export function apply(): void {}
```

`src/client/index.ts`:

```ts
export function apply(): () => void {
  return () => {}
}
```

- [ ] **Step 7: Build and typecheck**

Run: `cd dsh-suggest-next-prompt && npm install && npm run build && npm run typecheck`
Expected: `lib/index.js` and `lib/client.js` exist; typecheck exits 0.

- [ ] **Step 8: Install into the web profile and confirm the patch composes**

Run: `npm run install:profile`, then `dsh --profile web --dump-config`.
Expected: the dump composes and contains `suggest-next-prompt`. If `install:profile` is missing, copy `dsh-run-in-terminal/scripts/install-profile.mjs` — it exists because a plain `dsh plugin add` of a cross-drive directory mis-links under pnpm.

- [ ] **Step 9: Checkpoint**

`npm run build`, `npm run typecheck`, `dsh --profile web --dump-config` all succeed.

---

### Task 3: Protocol — the trust fence and request parsing

**Files:**
- Modify: `dsh-suggest-next-prompt/src/protocol.ts`
- Test: `dsh-suggest-next-prompt/test/protocol.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SUGGEST_PATH: string`, `MAX_BODY_BYTES = 262144`, `MAX_MESSAGES = 12`, `MAX_MESSAGE_BYTES = 8192`, `MAX_CANDIDATES = 3`, `MAX_CANDIDATE_CHARS = 100`
  - `interface TranscriptMessage { role: 'user' | 'assistant'; text: string }`
  - `interface SuggestRoute { provider: string; model: string }`
  - `interface SuggestRequest { sessionId: string; transcript: readonly TranscriptMessage[]; route?: SuggestRoute }`
  - `interface ProtocolFailure { status: number; error: string }`
  - `parseRequest(raw: unknown, byteLength: number): SuggestRequest | ProtocolFailure`
  - `isFailure(value: SuggestRequest | ProtocolFailure): value is ProtocolFailure`
  - `utf8Bytes(text: string): number`
  - `isTrustedRequest(headers: Record<string, string | string[] | undefined>): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/protocol.test.mjs`:

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_BODY_BYTES, isFailure, isTrustedRequest, parseRequest } from '../lib/protocol.js'

const ok = { sessionId: 's1', transcript: [{ role: 'user', text: 'hi' }] }

test('accepts a minimal request', () => {
  const parsed = parseRequest(ok, 64)
  assert.equal(isFailure(parsed), false)
  assert.deepEqual(parsed.transcript, [{ role: 'user', text: 'hi' }])
})

test('rejects an oversized body rather than truncating it', () => {
  const parsed = parseRequest(ok, MAX_BODY_BYTES + 1)
  assert.equal(isFailure(parsed), true)
  assert.equal(parsed.status, 413)
})

test('rejects unknown fields', () => {
  const parsed = parseRequest({ ...ok, extra: 1 }, 64)
  assert.equal(isFailure(parsed), true)
  assert.equal(parsed.status, 400)
})

test('rejects a bad role and a non-string text', () => {
  assert.equal(isFailure(parseRequest({ sessionId: 's1', transcript: [{ role: 'system', text: 'x' }] }, 64)), true)
  assert.equal(isFailure(parseRequest({ sessionId: 's1', transcript: [{ role: 'user', text: 7 }] }, 64)), true)
})

test('rejects a route with only one half', () => {
  assert.equal(isFailure(parseRequest({ ...ok, route: { provider: 'deepseek' } }, 64)), true)
})

test('accepts a complete route', () => {
  const parsed = parseRequest({ ...ok, route: { provider: 'deepseek', model: 'deepseek-chat' } }, 64)
  assert.equal(isFailure(parsed), false)
  assert.deepEqual(parsed.route, { provider: 'deepseek', model: 'deepseek-chat' })
})

test('the fence admits loopback and refuses everything else', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:3080' }), true)
  assert.equal(isTrustedRequest({ host: 'localhost:3080', origin: 'http://localhost:3080' }), true)
  assert.equal(isTrustedRequest({ host: 'evil.example.com' }), false)
  assert.equal(isTrustedRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), false)
  assert.equal(isTrustedRequest({ host: '127.0.0.1:3080', origin: 'http://evil.example.com' }), false)
  assert.equal(isTrustedRequest({}), false)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd dsh-suggest-next-prompt && npm run build && node --test test/protocol.test.mjs`
Expected: FAIL — `Cannot find module '../lib/protocol.js'` until Step 4 adds the build target, then `parseRequest is not a function`.

- [ ] **Step 3: Implement protocol.ts**

Replace the whole file:

```ts
/**
 * The wire contract shared by both halves of dsh-suggest-next-prompt.
 *
 * Pure: this module imports nothing, in either runtime. Every cap, rejection
 * rule, and framing decision lives here so the bytes on the wire have exactly
 * one authority, and so both halves can be tested without a browser, a server,
 * or a model.
 */

/** The single route the host half owns. */
export const SUGGEST_PATH = '/suggestnext/next'

/** Longest shortlist the plugin will ever return or display. */
export const MAX_CANDIDATES = 3
/** One-line ceiling for a candidate, in characters. */
export const MAX_CANDIDATE_CHARS = 100
/** Transcript window, in messages. */
export const MAX_MESSAGES = 12
/** Per-message ceiling, in UTF-8 bytes. */
export const MAX_MESSAGE_BYTES = 8192
/** Whole-request ceiling, in bytes. Over this, the request is refused, never truncated. */
export const MAX_BODY_BYTES = 262144

export interface TranscriptMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface SuggestRoute {
  readonly provider: string
  readonly model: string
}

export interface SuggestRequest {
  readonly sessionId: string
  readonly transcript: readonly TranscriptMessage[]
  readonly route?: SuggestRoute
}

export interface ProtocolFailure {
  readonly status: number
  readonly error: string
}

/** UTF-8 byte length, without a Buffer, so the browser half can call this too. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function isFailure(value: SuggestRequest | ProtocolFailure): value is ProtocolFailure {
  return (value as ProtocolFailure).error !== undefined
}

function parseRoute(value: unknown): SuggestRoute | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { provider, model } = value as Record<string, unknown>
  if (typeof provider !== 'string' || provider.length === 0 || provider.length > 128) return null
  if (typeof model !== 'string' || model.length === 0 || model.length > 256) return null
  return { provider, model }
}

/**
 * Validate one request body. Rejects rather than repairs: a body over the byte
 * ceiling is refused, not truncated, because a silently shortened transcript
 * would produce a confidently wrong suggestion.
 */
export function parseRequest(raw: unknown, byteLength: number): SuggestRequest | ProtocolFailure {
  if (byteLength > MAX_BODY_BYTES) return { status: 413, error: 'body too large' }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { status: 400, error: 'body must be an object' }
  const body = raw as Record<string, unknown>
  for (const key of Object.keys(body)) {
    if (key !== 'sessionId' && key !== 'transcript' && key !== 'route') return { status: 400, error: 'unknown field: ' + key }
  }
  const sessionId = body['sessionId']
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) {
    return { status: 400, error: 'sessionId must be a non-empty string' }
  }
  const transcript = body['transcript']
  if (!Array.isArray(transcript)) return { status: 400, error: 'transcript must be an array' }
  if (transcript.length > MAX_MESSAGES) return { status: 400, error: 'transcript too long' }
  const messages: TranscriptMessage[] = []
  for (const entry of transcript) {
    if (typeof entry !== 'object' || entry === null) return { status: 400, error: 'transcript entry must be an object' }
    const { role, text } = entry as Record<string, unknown>
    if (role !== 'user' && role !== 'assistant') return { status: 400, error: 'role must be user or assistant' }
    if (typeof text !== 'string') return { status: 400, error: 'text must be a string' }
    if (utf8Bytes(text) > MAX_MESSAGE_BYTES) return { status: 400, error: 'message too large' }
    messages.push({ role, text })
  }
  const route = parseRoute(body['route'])
  if (route === null) return { status: 400, error: 'route must carry non-empty provider and model strings' }
  return route === undefined
    ? { sessionId, transcript: messages }
    : { sessionId, transcript: messages, route }
}

/**
 * The browser-trust fence guarding the route.
 *
 * The Host header must name a loopback authority (a name that merely resolves
 * here from elsewhere is a DNS-rebinding attempt), a request a browser marks
 * cross-site is refused, and an Origin, when present, must name the same
 * hostname. This is a cross-site defense, not authentication: any loopback page
 * on the same hostname passes. Ported unchanged from dsh-run-in-terminal, which
 * mirrors the fence the shipped /api gateway applies to its own routes.
 */
export function isTrustedRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const header = (name: string): string | undefined => {
    const value = headers[name]
    return typeof value === 'string' ? value : undefined
  }
  const host = header('host')
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (header('sec-fetch-site') === 'cross-site') return false
  const origin = header('origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Whether a hostname names the local loopback authority. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255)
}
```

- [ ] **Step 4: Make the test importable**

The test imports `../lib/protocol.js`, so protocol must be its own build output. Add a third build call in `scripts/build.mjs`, before the host bundle:

```js
await build({
  entryPoints: ['src/protocol.ts'],
  outfile: out + '/protocol.js',
  bundle: true, platform: 'neutral', format: 'esm', target: 'es2022',
  minify: false, sourcemap: false,
})
```

- [ ] **Step 5: Run the tests**

Run: `npm run build && node --test test/protocol.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 6: Checkpoint**

`npm run build && npm run typecheck && npm test` all pass.

---

### Task 4: Protocol — candidate sanitation and prompt framing

**Files:**
- Modify: `dsh-suggest-next-prompt/src/protocol.ts`
- Test: `dsh-suggest-next-prompt/test/protocol.test.mjs`

**Interfaces:**
- Consumes: everything Task 3 produced.
- Produces:
  - `sanitizeCandidates(values: readonly unknown[], catalogue: readonly string[]): string[]`
  - `buildPrompt(request: SuggestRequest, catalogue: readonly string[]): { system: string; user: string }`

- [ ] **Step 1: Write the failing tests**

Append to `test/protocol.test.mjs`:

```js
import { MAX_CANDIDATE_CHARS, MAX_CANDIDATES, buildPrompt, sanitizeCandidates } from '../lib/protocol.js'

test('drops every malformed candidate and keeps the rest in order', () => {
  const values = [
    '',
    '   ',
    'add tests for the parser',
    'line one\nline two',
    'x'.repeat(MAX_CANDIDATE_CHARS + 1),
    'has\u0007control',
    'add tests for the parser',
    'run it and fix the failure',
    'a fourth candidate',
    'a fifth candidate',
  ]
  assert.deepEqual(sanitizeCandidates(values, []), [
    'add tests for the parser',
    'run it and fix the failure',
    'a fourth candidate',
  ])
})

test('refuses a command that is not in the live catalogue', () => {
  assert.deepEqual(sanitizeCandidates(['/compact', '/plan'], ['compact']), ['/compact'])
})

test('tolerates a command with trailing arguments', () => {
  assert.deepEqual(sanitizeCandidates(['/plan the migration'], ['plan']), ['/plan the migration'])
})

test('drops non-strings', () => {
  assert.deepEqual(sanitizeCandidates([1, null, {}, 'run the tests'], []), ['run the tests'])
})

test('never returns more than the cap', () => {
  const many = Array.from({ length: 10 }, (_, i) => 'candidate ' + i)
  assert.equal(sanitizeCandidates(many, []).length, MAX_CANDIDATES)
})

test('framing states the one-line rule and the catalogue', () => {
  const request = { sessionId: 's1', transcript: [{ role: 'user', text: 'hi' }] }
  const framed = buildPrompt(request, ['compact', 'plan'])
  assert.match(framed.system, /one line/)
  assert.match(framed.system, /compact, plan/)
  assert.equal(framed.user, '{"turns":[{"role":"user","text":"hi"}]}')
})

test('framing forbids commands when the catalogue is empty', () => {
  const framed = buildPrompt({ sessionId: 's1', transcript: [] }, [])
  assert.match(framed.system, /Do not suggest slash commands/)
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm run build && node --test test/protocol.test.mjs`
Expected: FAIL — `sanitizeCandidates is not a function`.

- [ ] **Step 3: Implement**

Append to `src/protocol.ts`:

```ts
/** A suggestion that starts with a slash names this command. */
const COMMAND_TOKEN = /^\/([a-z0-9_-]+)/i

/**
 * Keep only candidates that are safe to render in the composer placeholder.
 *
 * A candidate is dropped when it is empty, longer than the one-line ceiling,
 * multi-line, or carries a control character. A leading slash command is kept
 * only when its name is in the live catalogue, so a suggestion can never be
 * accepted into an "unknown command" refusal. Duplicates are collapsed and the
 * list is cut to MAX_CANDIDATES. Silence is a valid outcome: an empty array
 * means "nothing good enough this turn", and the client keeps what it shows.
 */
export function sanitizeCandidates(values: readonly unknown[], catalogue: readonly string[]): string[] {
  const known = new Set(catalogue)
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text.length === 0 || text.length > MAX_CANDIDATE_CHARS) continue
    if (/[\r\n]/.test(text)) continue
    if (/[\u0000-\u001f\u007f]/.test(text)) continue
    const match = COMMAND_TOKEN.exec(text)
    if (match !== null && !known.has(match[1] as string)) continue
    if (out.includes(text)) continue
    out.push(text)
    if (out.length === MAX_CANDIDATES) break
  }
  return out
}

export interface SuggestPrompt {
  readonly system: string
  readonly user: string
}

/**
 * Frame the auxiliary request. Deterministic, so the tests can assert both the
 * instruction and the exact serialized transcript, and so the byte ceiling is
 * a property of one function rather than of a call site.
 */
export function buildPrompt(request: SuggestRequest, catalogue: readonly string[]): SuggestPrompt {
  const commandRule = catalogue.length === 0
    ? 'Do not suggest slash commands.'
    : 'Slash commands available in this session, which are the only ones you may suggest: ' + catalogue.join(', ') + '.'
  const system = [
    'You propose the next prompt a developer should send to an AI coding agent.',
    'Return ONLY a JSON array of at most ' + MAX_CANDIDATES + ' single-line strings, ranked best first.',
    'Each string is the literal text placed in the composer: no markdown, no numbering, no surrounding quotes, no explanation.',
    'At most ' + MAX_CANDIDATE_CHARS + ' characters, one line each.',
    'Mix these kinds when each is genuinely best: the next concrete action, a short consent or steering reply,',
    'and a better alternative to the path the agent just took.',
    commandRule,
  ].join(' ')
  return { system, user: JSON.stringify({ turns: request.transcript }) }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run build && node --test test/protocol.test.mjs`
Expected: PASS, 14 tests.

- [ ] **Step 5: Checkpoint**

`npm run build && npm run typecheck && npm test` all pass.

---

### Task 5: Host half — the route

**Files:**
- Modify: `dsh-suggest-next-prompt/src/index.ts`
- Test: `dsh-suggest-next-prompt/test/host.test.mjs`

**Interfaces:**
- Consumes: `parseRequest`, `isFailure`, `isTrustedRequest`, `buildPrompt`, `sanitizeCandidates`, `SUGGEST_PATH`, `MAX_BODY_BYTES`.
- Produces:
  - `export const name = 'suggest-next-prompt'`
  - `export const inject = ['webServer', 'llm', 'commands', 'agents']`
  - `export interface Config { enabled?: boolean; provider?: string; model?: string; maxCandidates?: number; timeoutMs?: number; maxOutputTokens?: number }`
  - `export function apply(ctx: HostContext, config?: Config): void`
  - `export async function handleRequest(deps: HandlerDeps, request: IncomingRequest): Promise<HandlerResult>` — the testable core, separated from the http plumbing

- [ ] **Step 1: Write the failing test**

Create `test/host.test.mjs`. The handler takes plain objects, so no http server is needed:

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleRequest } from '../lib/index.js'

const headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
const body = { sessionId: 's1', transcript: [{ role: 'user', text: 'write the parser' }] }

function deps(overrides = {}) {
  return {
    settings: {
      route: { provider: 'deepseek', model: 'deepseek-chat' },
      timeoutMs: 8000, maxCandidates: 3, maxOutputTokens: 200,
    },
    agents: { get: (id) => (id === 's1' ? { id: 's1' } : undefined) },
    commands: { list: () => [{ name: 'compact' }, { name: 'plan' }] },
    // One chunk, then a clean finish.
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '["run the tests", "/compact", "no, do it the lazy way"]' }
      yield { type: 'finish', reason: 'stop' }
    },
    ...overrides,
  }
}

test('refuses a missing or foreign Origin host', async () => {
  const result = await handleRequest(deps(), { headers: { host: 'evil.example.com' }, byteLength: 64, raw: body })
  assert.equal(result.status, 403)
})

test('refuses a body over the byte ceiling', async () => {
  const result = await handleRequest(deps(), { headers, byteLength: 1 << 30, raw: body })
  assert.equal(result.status, 413)
})

test('answers 404 for an unknown session', async () => {
  const result = await handleRequest(deps(), { headers, byteLength: 64, raw: { ...body, sessionId: 'nope' } })
  assert.equal(result.status, 404)
})

test('returns the sanitized shortlist', async () => {
  const result = await handleRequest(deps(), { headers, byteLength: 64, raw: body })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.candidates, ['run the tests', '/compact', 'no, do it the lazy way'])
})

test('drops a command the catalogue does not know', async () => {
  const stream = async function* () {
    yield { type: 'text-delta', index: 0, text: '["/nonexistent", "run the tests"]' }
    yield { type: 'finish', reason: 'stop' }
  }
  const result = await handleRequest(deps({ stream }), { headers, byteLength: 64, raw: body })
  assert.deepEqual(result.body.candidates, ['run the tests'])
})

test('answers an empty shortlist when the model fails, never an error', async () => {
  const stream = async function* () {
    yield { type: 'finish', reason: 'error' }
  }
  const result = await handleRequest(deps({ stream }), { headers, byteLength: 64, raw: body })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.candidates, [])
})

test('answers an empty shortlist when no route is available', async () => {
  const withoutRoute = deps({ settings: { timeoutMs: 8000, maxCandidates: 3, maxOutputTokens: 200 } })
  const result = await handleRequest(withoutRoute, { headers, byteLength: 64, raw: body })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.candidates, [])
})

test('answers an empty shortlist on unparseable model output', async () => {
  const stream = async function* () {
    yield { type: 'text-delta', index: 0, text: 'I think you should run the tests.' }
    yield { type: 'finish', reason: 'stop' }
  }
  const result = await handleRequest(deps({ stream }), { headers, byteLength: 64, raw: body })
  assert.deepEqual(result.body.candidates, [])
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run build && node --test test/host.test.mjs`
Expected: FAIL — `handleRequest is not a function`.

- [ ] **Step 3: Implement the host half**

Replace `src/index.ts`:

```ts
/**
 * dsh-suggest-next-prompt — host half.
 *
 * Owns exactly one route. It resolves the session's agent, reads that
 * session's live slash-command catalogue, makes ONE auxiliary model call, and
 * returns a validated shortlist of one-line next prompts.
 *
 * The route spends model tokens, so it sits behind the same loopback fence the
 * shipped /api gateway applies. That fence is a DNS-rebinding and cross-site
 * defense, not authentication.
 *
 * @module dsh-suggest-next-prompt
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  MAX_BODY_BYTES, SUGGEST_PATH,
  buildPrompt, isFailure, isTrustedRequest, parseRequest, sanitizeCandidates,
} from './protocol'

export const name = 'suggest-next-prompt'
export const inject = ['webServer', 'llm', 'commands', 'agents']

/** Plugin config from the bundle row. */
export interface Config {
  enabled?: boolean
  provider?: string
  model?: string
  maxCandidates?: number
  timeoutMs?: number
  maxOutputTokens?: number
}

interface Settings {
  readonly route?: { readonly provider: string; readonly model: string }
  readonly maxCandidates: number
  readonly timeoutMs: number
  readonly maxOutputTokens: number
}

export interface IncomingRequest {
  readonly headers: Record<string, string | string[] | undefined>
  readonly byteLength: number
  readonly raw: unknown
}

export interface HandlerResult {
  readonly status: number
  readonly body: { readonly candidates?: readonly string[]; readonly error?: string }
}

interface AgentLike { readonly id?: string }
interface DescriptorLike { readonly name: string }

/** Everything the handler needs, injected so the tests need no server. */
export interface HandlerDeps {
  readonly settings: Settings
  readonly agents: { get(id: string): AgentLike | undefined }
  readonly commands: { list(agent: AgentLike): readonly DescriptorLike[] }
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}

function resolveSettings(config?: Config): Settings {
  const provider = typeof config?.provider === 'string' ? config.provider : undefined
  const model = typeof config?.model === 'string' ? config.model : undefined
  const maxCandidates = Math.min(3, Math.max(1, Math.floor(config?.maxCandidates ?? 3)))
  const timeoutMs = Math.min(30000, Math.max(500, Math.floor(config?.timeoutMs ?? 8000)))
  const maxOutputTokens = Math.min(2000, Math.max(32, Math.floor(config?.maxOutputTokens ?? 200)))
  return {
    ...(provider !== undefined && model !== undefined ? { route: { provider, model } } : {}),
    maxCandidates, timeoutMs, maxOutputTokens,
  }
}

/** Concatenate the text deltas of one auxiliary call. */
async function collect(
  deps: HandlerDeps,
  route: { provider: string; model: string },
  prompt: { system: string; user: string },
  sessionId: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<string> {
  const options = {
    provider: route.provider,
    model: route.model,
    system: prompt.system,
    messages: [{
      id: 'suggest-next-prompt-' + Date.now(),
      role: 'user',
      content: [{ type: 'text', text: prompt.user }],
      source: { kind: 'plugin', plugin: 'dsh-suggest-next-prompt' },
    }],
    maxTokens: settings.maxOutputTokens,
    sessionId,
    signal,
  }
  let text = ''
  for await (const chunk of deps.stream(options)) {
    if (chunk['type'] === 'text-delta' && typeof chunk['text'] === 'string') text += chunk['text']
    if (chunk['type'] === 'finish' && chunk['reason'] !== 'stop') return ''
  }
  return text
}

/** Pull the first JSON array out of a model reply, or nothing. */
function extractArray(text: string): readonly unknown[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * The route body, independent of http plumbing.
 *
 * Every failure that is not a client mistake answers 200 with an empty
 * shortlist: a suggestion feature must never surface an error of its own.
 */
export async function handleRequest(deps: HandlerDeps, request: IncomingRequest): Promise<HandlerResult> {
  if (!isTrustedRequest(request.headers)) return { status: 403, body: { error: 'forbidden' } }
  const parsed = parseRequest(request.raw, request.byteLength)
  if (isFailure(parsed)) return { status: parsed.status, body: { error: parsed.error } }
  const agent = deps.agents.get(parsed.sessionId)
  if (agent === undefined) return { status: 404, body: { error: 'unknown session' } }
  const catalogue = deps.commands.list(agent).map(descriptor => descriptor.name)
  const route = parsed.route ?? deps.settings.route
  if (route === undefined) return { status: 200, body: { candidates: [] } }
  const prompt = buildPrompt(parsed, catalogue)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.settings.timeoutMs)
  let text = ''
  try {
    text = await collect(deps, route, prompt, parsed.sessionId, deps.settings, controller.signal)
  } catch {
    return { status: 200, body: { candidates: [] } }
  } finally {
    clearTimeout(timer)
  }
  const candidates = sanitizeCandidates(extractArray(text), catalogue).slice(0, deps.settings.maxCandidates)
  return { status: 200, body: { candidates } }
}

/** Read the body under a hard ceiling. Returns null when the ceiling is crossed. */
async function readBody(req: IncomingMessage, limit: number): Promise<{ raw: string; bytes: number } | null> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    bytes += buf.length
    if (bytes > limit) return null
    chunks.push(buf)
  }
  return { raw: Buffer.concat(chunks).toString('utf8'), bytes }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(payload)
}

/** Structural face of the host services this plugin uses. */
export interface HostContext {
  webServer: {
    register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
  }
  llm: { stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>> }
  commands: { list(agent: AgentLike): readonly DescriptorLike[] }
  agents: { get(id: string): AgentLike | undefined }
  effect(callback: () => void | (() => void), label?: string): void
}

/**
 * Host plugin body: claim the route and nothing else.
 * @param ctx - the host context.
 * @param config - the plugin row's config.
 */
export function apply(ctx: HostContext, config?: Config): void {
  if (config?.enabled === false) return
  const settings = resolveSettings(config)
  const deps: HandlerDeps = {
    settings,
    agents: ctx.agents,
    commands: ctx.commands,
    stream: options => ctx.llm.stream(options),
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SUGGEST_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readBody(req, MAX_BODY_BYTES).catch(() => null)
      if (body === null) {
        send(res, 413, { error: 'body too large' })
        return
      }
      let raw: unknown
      try {
        raw = JSON.parse(body.raw)
      } catch {
        send(res, 400, { error: 'body must be JSON' })
        return
      }
      const result = await handleRequest(deps, { headers: req.headers, byteLength: body.bytes, raw })
      send(res, result.status, result.body)
    },
  }), 'suggest-next-prompt: route')
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run build && node --test test/host.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Checkpoint**

`npm run build && npm run typecheck && npm test` all pass.

---

### Task 6: Client half — the overlay entry and the placeholder write

**Files:**
- Create: `dsh-suggest-next-prompt/src/client/types.ts`
- Create: `dsh-suggest-next-prompt/src/client/placeholder.ts`
- Modify: `dsh-suggest-next-prompt/src/client/index.ts`
- Test: `dsh-suggest-next-prompt/test/placeholder.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks except the build pipeline.
- Produces:
  - `applySuggestion(node: PlaceholderNode | null, text: string | null): boolean` where `interface PlaceholderNode { textContent: string | null }`
  - `findPlaceholder(from: Element | null): PlaceholderNode | null`
  - the client plugin body `apply(ctx: ClientContext): () => void` registering the overlay entry

- [ ] **Step 1: Write the failing placeholder test**

Create `test/placeholder.test.mjs` — no jsdom, just the shape the write needs:

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applySuggestion } from '../lib/placeholder.js'

test('writes the suggestion into the placeholder node', () => {
  const node = { textContent: 'Message or run a task' }
  assert.equal(applySuggestion(node, 'run the tests'), true)
  assert.equal(node.textContent, 'run the tests')
})

test('is a no-op when there is no node', () => {
  assert.equal(applySuggestion(null, 'run the tests'), false)
})

test('leaves the node alone when there is no suggestion', () => {
  const node = { textContent: 'Message or run a task' }
  assert.equal(applySuggestion(node, null), false)
  assert.equal(node.textContent, 'Message or run a task')
})

test('re-asserts the same text without reporting a change twice', () => {
  const node = { textContent: 'run the tests' }
  assert.equal(applySuggestion(node, 'run the tests'), true)
  assert.equal(node.textContent, 'run the tests')
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run build && node --test test/placeholder.test.mjs`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement placeholder.ts**

```ts
/**
 * The one place this plugin touches the shipped composer's DOM.
 *
 * DSH renders the composer placeholder as a real element:
 *
 *   <div class="...placeholder" data-composer-placeholder aria-hidden="true">...</div>
 *
 * There is no placeholder-provider extension point, so the only way to put a
 * suggestion where a placeholder belongs is to write this node's text. Keeping
 * that in one module, behind one function, is what makes the coupling cheap to
 * replace if DSH ever ships the hook.
 *
 * React re-writes the node whenever the shell's own placeholder text changes
 * (plan mode toggling, for example), so callers re-assert on every render.
 * Setting the same text twice is free: the assignment is a no-op and React's
 * own attribute diffing is unaffected.
 */

export interface PlaceholderNode {
  textContent: string | null
}

/** The selector for the shipped placeholder element. */
export const PLACEHOLDER_SELECTOR = '[data-composer-placeholder]'

/**
 * Locate the placeholder node from anywhere inside the composer card.
 * @param from - an element inside the composer, normally the overlay's own.
 * @returns the node, or null when the composer is not mounted.
 */
export function findPlaceholder(from: Element | null): PlaceholderNode | null {
  if (from === null) return null
  const scope = from.closest('form, [class*="root"]') ?? from.parentElement
  const found = scope?.querySelector(PLACEHOLDER_SELECTOR) ?? null
  return found as unknown as PlaceholderNode | null
}

/**
 * Put a suggestion where the placeholder text goes.
 * @param node - the placeholder node, or null.
 * @param text - the suggestion, or null to leave the node alone.
 * @returns whether the node now shows the text.
 */
export function applySuggestion(node: PlaceholderNode | null, text: string | null): boolean {
  if (node === null || text === null) return false
  if (node.textContent === text) return true
  node.textContent = text
  return true
}
```

- [ ] **Step 4: Add the third build output**

In `scripts/build.mjs`, add:

```js
await build({
  entryPoints: ['src/client/placeholder.ts'],
  outfile: out + '/placeholder.js',
  bundle: true, platform: 'neutral', format: 'esm', target: 'es2022',
  minify: false, sourcemap: false,
})
```

- [ ] **Step 5: Run the test**

Run: `npm run build && node --test test/placeholder.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the type mirrors**

Create `src/client/types.ts`. Mirror only what is read; this package imports no `@deepseek-ai/*` module, value or type:

```ts
/**
 * Structural mirrors of the DSH browser faces this plugin touches.
 *
 * Everything here is what the plugin actually reads, not a copy of the
 * upstream contract. The package is built and installed out of tree, so it
 * imports no @deepseek-ai module at all.
 */
import type { ReactNode } from 'react'

/** One entry of the turnOutline session projection. */
export interface TurnOutlineEntry {
  readonly turn: number
  readonly seq: number
  /** Bounded first-human-prompt preview; '' until an eligible prompt lands. */
  readonly prompt: string
  /** Bounded final-response preview; '' until the turn ends with assistant text. */
  readonly response: string
}

/** Reader for one session projection key. */
export type UseProjection = (key: 'turnOutline') => readonly TurnOutlineEntry[] | undefined

/** Selector hook over the per-session input state. */
export type UseInput = <S>(selector: (state: InputState) => S, eq?: (a: S, b: S) => boolean) => S

/** The published composer input state, restricted to what this plugin reads. */
export interface InputState {
  readonly draft: string
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
}

/** Selector hook over the per-session lifecycle snapshot. */
export type UseSession = <S>(selector: (session: SessionSnapshot) => S, eq?: (a: S, b: S) => boolean) => S

export interface SessionSnapshot {
  readonly sessionId: string
  readonly running: boolean
  readonly removed: boolean
}

/** The public composer action face; this plugin uses setDraft alone. */
export interface InputActions {
  setDraft(text: string): void
  submit(): void
}

/** The Cordis client context face this plugin uses. */
export interface ClientContext {
  get(name: string): unknown
  inject(names: readonly string[], callback: (injected: ClientContext) => void | (() => void)): { dispose(): void | Promise<void> }
  effect(callback: () => void | (() => void), label?: string): void
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(registration: unknown, component: unknown): () => void
  }
}

/** Props the slot framework supplies to a conversation.input.overlay entry. */
export interface OverlayProps {
  readonly useInput: UseInput
  readonly useSession: UseSession
  readonly inputActions: InputActions
  readonly useProjection: UseProjection
  readonly sessionId: string
  readonly children?: ReactNode
}
```

- [ ] **Step 7: Register the overlay entry**

Replace `src/client/index.ts`:

```ts
/**
 * dsh-suggest-next-prompt — browser half.
 *
 * One contribution: an entry in conversation.input.overlay, which the shipped
 * composer bar renders inside its own card. A fresh id, so the entry is added
 * beside the shipped ones (command-popup, slash-menu, feedback-dialog) and
 * replaces none of them — the slot's published replaceRisk is "none".
 */
import { SuggestOverlay } from './suggest'
import { injectSuggestStyles } from './styles'
import type { ClientContext } from './types'

export const inject = ['slots']

export function apply(ctx: ClientContext): () => void {
  injectSuggestStyles()
  return ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'suggest-next-prompt',
    order: 100,
  }, SuggestOverlay))
}
```

- [ ] **Step 8: Add a minimal component so the build is green**

Create `src/client/styles.ts` and `src/client/suggest.tsx` as the smallest compiling versions; Tasks 7 and 8 fill them.

`styles.ts`:

```ts
/** The one stylesheet this plugin injects. Scoped by its own attribute. */
const CSS = [
  '.dsh-suggest-stepper{',
  'position:absolute;right:8px;bottom:6px;pointer-events:none;',
  'font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);',
  '}',
].join('')

export function injectSuggestStyles(): void {
  if (typeof document === 'undefined') return
  const id = 'dsh-suggest-next-prompt/style.css'
  if (document.querySelector('style[data-plugin-css="' + JSON.stringify(id) + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-suggest-next-prompt'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}
```

`suggest.tsx`:

```tsx
import type { OverlayProps } from './types'

export function SuggestOverlay(props: OverlayProps): JSX.Element | null {
  void props
  return null
}
```

- [ ] **Step 9: Build, typecheck, test**

Run: `npm run build && npm run typecheck && npm test`
Expected: build emits three `lib/*.js` plus the wrapped `lib/client.js`; typecheck exits 0; 18 tests pass.

- [ ] **Step 10: Checkpoint**

All of the above pass, and `npm run install:profile` followed by a page reload shows no console error from the plugin.

---

### Task 7: Client half — transcript, route, fetch, and the trigger

**Files:**
- Create: `dsh-suggest-next-prompt/src/client/transcript.ts`
- Create: `dsh-suggest-next-prompt/src/client/route.ts`
- Create: `dsh-suggest-next-prompt/src/client/fetch.ts`
- Modify: `dsh-suggest-next-prompt/src/client/suggest.tsx`

**Interfaces:**
- Consumes: `TurnOutlineEntry`, `OverlayProps`, `MAX_MESSAGES`, `SUGGEST_PATH`, `TranscriptMessage`.
- Produces:
  - `buildTranscript(entries: readonly TurnOutlineEntry[] | undefined): TranscriptMessage[]`
  - `requestSuggestions(sessionId: string, transcript: readonly TranscriptMessage[], route: SuggestRoute | undefined, signal: AbortSignal, path?: string): Promise<string[]>`
  - `sessionRoute(ctx: ClientContext, sessionId: string): SuggestRoute | undefined` — reads the `modelSelection` projection face. Task 1 confirmed this seam exists (see docs/superpowers/notes/2026-09-12-suggest-next-prompt-seams.md).

- [ ] **Step 1: Implement transcript.ts**

```ts
/**
 * The transcript the host is given.
 *
 * Source: the turnOutline session projection, which the host computes and the
 * client reads through the standard useProjection prop. Each entry carries a
 * bounded first-human-prompt preview and a bounded final-response preview, so
 * the window is a summary rather than full text. That is the right trade for
 * "what should the user say next": cheaper, and focused on the turns that
 * matter. The projection is undefined when its unit is not mounted, which
 * simply means no suggestion.
 */
import { MAX_MESSAGES } from '../protocol'
import type { TranscriptMessage } from '../protocol'
import type { TurnOutlineEntry } from './types'

/**
 * Flatten the last turns into alternating user/assistant messages.
 * @param entries - the turnOutline projection value, possibly undefined.
 * @returns at most MAX_MESSAGES messages, oldest first.
 */
export function buildTranscript(entries: readonly TurnOutlineEntry[] | undefined): TranscriptMessage[] {
  if (entries === undefined || entries.length === 0) return []
  const out: TranscriptMessage[] = []
  for (const entry of entries) {
    const prompt = entry.prompt.trim()
    if (prompt !== '') out.push({ role: 'user', text: prompt })
    const response = entry.response.trim()
    if (response !== '') out.push({ role: 'assistant', text: response })
  }
  return out.slice(Math.max(0, out.length - MAX_MESSAGES))
}
```

- [ ] **Step 2: Implement route.ts**

Task 1 confirmed this seam. The route the session's next request will use lives in the host-computed `modelSelection` projection, readable from the session binding with no extra service:

```ts
/**
 * The provider/model route this session's next request would use.
 *
 * Source: the host-computed `modelSelection` projection, read through the
 * session binding. This is deliberately the only place the plugin touches
 * session internals, and it is a public face: SessionBinding.session is the
 * outward SessionFace, and ProjectionsFace.faceOf is the documented read path
 * for every projection key. Absence means the projection unit is not mounted,
 * which is a normal outcome and simply falls back to config or silence.
 */
import type { ClientContext } from './types'
import type { SuggestRoute } from '../protocol'

interface SelectionProjection {
  readonly lastUsed?: SuggestRoute | null
  readonly next?: SuggestRoute | null
}

export function sessionRoute(ctx: ClientContext, sessionId: string): SuggestRoute | undefined {
  try {
    const sessions = ctx.get('sessions') as {
      binding(id: string): { session: { projections: { faceOf(key: string): { getSnapshot(): unknown } } } } | undefined
    } | undefined
    const face = sessions?.binding(sessionId)?.session.projections.faceOf('modelSelection')
    const value = face?.getSnapshot() as SelectionProjection | undefined
    const pick = value?.next ?? value?.lastUsed
    if (pick === undefined || pick === null) return undefined
    if (typeof pick.provider !== 'string' || pick.provider === '') return undefined
    if (typeof pick.model !== 'string' || pick.model === '') return undefined
    return { provider: pick.provider, model: pick.model }
  } catch {
    // An unknown session, a missing projection, or a face that throws all mean
    // the same thing here: no route, so the host falls back or stays silent.
    return undefined
  }
}
```

`next` is the later user selection not yet consumed by a model request; it wins over `lastUsed`, which is the selection consumed by the latest recorded request.

- [ ] **Step 3: Implement fetch.ts**

```ts
/**
 * The one request this plugin makes.
 *
 * Every failure answers with an empty list rather than throwing, because the
 * caller must never be tempted to surface an error: a suggestion feature that
 * nags is worse than no suggestion feature.
 */
import { SUGGEST_PATH } from '../protocol'
import type { SuggestRoute, TranscriptMessage } from '../protocol'

/**
 * Ask the host for a shortlist.
 * @param sessionId - the session on screen.
 * @param transcript - the bounded transcript.
 * @param path - the route path; overridable for the live probe.
 * @param signal - cancellation, fired when the turn changes or the component unmounts.
 * @returns the candidates, or an empty list.
 */
export async function requestSuggestions(
  sessionId: string,
  transcript: readonly TranscriptMessage[],
  route: SuggestRoute | undefined,
  signal: AbortSignal,
  path: string = SUGGEST_PATH,
): Promise<string[]> {
  if (transcript.length === 0) return []
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(route === undefined ? { sessionId, transcript } : { sessionId, transcript, route }),
      signal,
      credentials: 'same-origin',
    })
    if (!response.ok) return []
    const payload = (await response.json()) as { candidates?: unknown }
    if (!Array.isArray(payload.candidates)) return []
    return payload.candidates.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Wire the trigger into the component**

Replace `src/client/suggest.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { requestSuggestions } from './fetch'
import { applySuggestion, findPlaceholder } from './placeholder'
import { sessionRoute } from './route'
import { buildTranscript } from './transcript'
import type { ClientContext, OverlayProps } from './types'

export function SuggestOverlay({ useInput, useSession, useProjection, ctx, sessionId }: OverlayProps): JSX.Element | null {
  const draft = useInput(state => state.draft)
  const running = useSession(session => session.running)
  const removed = useSession(session => session.removed)
  const outline = useProjection('turnOutline')

  const hostRef = useRef<HTMLDivElement | null>(null)
  const [candidates, setCandidates] = useState<readonly string[]>([])
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Generate once per settled turn: a true -> false edge, an empty composer,
  // and nothing already in flight.
  useEffect(() => {
    if (running || removed || dismissed) return
    if (draft.trim() !== '') return
    const transcript = buildTranscript(outline)
    if (transcript.length === 0) return
    const controller = new AbortController()
    abortRef.current = controller
    const route = sessionRoute(ctx, sessionId)
    let live = true
    void requestSuggestions(sessionId, transcript, route, controller.signal).then(result => {
      if (!live) return
      abortRef.current = null
      setCandidates(result)
      setIndex(0)
    })
    return () => {
      live = false
      controller.abort()
      abortRef.current = null
    }
    // outline identity is stable per projection frame, so this re-runs only
    // when a new turn actually lands.
  }, [running, removed, dismissed, sessionId, outline, ctx])

  // A dismissed suggestion comes back when a new turn starts.
  useEffect(() => {
    if (running) setDismissed(false)
  }, [running])

  const suggestion = draft.trim() === '' && !dismissed && candidates.length > 0
    ? candidates[index % candidates.length] ?? null
    : null

  // The placeholder write is re-asserted on every render because React
  // re-writes that node whenever the shell's own placeholder text changes.
  useEffect(() => {
    applySuggestion(findPlaceholder(hostRef.current), suggestion)
  })

  const cycle = useCallback((delta: number) => {
    setIndex(current => (current + delta + candidates.length) % Math.max(1, candidates.length))
  }, [candidates.length])

  void cycle
  return <div ref={hostRef} className="dsh-suggest-host" hidden />
}
```

- [ ] **Step 5: Build and typecheck**

Run: `npm run build && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Manual check on a one-off profile**

Start the web profile with the plugin installed, send one message, and wait for the turn to settle.
Expected: the composer placeholder shows a generated candidate; typing anything clears it; the console shows no error when the host is unreachable.

- [ ] **Step 7: Checkpoint**

Build, typecheck and tests pass, and the manual check above behaves as described.

---

### Task 8: Client half — Tab, Shift+Tab, Enter, Escape, and the stepper

**Files:**
- Modify: `dsh-suggest-next-prompt/src/client/suggest.tsx`
- Modify: `dsh-suggest-next-prompt/src/client/styles.ts`

**Interfaces:**
- Consumes: everything Task 7 produced, plus `inputActions`.
- Produces: the finished component. No new exported names.

- [ ] **Step 1: Add the key handler**

In `suggest.tsx`, inside the component, after `cycle`:

```tsx
  // One capture-phase listener on the composer input's ANCESTOR. Capture on an
  // ancestor is the only seat guaranteed to run before the shipped Lexical
  // keymap: at the target node itself, listeners fire in registration order,
  // and the shell registered first.
  useEffect(() => {
    if (suggestion === null) return
    const host = hostRef.current
    const input = host?.closest('div')?.parentElement?.querySelector('[data-placeholder]') ?? null
    const seat = input?.parentElement ?? null
    if (seat === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        cycle(event.shiftKey ? -1 : 1)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        event.stopPropagation()
        setDraftRef.current(suggestion)
        setCandidates([])
        setDismissed(true)
        return
      }
      if (event.key === 'Escape') {
        setCandidates([])
        setDismissed(true)
      }
    }
    seat.addEventListener('keydown', onKeyDown, true)
    return () => seat.removeEventListener('keydown', onKeyDown, true)
  }, [suggestion, cycle])
```

- [ ] **Step 2: Add the draft writer ref**

`setDraft` must be a stable identity, so hold it in a ref rather than in the dependency list. Add near the other refs, and take `inputActions` from the props:

```tsx
  const setDraftRef = useRef(inputActions.setDraft)
  useEffect(() => {
    setDraftRef.current = inputActions.setDraft
  }, [inputActions])
```

and change the signature to destructure it:

```tsx
export function SuggestOverlay({ useInput, useSession, useProjection, inputActions, sessionId }: OverlayProps): JSX.Element | null {
```

- [ ] **Step 3: Render the stepper**

Replace the final `return`:

```tsx
  return (
    <div ref={hostRef} className="dsh-suggest-host" hidden>
      {suggestion !== null && candidates.length > 1
        ? <div className="dsh-suggest-stepper">{String(index % candidates.length + 1) + '/' + String(candidates.length)}</div>
        : null}
    </div>
  )
```

The host div stays `hidden` so it contributes no layout of its own; the stepper is positioned by the stylesheet, and the visible text is the placeholder the plugin writes.

- [ ] **Step 4: Build and typecheck**

Run: `npm run build && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 5: Manual acceptance — all seven criteria from the spec**

With the plugin installed on a one-off profile, confirm in the browser:

1. The placeholder shows a generated candidate after a turn settles.
2. Tab cycles, Shift+Tab steps back, and the stepper tracks position.
3. Enter fills the draft and does not submit.
4. Escape dismisses until the next turn.
5. Every candidate is one line and within the cap; any slash command shown actually exists.
6. With the host route blocked (stop the server, or point the plugin at a dead path), the stock placeholder stays and nothing is reported.
7. `npm ls --omit=dev --depth=0` shows no runtime dependencies.

- [ ] **Step 6: Checkpoint**

All seven criteria observed. Record any that failed and fix before moving on.

---

### Task 9: Live probe, README, and the seam record

**Files:**
- Create: `dsh-suggest-next-prompt/test/live-probe.mjs`
- Create: `dsh-suggest-next-prompt/README.md`
- Modify: `docs/superpowers/notes/2026-09-12-suggest-next-prompt-seams.md`

**Interfaces:**
- Consumes: the built plugin running in a profile.
- Produces: the non-hermetic evidence and the shipped documentation.

- [ ] **Step 1: Write the live probe**

Model it on `dsh-run-in-terminal/test/live-probe.mjs`: one same-origin request that must be accepted, one with a foreign `Origin` that must be refused, and one with a body over `MAX_BODY_BYTES` that must answer 413. Fail loudly with the actual status when an expectation misses.

- [ ] **Step 2: Run the live probe**

Run: `node test/live-probe.mjs http://127.0.0.1:3080`
Expected: three lines of PASS. A 404 on the accepted request means the plugin row is not loaded — check `dsh --profile web --dump-config` first.

- [ ] **Step 3: Write README.md**

It must cover, in this order: what the plugin does and what Tab/Enter do; install and enable; configuration (every key in the `Config` interface, with the route pair explained as the fallback when the route seam is config-only); **permissions** — one loopback HTTP route that spends model tokens on an auxiliary call, one model call per settled turn, no file or network access beyond that, and the fence is a cross-site defense and not authentication; known risks (the private placeholder DOM node and its React re-write, the Tab/Enter interception, the possibly-thinking auxiliary call because `purpose` is a closed union); and the test commands.

- [ ] **Step 4: Finish the seam record**

Append the live outcome of `useProjection('turnOutline')` — whether it was populated in a real session — and the final `ROUTE_SEAM` decision as shipped.

- [ ] **Step 5: Final checkpoint**

Run: `npm run build && npm run typecheck && npm test && node test/live-probe.mjs http://127.0.0.1:3080`
Expected: all pass. Then confirm `git status` is not applicable (no repo) and that `lib/` is current with `src/` by rebuilding and diffing the output.

---

## Self-Review

**Spec coverage.** Spec 2 (acceptance criteria 1-7) maps to Tasks 5, 7, 8 and the Task 8 manual pass. Spec 4 (architecture, no `@deepseek-ai/*` imports, committed unminified `lib/`) maps to Task 2. Spec 5.1 and 5.2 map to Tasks 3, 4 and 5. Spec 5.3's ladder maps to Task 1's decision, Task 5's `route ?? settings.route`, and Task 7's request body — note that Task 7 sends no `route` field; adding it is the one-line follow-up if Task 1 returns `client-service`. Spec 5.4 maps to Tasks 6, 7 and 8. Spec 6's data flow is the sum of Tasks 5, 7 and 8. Spec 7's error handling is Task 5 Step 3's `handleRequest` and Task 7 Step 2's `requestSuggestions` contract. Spec 8's testing maps to Tasks 3, 4, 5, 6 and 9. Spec 9's couplings become Task 9 Step 3's README risks. Spec 10 is explicitly out of scope.

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries the code. The only deferred content is Task 1's seam decision, which is a written deliverable with two named outcomes, not an open question.

**Type consistency.** `SuggestRequest` and `TranscriptMessage` are defined once in Task 3 and consumed by Tasks 4, 5 and 7. `PlaceholderNode` and `applySuggestion` are defined in Task 6 and consumed by Tasks 7 and 8. `HandlerDeps`, `Settings` and `HandlerResult` are defined in Task 5 and used only there and in `test/host.test.mjs`. `TurnOutlineEntry` is defined in Task 6 and consumed in Task 7. `OverlayProps` is defined in Task 6 and consumed in Tasks 7 and 8.
