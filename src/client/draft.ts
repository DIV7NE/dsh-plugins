/**
 * Putting terminal output into the conversation draft.
 *
 * The composer is a controlled React textarea, so the only honest way in is
 * the conversation service's own draft store — the same path DSH's `@` picker
 * and the sidebar's reference button use. A missing service or session scope
 * degrades to a logged `false`, never a crash.
 */
import { ATTACH_LIMIT } from './constants'
import type { ClientContext } from './types'

/** The service faces this module reads (structural, resolved with `ctx.get`). */
interface ConversationLike {
  input: {
    for(scope: unknown): {
      state: { getSnapshot(): { draft: string } }
      setDraft(text: string): void
    }
  }
}
interface SessionsLike {
  scope(sessionId: string): unknown
}

/**
 * Build the draft text for one terminal selection: a fenced block whose info
 * line says it is terminal output. The fence widens when the selection itself
 * contains a fence, so the payload can never break out of the block.
 * @param selection - the selected terminal text.
 * @returns the payload, or undefined when there is nothing to attach.
 */
export function selectionPayload(selection: string): string | undefined {
  const text = selection.replace(/\r/g, '').trim()
  if (text === '') return undefined
  const body = text.length > ATTACH_LIMIT
    ? text.slice(0, ATTACH_LIMIT) + '\n… (truncated)'
    : text
  const fence = body.includes('```') ? '````' : '```'
  return fence + 'text\n' + body + '\n' + fence
}

/**
 * Append terminal output to the session's composer draft.
 * @param ctx - the client context.
 * @param sessionId - the session whose draft receives the text.
 * @param selection - the selected terminal text.
 * @returns whether the draft was written.
 */
export function attachSelection(ctx: ClientContext, sessionId: string, selection: string): boolean {
  const payload = selectionPayload(selection)
  if (payload === undefined) return false
  try {
    const sessions = ctx.get('sessions') as SessionsLike | undefined
    const conversation = ctx.get('conversation') as ConversationLike | undefined
    if (sessions === undefined || conversation === undefined) {
      console.warn('[dsh-run-in-terminal] attach skipped: conversation service unavailable')
      return false
    }
    const scope = sessions.scope(sessionId)
    const input = conversation.input.for(scope)
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft.trim() === '' ? payload : draft + ' ' + payload)
    return true
  } catch (error) {
    console.warn('[dsh-run-in-terminal] attach failed:', error)
    return false
  }
}
