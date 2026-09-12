/**
 * dsh-suggest-next-prompt — browser half.
 *
 * One contribution: an entry in conversation.input.overlay, which the shipped
 * composer bar renders inside its own card. A fresh id, so the entry is added
 * beside the shipped ones (command-popup, slash-menu, feedback-dialog) and
 * replaces none of them — the slot's published replaceRisk is "none".
 */
import { SuggestOverlay } from './suggest'
import type { ClientContext, OverlayProps } from './types'

/** Required services: the slot registry, and sessions for the route read. */
export const inject = ['slots', 'sessions']

/**
 * Client plugin body.
 * @param ctx - the client context.
 * @returns a disposer releasing the entry.
 */
export function apply(ctx: ClientContext): () => void {
  // The injected face carries the client context through, because the entry
  // needs it for the one service read in route.ts.
  const entry = (props: Omit<OverlayProps, 'ctx'>): JSX.Element => <SuggestOverlay ctx={ctx} {...props} />
  const seat = ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'suggest-next-prompt',
    order: 100,
  }, entry))
  return () => {
    seat()
  }
}