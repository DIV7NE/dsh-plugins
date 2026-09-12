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

/** Whether a parse answer is a refusal rather than a request. */
export function isFailure(value: SuggestRequest | ProtocolFailure): value is ProtocolFailure {
  return (value as ProtocolFailure).error !== undefined
}

/** Validate the optional route pair; undefined = absent, null = malformed. */
function parseRoute(value: unknown): SuggestRoute | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const provider = record['provider']
  const model = record['model']
  if (typeof provider !== 'string' || provider.length === 0 || provider.length > 128) return null
  if (typeof model !== 'string' || model.length === 0 || model.length > 256) return null
  return { provider, model }
}

/**
 * Validate one request body. Rejects rather than repairs: a body over the byte
 * ceiling is refused, not truncated, because a silently shortened transcript
 * would produce a confidently wrong suggestion.
 * @param raw - the parsed JSON body, of unknown shape.
 * @param byteLength - the body's exact size on the wire.
 * @returns the request, or a refusal carrying the status to answer with.
 */
export function parseRequest(raw: unknown, byteLength: number): SuggestRequest | ProtocolFailure {
  if (byteLength > MAX_BODY_BYTES) return { status: 413, error: 'body too large' }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { status: 400, error: 'body must be an object' }
  }
  const body = raw as Record<string, unknown>
  for (const key of Object.keys(body)) {
    if (key !== 'sessionId' && key !== 'transcript' && key !== 'route') {
      return { status: 400, error: 'unknown field: ' + key }
    }
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
    if (typeof entry !== 'object' || entry === null) {
      return { status: 400, error: 'transcript entry must be an object' }
    }
    const record = entry as Record<string, unknown>
    const role = record['role']
    const text = record['text']
    if (role !== 'user' && role !== 'assistant') {
      return { status: 400, error: 'role must be user or assistant' }
    }
    if (typeof text !== 'string') return { status: 400, error: 'text must be a string' }
    if (utf8Bytes(text) > MAX_MESSAGE_BYTES) return { status: 400, error: 'message too large' }
    messages.push({ role, text })
  }
  const route = parseRoute(body['route'])
  if (route === null) {
    return { status: 400, error: 'route must carry non-empty provider and model strings' }
  }
  return route === undefined
    ? { sessionId, transcript: messages }
    : { sessionId, transcript: messages, route }
}

/** Whether a hostname names the local loopback authority. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * The browser-trust fence guarding the route.
 *
 * The Host header must name a loopback authority (a name that merely resolves
 * here from elsewhere is a DNS-rebinding attempt), a request a browser marks
 * cross-site is refused, and an Origin, when present, must name the same
 * hostname. This is a cross-site defense, NOT authentication: any loopback page
 * on the same hostname passes. Ported unchanged from dsh-run-in-terminal, which
 * mirrors the fence the shipped /api gateway applies to its own routes.
 * @param headers - the request headers.
 * @returns whether the request may reach a model call.
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
 * @param values - the model's parsed output, of unknown shape.
 * @param catalogue - the live command names for this session.
 * @returns the surviving candidates, ranked as they arrived.
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
 * instruction and the exact serialized transcript, and so the byte ceiling is a
 * property of one function rather than of a call site.
 * @param request - the validated request.
 * @param catalogue - the live command names for this session.
 * @returns the system instruction and the user payload.
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
