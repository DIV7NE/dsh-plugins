/**
 * dsh-suggest-next-prompt — host half.
 *
 * Owns exactly one route. It resolves the session's agent, reads that session's
 * live slash-command catalogue, makes ONE auxiliary model call, and returns a
 * validated shortlist of one-line next prompts.
 *
 * The route spends model tokens, so it sits behind the same loopback fence the
 * shipped /api gateway applies. That fence is a DNS-rebinding and cross-site
 * defense, NOT authentication.
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

/** The plugin config carried by the bundle row. */
export interface Config {
  /** Master switch; when false the route is never registered. */
  enabled?: boolean
  /** Explicit route half; supplied with `model` or not at all. */
  provider?: string
  /** Explicit route half; supplied with `provider` or not at all. */
  model?: string
  /** Shortlist length, clamped to 1-3. */
  maxCandidates?: number
  /** Hard deadline per generation, clamped to 500-30000 ms. */
  timeoutMs?: number
  /** Auxiliary output cap, clamped to 32-2000 tokens. */
  maxOutputTokens?: number
  /**
   * Adapter-owned reasoning effort for the auxiliary call. Defaults to 'off',
   * which the DeepSeek adapter maps to thinking-disabled: this call wants a
   * short JSON array, and a thinking pass would spend the whole output budget
   * before emitting any visible text. Set another value only when the route's
   * adapter supports it, or the call will fail terminally and the plugin will
   * stay silent.
   */
  reasoningEffort?: string
}

