/**
 * What one composer keystroke should do while a suggestion is showing.
 *
 * Pure, so the decision table is testable without a browser: the DOM wiring in
 * suggest.tsx reads a KeyboardEvent and applies the verdict.
 *
 * Binding, and why:
 *
 * - Tab accepts. That is the gesture this feature exists for, and it must never
 *   be a silent no-op — under the earlier "Tab cycles" scheme a
 *   single-candidate suggestion made Tab do nothing at all, which reads as a
 *   broken feature rather than as a shortlist of one.
 * - Arrows cycle. They are inert in an empty composer, so nothing is stolen,
 *   whereas Ctrl+Tab is claimed by the browser and cannot be intercepted.
 * - Enter is deliberately NOT claimed. It is the composer's submit key, and
 *   sharing it with accept is the one binding that could send a message the
 *   user did not mean to send.
 */

/** What this plugin decided to do with a keystroke. */
export type SuggestKey = 'accept' | 'next' | 'prev' | 'dismiss' | 'ignore'

/** The suggestion state the decision reads. */
export interface KeyState {
  /** Whether a suggestion is currently rendered. */
  readonly visible: boolean
  /** Whether the composer draft is empty (after trim, matching the shell's rule). */
  readonly empty: boolean
}

/** The parts of a KeyboardEvent the decision reads. */
export interface KeyEventLike {
  readonly key: string
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly isComposing?: boolean
}

/**
 * Decide what a keystroke means.
 *
 * Nothing is claimed unless a suggestion is visible and the composer is empty,
 * so ordinary editing is never touched. Composition events are never
 * intercepted, because an IME's own key is part of typing the text the user is
 * composing. Shift+Tab is left to the browser: backwards focus movement is a
 * different gesture, and claiming it here would make Tab mean two things.
 * @param event - the keystroke.
 * @param state - the suggestion state.
 * @returns the verdict for the caller to apply.
 */
export function decideKey(event: KeyEventLike, state: KeyState): SuggestKey {
  if (!state.visible || !state.empty) return 'ignore'
  if (event.isComposing === true) return 'ignore'
  if (event.key === 'Tab') return event.shiftKey ? 'ignore' : 'accept'
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowUp') return 'prev'
  if (event.key === 'Escape') return 'dismiss'
  return 'ignore'
}
