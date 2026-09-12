/**
 * The overlay entry: trigger, render, and the placeholder write.
 *
 * This element occupies no layout of its own and renders nothing. It exists for
 * one reason: to be inside the composer card, so the shipped placeholder node is
 * reachable from it. The suggestion is written into that node, which already
 * carries the shell's colour, position, ellipsis and hide-when-nonempty
 * behaviour.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { requestSuggestions } from './fetch'
import { applySuggestion, findPlaceholder, shellPlaceholderText } from './placeholder'
import { decideKey } from './keys'
import { sessionRoute } from './route'
import { buildTranscript, lastTurnComplete, newestTurn } from './transcript'
import type { OverlayProps } from './types'

/**
 * Render the composer entry and drive the suggestion lifecycle.
 * @param props - the slot framework's standard props.
 * @returns the chip element, or null.
 */
export function SuggestOverlay({ useInput, useSession, useProjection, inputActions, ctx, sessionId }: OverlayProps): JSX.Element | null {
  const draft = useInput(state => state.draft)
  const running = useSession(session => session.running)
  const removed = useSession(session => session.removed)
  const outline = useProjection('turnOutline')

  const hostRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** The newest turn a suggestion has already been generated for. */
  const generatedForRef = useRef<number | null>(null)
  const [candidates, setCandidates] = useState<readonly string[]>([])
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const empty = draft.trim() === ''

  // One generation per FINISHED TURN, and nothing else.
  //
  // The identity here is the turn number, deliberately not the outline array.
  // Depending on the array re-ran this effect whenever the projection store
  // re-published it, and whenever the composer emptied again (paste with Tab,
  // delete, and the draft is empty once more) — each run aborting the previous
  // request and issuing a new one, so the suggestion visibly changed under the
  // user for a turn it had already answered.
  const finishedTurn = lastTurnComplete(outline) ? newestTurn(outline) : null
  useEffect(() => {
    if (running || removed || dismissed || !empty) return
    if (finishedTurn === null) return
    if (generatedForRef.current === finishedTurn) return
    generatedForRef.current = finishedTurn
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
  }, [running, removed, dismissed, empty, finishedTurn, sessionId, ctx])

  // A dismissed suggestion comes back when a new turn starts.
  useEffect(() => {
    if (running) setDismissed(false)
  }, [running])

  const position = candidates.length > 0 ? index % candidates.length : 0
  const candidate = empty && !dismissed && candidates.length > 0
    ? candidates[position] ?? null
    : null
  // The shortlist position rides the placeholder text rather than a second
  // positioned element: an absolutely-placed chip landed on top of the send
  // button at the card's bottom-right, and the placeholder is already the one
  // surface this plugin owns. With a single candidate there is nothing to
  // count, so the text stays clean.
  const suggestion = candidate === null
    ? null
    : candidates.length > 1
      ? String(position + 1) + '/' + String(candidates.length) + ' \u00b7 ' + candidate
      : candidate
  // What accept pastes is the candidate itself, never the decorated display text.
  const accepted = candidate

  // Re-asserted on every render: React re-writes the placeholder node whenever
  // the shell's own placeholder text changes (a plan-mode toggle, for example).
  // When there is no suggestion to show, the shell's own text is written back,
  // so a released suggestion never leaves its text behind on the composer.
  useEffect(() => {
    const node = findPlaceholder(hostRef.current)
    if (suggestion !== null) {
      applySuggestion(node, suggestion)
      return
    }
    const shellText = shellPlaceholderText(hostRef.current)
    if (shellText !== null) applySuggestion(node, shellText)
  })

  const cycle = useCallback((delta: number) => {
    setIndex(current => (current + delta + candidates.length) % Math.max(1, candidates.length))
  }, [candidates.length])

  // The draft writer is held in a ref so the listener below does not re-bind
  // whenever the action face's identity changes.
  const setDraftRef = useRef(inputActions.setDraft)
  useEffect(() => {
    setDraftRef.current = inputActions.setDraft
  }, [inputActions])

  // One capture-phase listener on the DOCUMENT, gated on the keystroke coming
  // from the composer's own editable surface.
  //
  // Two things matter here, and the first version got both wrong:
  //
  // 1. The seat must be the document, not an element found by walking up from
  //    this component. The composer's DOM is card > [overlayAnchor, scroll >
  //    grow > input], so the editor is in a SIBLING subtree of the overlay and
  //    is not reachable from it at all. The overlay's own ancestry is not a
  //    path to the editor, and assuming it was meant the listener never
  //    attached.
  // 2. Capture phase on the document is the only seat that runs before BOTH the
  //    shipped Lexical keymap (bound on the editor) and the browser's own Tab
  //    focus navigation, which is a default action only preventDefault stops.
  useEffect(() => {
    if (suggestion === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (!(target instanceof Element) || target.closest('[data-placeholder]') === null) return
      const verdict = decideKey(event, { visible: true, empty: true })
      if (verdict === 'ignore') return
      event.preventDefault()
      event.stopPropagation()
      if (verdict === 'next') cycle(1)
      else if (verdict === 'prev') cycle(-1)
      else if (verdict === 'accept') {
        // Fill the draft but KEEP the shortlist. The plugin never submits, and
        // the suggestion is not consumed by being used: clear the text again and
        // it is still there to paste a second time. Only an explicit Escape
        // dismisses it, and only a new turn replaces it.
        if (accepted !== null) setDraftRef.current(accepted)
      } else {
        setCandidates([])
        setDismissed(true)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [suggestion, cycle])

  // A zero-size mount point, nothing more: it exists so findPlaceholder has an
  // element inside the composer card to search from.
  return <div ref={hostRef} className="dsh-suggest-host" />
}