/** Resolved, clamped settings the handler reads. */
export interface Settings {
  readonly route?: { readonly provider: string; readonly model: string }
  readonly maxCandidates: number
  readonly timeoutMs: number
  readonly maxOutputTokens: number
  readonly reasoningEffort: string
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

/** One agent, narrowed to the identity the handler passes through. */
export interface AgentLike { readonly id?: string }
/** One command descriptor, narrowed to the name the catalogue needs. */
export interface DescriptorLike { readonly name: string }

/** Everything the handler needs, injected so the tests need no server. */
export interface HandlerDeps {
  readonly settings: Settings
  readonly agents: { get(id: string): AgentLike | undefined }
  readonly commands: { list(agent: AgentLike): readonly DescriptorLike[] }
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}

/**
 * Clamp the plugin config into the accepted ranges. A partial route pair is
 * ignored rather than half-applied: there is no meaningful reading of
 * "provider without model".
 * @param config - the plugin row's config.
 * @returns the resolved settings.
 */
function resolveSettings(config?: Config): Settings {
  const provider = typeof config?.provider === 'string' ? config.provider : undefined
  const model = typeof config?.model === 'string' ? config.model : undefined
  const maxCandidates = Math.min(3, Math.max(1, Math.floor(config?.maxCandidates ?? 3)))
  const timeoutMs = Math.min(30000, Math.max(500, Math.floor(config?.timeoutMs ?? 8000)))
  const maxOutputTokens = Math.min(2000, Math.max(32, Math.floor(config?.maxOutputTokens ?? 400)))
  const reasoningEffort = typeof config?.reasoningEffort === 'string' && config.reasoningEffort !== ''
    ? config.reasoningEffort
    : 'off'
  return {
    reasoningEffort,
    ...(provider !== undefined && provider !== '' && model !== undefined && model !== ''
      ? { route: { provider, model } }
      : {}),
    maxCandidates,
    timeoutMs,
    maxOutputTokens,
  }
}

/**
 * Concatenate the text deltas of one auxiliary call.
 * @returns the assembled text, or '' when the call did not finish cleanly.
 */
/** The assembled outcome of one auxiliary call. */
export interface CallOutcome {
  readonly text: string
  /** Terminal finish kind: 'stop', 'max-tokens', 'tool-calls', 'error', 'aborted'. */
  readonly finish: string
  /** Failure message when the terminal reason carries one. */
  readonly failure?: string
}

/**
 * Drain one chunk stream into assembled text.
 *
 * Mirrors the shipped BlockAssembler discipline: never return early, because a
 * \`return\` inside \`for await\` aborts the iterator and discards everything still
 * pending — which silently truncates a streaming reply to whatever arrived
 * first. Text is accumulated per block index from \`text-delta\` chunks and
 * overwritten by an assembled \`block-end\` block, so a non-streaming adapter that
 * emits only whole blocks reads correctly too.
 *
 * \`FinishReason\` is a discriminated union of OBJECTS (\`{ kind: 'stop' }\`,
 * \`{ kind: 'error', failure }\`), never a bare string.
 */
async function collect(
  deps: HandlerDeps,
  route: { provider: string; model: string },
  prompt: { system: string; user: string },
  sessionId: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<CallOutcome> {
  const options = {
    provider: route.provider,
    model: route.model,
    system: prompt.system,
    messages: [{
      id: 'suggest-next-prompt-' + String(Date.now()),
      role: 'user',
      content: [{ type: 'text', text: prompt.user }],
      source: { kind: 'plugin', plugin: 'dsh-suggest-next-prompt' },
    }],
    maxTokens: settings.maxOutputTokens,
    reasoningEffort: settings.reasoningEffort,
    sessionId,
    signal,
  }
  const blocks = new Map<number, string>()
  let fallback = 0
  let finish = 'none'
  let failure: string | undefined
  for await (const chunk of deps.stream(options)) {
    const type = chunk['type']
    const index = typeof chunk['index'] === 'number' ? chunk['index'] : fallback++
    if (type === 'text-delta' && typeof chunk['text'] === 'string') {
      blocks.set(index, (blocks.get(index) ?? '') + chunk['text'])
      continue
    }
    if (type === 'block-end') {
      const block = chunk['block'] as { type?: unknown; text?: unknown } | undefined
      if (block !== undefined && block.type === 'text' && typeof block.text === 'string') {
        blocks.set(index, block.text)
      }
      continue
    }
    if (type === 'finish') {
      const reason = chunk['reason'] as { kind?: unknown; failure?: { message?: unknown } } | undefined
      finish = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
      const message = reason?.failure?.message
      if (typeof message === 'string') failure = message
    }
  }
  const text = [...blocks.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(entry => entry[1])
    .join('')
  return failure === undefined ? { text, finish } : { text, finish, failure }
}

/**
 * Pull the first JSON array out of a model reply.
 * @returns the parsed entries, or an empty list when there is nothing usable.
 */
function extractArray(text: string): readonly unknown[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? (parsed as readonly unknown[]) : []
  } catch {
    return []
  }
}

/**
 * The route body, independent of http plumbing.
 *
 * Every failure that is not a client mistake answers 200 with an empty
 * shortlist: a suggestion feature must never surface an error of its own.
 * @param deps - the injected services.
 * @param request - the decoded request.
 * @returns the status and body to answer with.
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
  const timer = setTimeout(() => { controller.abort() }, deps.settings.timeoutMs)
  let outcome: CallOutcome
  try {
    outcome = await collect(deps, route, prompt, parsed.sessionId, deps.settings, controller.signal)
  } catch {
    return { status: 200, body: { candidates: [] } }
  } finally {
    clearTimeout(timer)
  }
  if (outcome.finish === 'error' || outcome.finish === 'aborted') {
    // A terminal model failure is silence, never a message the user sees.
    return { status: 200, body: { candidates: [] } }
  }
  const candidates = sanitizeCandidates(extractArray(outcome.text), catalogue).slice(0, deps.settings.maxCandidates)
  return { status: 200, body: { candidates } }
}

/** Read the body under a hard ceiling; null means the ceiling was crossed. */
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

/** Answer one JSON response. */
function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** Structural face of the host services this plugin uses. */
export interface HostContext {
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
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