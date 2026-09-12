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
 * @param route - the session's route, when it could be read.
 * @param signal - cancellation, fired when the turn changes or the component unmounts.
 * @param path - the route path; overridable for the live probe.
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
