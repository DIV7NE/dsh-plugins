/**
 * The integrated terminal pane: one xterm bound to the session's pty.
 *
 * The pane is a right-Sidebar tab body, so it mounts and unmounts with the
 * tab's visibility while the pty itself lives on in the host. Every mount
 * reconnects and the host replays its transcript first, which is why
 * switching tabs or reloading the page lands back on the same screen without
 * the component keeping any state between lives.
 *
 * Right-clicking opens the pane's own menu — attach the selection to the
 * conversation, copy, paste, select all — because the terminal is a canvas
 * of cells rather than selectable DOM, so the browser's menu is not much use
 * inside it.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { WS_PATH } from './constants'
import { attachSelection } from './draft'
import type { ClientContext, TerminalViewProps } from './types'

/** One frame from the host, as far as this pane cares. */
interface Frame {
  t?: unknown
  d?: unknown
  code?: unknown
  message?: unknown
}

/** Parse a socket frame without trusting its shape. */
function parseFrame(data: unknown): Frame | undefined {
  if (typeof data !== 'string') return undefined
  try {
    const frame: unknown = JSON.parse(data)
    return typeof frame === 'object' && frame !== null ? frame as Frame : undefined
  } catch {
    return undefined
  }
}

/** The session's workspace root, when the client session list knows it. */
function cwdOf(ctx: ClientContext, sessionId: string): string | undefined {
  try {
    const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
    return typeof summary?.cwd === 'string' ? summary.cwd : undefined
  } catch {
    return undefined
  }
}

/** The pty route's WebSocket URL for one session. */
function socketUrl(sessionId: string, cwd: string | undefined): string {
  const url = new URL(WS_PATH, window.location.href)
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('session', sessionId)
  if (cwd !== undefined) url.searchParams.set('cwd', cwd)
  return url.toString()
}

/**
 * xterm paints on its own canvas, so its colours cannot come from the
 * stylesheet: read the few theme aliases DSH publishes on the document root
 * and fall back to a neutral dark set when there is nothing to read.
 */
function terminalTheme(): ITheme {
  const style = typeof document === 'undefined' ? undefined : getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => {
    const value = style?.getPropertyValue(name).trim()
    return value === undefined || value === '' ? fallback : value
  }
  return {
    background: read('--dsw-alias-bg-base', '#1e1e1e'),
    foreground: read('--dsw-alias-label-primary', '#d6d6d6'),
    cursor: read('--dsw-alias-label-primary', '#d6d6d6'),
    selectionBackground: read('--dsw-alias-bg-layer-2', 'rgb(255 255 255 / 18%)'),
  }
}

/** Normalize clipboard text into what a shell reads as typed input. */
function pasteText(text: string): string {
  return text.replace(/\r?\n/g, '\r')
}

/** The one terminal pane this plugin draws. */
export function TerminalView(props: TerminalViewProps): ReactNode {
  const { ctx, sessionId, useTabInfo } = props
  const tab = useTabInfo().tab
  const revision = tab.navigation.revision
  const params = tab.navigation.params as { run?: unknown } | undefined
  const runRequest = typeof params?.run === 'string' && params.run.trim() !== '' ? params.run : undefined

  const hostRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const queueRef = useRef<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; selection: boolean } | null>(null)

  /** Write a frame, queueing it until the socket is up. */
  const send = (frame: unknown): void => {
    const socket = socketRef.current
    if (socket === null) return
    const text = JSON.stringify(frame)
    if (socket.readyState === WebSocket.OPEN) socket.send(text)
    else if (socket.readyState === WebSocket.CONNECTING) queueRef.current.push(text)
  }

  /** Resize the pty to the pane, once the pane is actually measurable. */
  const refit = (): void => {
    const host = hostRef.current
    const fit = fitRef.current
    if (host === null || fit === null) return
    if (host.clientWidth < 24 || host.clientHeight < 24) return
    try {
      fit.fit()
    } catch {
      // Collapsed or mid-layout: the next observation fits it.
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const onData = term.onData(data => { send({ t: 'input', d: data }) })
    const onResize = term.onResize(({ cols, rows }) => { send({ t: 'resize', cols, rows }) })

    const socket = new WebSocket(socketUrl(sessionId, cwdOf(ctx, sessionId)))
    socketRef.current = socket
    socket.addEventListener('open', () => {
      const pending = queueRef.current
      queueRef.current = []
      for (const text of pending) socket.send(text)
      refit()
    })
    socket.addEventListener('message', event => {
      const frame = parseFrame(event.data)
      if (frame === undefined) return
      if (frame.t === 'data' && typeof frame.d === 'string') {
        term.write(frame.d)
      } else if (frame.t === 'error' && typeof frame.message === 'string') {
        setNotice(frame.message)
      } else if (frame.t === 'exit') {
        setNotice('shell exited' + (typeof frame.code === 'number' ? ' (code ' + frame.code + ')' : ''))
      }
    })
    socket.addEventListener('close', () => {
      if (socketRef.current === socket) setNotice('terminal disconnected')
    })

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { refit() }) : undefined
    observer?.observe(host)
    refit()

    return () => {
      observer?.disconnect()
      onData.dispose()
      onResize.dispose()
      socketRef.current = null
      queueRef.current = []
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [ctx, sessionId])

  // The pane keeps its columns while it is hidden; refit as it comes back.
  useEffect(() => {
    if (tab.visible) refit()
  }, [tab.visible])

  // A fresh navigation carrying a snippet IS the Run request.
  useEffect(() => {
    if (runRequest === undefined) return
    send({ t: 'run', code: runRequest })
  }, [revision])

  // Closing the tab (not hiding it) is what ends the process.
  useEffect(() => {
    const signal = tab.signal
    const onAbort = (): void => { send({ t: 'kill' }) }
    signal.addEventListener('abort', onAbort)
    return () => signal.removeEventListener('abort', onAbort)
  }, [tab.signal])

  useEffect(() => {
    if (menu === null) return
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node) === true) return
      setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  const selection = (): string => termRef.current?.getSelection() ?? ''

  const onAttach = (): void => {
    const text = selection()
    setMenu(null)
    if (text === '') return
    if (!attachSelection(ctx, sessionId, text)) setNotice('could not reach the composer draft')
  }

  const onCopy = (): void => {
    const text = selection()
    setMenu(null)
    if (text === '') return
    void navigator.clipboard.writeText(text).catch(() => { setNotice('clipboard write refused') })
  }

  const onPaste = (): void => {
    setMenu(null)
    void navigator.clipboard.readText()
      .then(text => { if (text !== '') send({ t: 'input', d: pasteText(text) }) })
      .catch(() => { setNotice('clipboard read refused') })
  }

  const onSelectAll = (): void => {
    setMenu(null)
    termRef.current?.selectAll()
  }

  return (
    <div className="runterm-pane">
      {notice === null ? null : <div className="runterm-notice">{notice}</div>}
      <div
        ref={hostRef}
        className="runterm-host"
        onContextMenu={event => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY, selection: selection() !== '' })
        }}
      />
      {menu === null ? null : (
        <div ref={menuRef} className="runterm-menu" style={{ left: menu.x, top: menu.y }}>
          <button type="button" disabled={!menu.selection} onClick={onAttach}>Attach selection as context</button>
          <button type="button" disabled={!menu.selection} onClick={onCopy}>Copy</button>
          <button type="button" onClick={onPaste}>Paste</button>
          <button type="button" onClick={onSelectAll}>Select all</button>
        </div>
      )}
    </div>
  )
}
