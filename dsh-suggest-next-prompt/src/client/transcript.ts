/**
 * The transcript the host is given.
 *
 * Source: the turnOutline session projection, which the host computes and the
 * client reads through the standard useProjection prop. Each entry carries a
 * bounded first-human-prompt preview and a bounded final-response preview, so
 * the window is a summary rather than full text. That is the right trade for
 * "what should the user say next": cheaper, and focused on the turn substance
 * rather than on long tool transcripts. The projection is undefined when its
 * unit is not mounted, which simply means no suggestion.
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
/**
 * Whether the newest turn has actually finished.
 *
 * The turn outline carries an entry for the turn that is currently open, with an
 * empty \`response\` until that turn ends with assistant text. Requiring a
 * non-empty response on the newest entry is therefore the strongest available
 * "it is the user's turn now" signal: it is false while the agent streams, false
 * between steps, and true only once a reply has landed.
 * @param entries - the turnOutline projection value, possibly undefined.
 * @returns whether the newest turn carries a completed response.
 */
export function lastTurnComplete(entries: readonly TurnOutlineEntry[] | undefined): boolean {
  if (entries === undefined || entries.length === 0) return false
  const last = entries[entries.length - 1]
  return last !== undefined && last.response.trim() !== ''
}
/**
 * The newest turn's number, or null when there is no turn to speak of.
 *
 * This is the identity a suggestion belongs to. Depending on the turn NUMBER
 * rather than on the outline array keeps the generation effect stable: the array
 * can be re-published by the projection store without the turn having changed at
 * all, and re-running on that would issue a fresh request for a turn it already
 * answered — which is exactly how a suggestion comes to change under the user.
 * @param entries - the turnOutline projection value, possibly undefined.
 * @returns the newest turn number, or null.
 */
export function newestTurn(entries: readonly TurnOutlineEntry[] | undefined): number | null {
  if (entries === undefined || entries.length === 0) return null
  const last = entries[entries.length - 1]
  return last === undefined ? null : last.turn
}
