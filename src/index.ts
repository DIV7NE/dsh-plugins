/**
 * dsh-run-in-terminal — host half.
 *
 * Owns one persistent PTY per conversation session and bridges it to the
 * browser over a WebSocket, so the client's Run button can paste a chat code
 * block into a real interactive shell and the terminal tab can be closed,
 * switched away from, and reloaded without losing the process.
 *
 * Scope of this half:
 *
 * - `GET /runterm/pty` (WebSocket upgrade) — one pty per `?session=`, get or
 *   create on connect, replayed from a bounded transcript so a page refresh
 *   or a tab switch lands on the same screen.
 * - every request passes the browser-trust fence before it can reach a
 *   shell: this route spawns processes, so a cross-site page must never be
 *   able to drive it (DNS rebinding / drive-by POST defense, not
 *   authentication — the server itself carries neither).
 *
 * Command framing deliberately lives here rather than in the browser: the
 * payload the shell reads has one authority, and it is the piece worth
 * unit-testing.
 *
 * @module dsh-run-in-terminal
 */
import { existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { delimiter, join } from 'node:path'
import type { Duplex } from 'node:stream'
import nodePty from 'node-pty'
import { WebSocketServer, type WebSocket } from 'ws'

/** Services that must be available before the routes can be claimed. */
export const inject = ['webServer']

/** The route namespace this plugin owns (no other plugin may register it). */
const PREFIX = '/runterm'

/** Bytes of terminal output retained per session for reconnect replay. */
export const TRANSCRIPT_LIMIT = 1 << 18

/** Accepted pty geometry bounds (a bad frame must never resize below 2). */
const DIM = { colsMin: 2, colsMax: 1000, rowsMin: 2, rowsMax: 400 }

/** The plugin config carried by the bundle's cordis row. */
export interface Config {
  /** Explicit shell executable; the platform default when omitted. */
  shell?: string
}

/** Structural face of the host webserver service this plugin uses. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
}

/** Structural face of the host context (this package imports no cordis). */
export interface HostContext {
  webServer: WebServerLike
  effect(callback: () => void | (() => void), label?: string): void
}

/** One live terminal and its connected viewers. */
interface Terminal {
  readonly sessionId: string
  readonly cwd: string
  readonly pty: nodePty.IPty
  readonly clients: Set<WebSocket>
  transcript: string
  exited: boolean
}

/**
 * Normalize a pasted snippet into the byte sequence a shell expects.
 *
 * A terminal delivers Enter as CR and the shell's line discipline turns it
 * back into a newline, so every line ending becomes CR and one final CR
 * submits the snippet. Trailing blank lines are dropped first: a snippet that
 * already ends in a newline would otherwise submit an extra empty command.
 * A backslash continuation — the shape long commands take in chat code
 * blocks — survives intact, because the shell receives backslash CR and
 * joins the lines exactly as it would from a keyboard.
 *
 * @param code - the raw snippet as rendered in the chat code block.
 * @returns the bytes to write to the pty.
 */
export function pastePayload(code: string): string {
  const body = code.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  return body.replace(/\n/g, '\r') + '\r'
}

/**
 * Append output to a transcript, keeping only the newest bytes.
 * @param transcript - the current transcript.
 * @param data - newly received output.
 * @returns the bounded transcript.
 */
export function appendTranscript(transcript: string, data: string): string {
  const next = transcript + data
  return next.length > TRANSCRIPT_LIMIT ? next.slice(next.length - TRANSCRIPT_LIMIT) : next
}

/** Clamp one requested dimension into the accepted pty range. */
function clampDim(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Whether a URL hostname names the local loopback authority. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * The browser-trust fence guarding the terminal routes.
 *
 * The Host header must name a loopback authority (a request addressed to a
 * name that merely resolves here from elsewhere is a DNS-rebinding attempt),
 * a browser that marks the request cross-site is refused, and an Origin, when
 * present, must name the same hostname. An absent Origin is fine: the Host
 * fence above already bound the request, and non-browser clients send none.
 * This mirrors the fence the shipped `/api` gateway applies to its own routes.
 *
 * @param headers - the request headers.
 * @returns whether the request may reach a shell.
 */
export function isTrustedRequest(headers: IncomingMessage['headers']): boolean {
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

/** First executable of `name` on PATH, or undefined. */
function whichOnPath(name: string): string | undefined {
  const path = process.env.PATH ?? ''
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * The interactive shell for this platform, resolved the way a terminal
 * emulator does: the configured shell wins, then PowerShell 7 on Windows
 * (the inbox 5.1 is the fallback), then `$SHELL` on POSIX, then `/bin/bash`.
 * @param configured - the plugin's `config.shell`, when given.
 * @returns the executable and its startup arguments.
 */
export function resolveShell(configured?: string): { file: string; args: string[] } {
  const trimmed = typeof configured === 'string' ? configured.trim() : ''
  const explicit = trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"'
    ? trimmed.slice(1, -1)
    : trimmed
  if (explicit !== '') return { file: explicit, args: process.platform === 'win32' ? [] : ['-l'] }
  if (process.platform === 'win32') {
    return { file: whichOnPath('pwsh.exe') ?? 'powershell.exe', args: [] }
  }
  const shell = process.env.SHELL?.trim()
  return { file: shell !== undefined && shell !== '' ? shell : '/bin/bash', args: ['-l'] }
}

/** The requested working directory when it is a real directory, else the server's own. */
function resolveCwd(requested: string | null): string {
  if (requested !== null && requested !== '' && requested.length < 4096) {
    try {
      if (statSync(requested).isDirectory()) return requested
    } catch {
      // Unreadable or absent: fall through to the server's own directory.
    }
  }
  return process.cwd()
}

/** Send one JSON frame, tolerating a socket that has already gone away. */
function sendFrame(ws: WebSocket, frame: unknown): void {
  try {
    ws.send(JSON.stringify(frame))
  } catch {
    // The socket closed between the check and the write.
  }
}

/**
 * Host plugin body: claim the upgrade route and own the terminal registry.
 * @param ctx - the host context (webserver + effects).
 * @param config - the plugin row's config.
 */
export function apply(ctx: HostContext, config?: Config): void {
  const terminals = new Map<string, Terminal>()
  const shell = resolveShell(config?.shell)

  const kill = (terminal: Terminal): void => {
    if (terminals.get(terminal.sessionId) === terminal) terminals.delete(terminal.sessionId)
    try {
      terminal.pty.kill()
    } catch {
      // Already gone.
    }
  }

  const create = (sessionId: string, url: URL): Terminal => {
    const cols = clampDim(url.searchParams.get('cols'), DIM.colsMin, DIM.colsMax, 80)
    const rows = clampDim(url.searchParams.get('rows'), DIM.rowsMin, DIM.rowsMax, 24)
    const cwd = resolveCwd(url.searchParams.get('cwd'))
    const pty = nodePty.spawn(shell.file, [...shell.args], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    })
    const terminal: Terminal = { sessionId, cwd, pty, clients: new Set(), transcript: '', exited: false }
    terminals.set(sessionId, terminal)
    pty.onData(data => {
      terminal.transcript = appendTranscript(terminal.transcript, data)
      for (const client of terminal.clients) sendFrame(client, { t: 'data', d: data })
    })
    pty.onExit(event => {
      terminal.exited = true
      for (const client of terminal.clients) sendFrame(client, { t: 'exit', code: event.exitCode })
    })
    return terminal
  }

  ctx.effect(() => {
    const wss = new WebSocketServer({ noServer: true })

    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url ?? PREFIX + '/pty', 'http://localhost')
      const sessionId = url.searchParams.get('session') ?? ''
      if (sessionId === '') {
        ws.close(1008, 'missing session')
        return
      }
      let terminal = terminals.get(sessionId)
      if (terminal === undefined || terminal.exited) {
        if (terminal !== undefined) terminals.delete(sessionId)
        try {
          terminal = create(sessionId, url)
        } catch (error) {
          sendFrame(ws, { t: 'error', message: 'cannot start ' + shell.file + ': ' + String(error) })
          ws.close(1011, 'spawn failed')
          return
        }
      }
      // Single-threaded: no output can be emitted between the replay and the
      // subscription, so the viewer sees the history exactly once.
      sendFrame(ws, { t: 'data', d: terminal.transcript })
      terminal.clients.add(ws)
      sendFrame(ws, { t: 'ready', shell: shell.file, cwd: terminal.cwd })

      ws.on('message', (raw: unknown) => {
        let frame: unknown
        try {
          frame = JSON.parse(String(raw))
        } catch {
          return
        }
        if (typeof frame !== 'object' || frame === null) return
        const message = frame as { t?: unknown; d?: unknown; code?: unknown; cols?: unknown; rows?: unknown }
        const live = terminals.get(sessionId)
        if (live === undefined || live.exited) return
        if (message.t === 'input' && typeof message.d === 'string') {
          live.pty.write(message.d)
        } else if (message.t === 'run' && typeof message.code === 'string') {
          live.pty.write(pastePayload(message.code))
        } else if (message.t === 'resize') {
          try {
            live.pty.resize(
              clampDim(message.cols, DIM.colsMin, DIM.colsMax, 80),
              clampDim(message.rows, DIM.rowsMin, DIM.rowsMax, 24),
            )
          } catch {
            // The pty exited between the guard and the call.
          }
        } else if (message.t === 'kill') {
          kill(live)
        }
      })

      const forget = (): void => {
        terminal?.clients.delete(ws)
      }
      ws.on('close', forget)
      ws.on('error', forget)
    })

    const disposeRoute = ctx.webServer.registerUpgrade({
      path: PREFIX + '/pty',
      handler: (req, socket, head) => {
        if (!isTrustedRequest(req.headers)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, ws => {
          wss.emit('connection', ws, req)
        })
      },
    })

    return () => {
      disposeRoute()
      for (const terminal of [...terminals.values()]) kill(terminal)
      terminals.clear()
      wss.close()
    }
  }, 'dsh-run-in-terminal: pty route')
}
