/**
 * The provider/model route this session's next request would use.
 *
 * Source: the host-computed modelSelection projection, read through the session
 * binding. This is the only place the plugin touches session internals, and it
 * is a public face: SessionBinding.session is the outward SessionFace, and
 * ProjectionsFace.faceOf is the documented read path for every projection key.
 * Absence means the projection unit is not mounted, which is a normal outcome
 * and simply falls back to config, then to silence.
 */
import type { SuggestRoute } from '../protocol'
import type { ClientContext } from './types'

/** Client view of the durable model-selection fold. */
interface SelectionProjection {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed?: SuggestRoute | null
  /** Later user selection not yet consumed by a matching model request. */
  readonly next?: SuggestRoute | null
}

/** The sessions-service slice this module reads. */
interface SessionsLike {
  binding(id: string): {
    session: { projections: { faceOf(key: string): { getSnapshot(): unknown } } }
  } | undefined
}

/**
 * Read the session's current route.
 * @param ctx - the client context.
 * @param sessionId - the session on screen.
 * @returns the route, or undefined when it cannot be determined.
 */
export function sessionRoute(ctx: ClientContext, sessionId: string): SuggestRoute | undefined {
  try {
    const sessions = ctx.get('sessions') as SessionsLike | undefined
    if (sessions === undefined) return undefined
    const face = sessions.binding(sessionId)?.session.projections.faceOf('modelSelection')
    const value = face?.getSnapshot() as SelectionProjection | undefined
    const pick = value?.next ?? value?.lastUsed
    if (pick === undefined || pick === null) return undefined
    const provider = pick.provider
    const model = pick.model
    if (typeof provider !== 'string' || provider === '') return undefined
    if (typeof model !== 'string' || model === '') return undefined
    return { provider, model }
  } catch {
    // An unknown session, a missing projection, or a face that throws all mean
    // the same thing here: no route, so the host falls back or stays silent.
    return undefined
  }
}
