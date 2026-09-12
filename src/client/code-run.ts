/**
 * The Run button injected into every chat code block.
 *
 * DSH renders a fenced block as
 *
 *   div.md-code-block
 *     > div[data-code-block-banner]
 *         > div                        <- the action row
 *             > button                 <- DSH's own Copy button
 *     > div[data-code-block-content]
 *
 * The chat owns that DOM and exposes no slot for code-block actions, so the
 * button is attached from the outside and re-attached whenever a re-render
 * replaces the node. A marker attribute makes each pass idempotent, and the
 * observer is debounced to one animation frame because streaming answers
 * mutate the transcript continuously.
 *
 * The code itself is read back as `textContent` of the content node. Line
 * numbers are drawn by a CSS counter (`::before`), never as DOM text, so
 * this is the exact snippet and not a numbered copy of it.
 */
import { TERMINAL_KIND } from './constants'
import type { ClientContext } from './types'

/** Marker attribute set on a block that already carries a Run button. */
const MARK = 'data-runterm'

/** The class DSH puts on a rendered fenced code block. */
const BLOCK = '.md-code-block'

/** The button class, used by the stylesheet and the cleanup pass. */
const BUTTON = 'runterm-run'

/** The snippet of one rendered block, exactly as the author wrote it. */
function codeOf(block: HTMLElement): string {
  return block.querySelector('[data-code-block-content]')?.textContent ?? ''
}

/**
 * Open this session's terminal and paste a snippet into it.
 *
 * `openTab` acts on the session the mounted right Sidebar is showing, which
 * is the session whose code block was clicked; a page kind deduplicates, so
 * clicking Run again lands in the same terminal and only bumps the
 * navigation revision the body watches.
 *
 * @param ctx - the client context.
 * @param code - the snippet to run.
 */
export function openInTerminal(ctx: ClientContext, code: string): void {
  const text = code.trim()
  if (text === '') return
  const sidebarRight = ctx.get('sidebarRight') as
    | { openTab?: (kind: string, options?: { params?: unknown }) => void }
    | undefined
  if (typeof sidebarRight?.openTab !== 'function') {
    console.warn('[dsh-run-in-terminal] sidebarRight is unavailable; cannot open the terminal')
    return
  }
  try {
    sidebarRight.openTab(TERMINAL_KIND, { params: { run: text } })
  } catch (error) {
    console.warn('[dsh-run-in-terminal] openTab failed:', error)
  }
}

/**
 * Watch the document for rendered code blocks and give each one a Run button.
 * @param ctx - the client context.
 * @returns a disposer that removes the buttons and the observer.
 */
export function registerRunButtons(ctx: ClientContext): () => void {
  if (typeof document === 'undefined') return () => {}
  let scheduled = false

  const scan = (): void => {
    scheduled = false
    for (const block of Array.from(document.querySelectorAll<HTMLElement>(BLOCK))) {
      if (block.getAttribute(MARK) === '1') continue
      const action = block.querySelector('[data-code-block-banner]')?.lastElementChild
      if (!(action instanceof HTMLElement)) continue
      if (block.querySelector('[data-code-block-content]') === null) continue
      block.setAttribute(MARK, '1')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = BUTTON
      button.textContent = 'Run'
      button.title = 'Paste into the integrated terminal'
      button.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        openInTerminal(ctx, codeOf(block))
      })
      action.appendChild(button)
    }
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scan)
    else setTimeout(scan, 0)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  scan()

  return () => {
    observer.disconnect()
    for (const button of Array.from(document.querySelectorAll('.' + BUTTON))) button.remove()
    for (const block of Array.from(document.querySelectorAll<HTMLElement>(BLOCK))) block.removeAttribute(MARK)
  }
}
