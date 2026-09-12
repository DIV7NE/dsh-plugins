/**
 * Structural mirrors of the DSH browser faces this plugin touches.
 *
 * Everything here is what the plugin actually reads, not a copy of the upstream
 * contract. The package is built and installed out of tree, so it imports no
 * @deepseek-ai module at all — value or type.
 */
import type { ReactNode } from 'react'

/** One entry of the turnOutline session projection. */
export interface TurnOutlineEntry {
  readonly turn: number
  readonly seq: number
  /** Bounded first-human-prompt preview; '' until an eligible prompt lands. */
  readonly prompt: string
  /** Bounded final-response preview; '' until the turn ends with assistant text. */
  readonly response: string
}

/** Reader for one session projection key. */
export type UseProjection = (key: 'turnOutline') => readonly TurnOutlineEntry[] | undefined

/** Selector hook over the per-session input state. */
export type UseInput = <S>(selector: (state: InputState) => S, eq?: (a: S, b: S) => boolean) => S

/** The published composer input state, restricted to what this plugin reads. */
export interface InputState {
  readonly draft: string
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
}

/** Selector hook over the per-session lifecycle snapshot. */
export type UseSession = <S>(selector: (session: SessionSnapshot) => S, eq?: (a: S, b: S) => boolean) => S

/** The Session lifecycle facts this plugin reads. */
export interface SessionSnapshot {
  readonly sessionId: string
  readonly running: boolean
  readonly removed: boolean
}

/** The public composer action face; this plugin uses setDraft alone. */
export interface InputActions {
  setDraft(text: string): void
  submit(): void
}

/** The Cordis client context face this plugin uses. */
export interface ClientContext {
  get(name: string): unknown
  inject(names: readonly string[], callback: (injected: ClientContext) => void | (() => void)): { dispose(): void | Promise<void> }
  effect(callback: () => void | (() => void), label?: string): void
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(registration: unknown, component: unknown): () => void
  }
}

/**
 * Props of a conversation.input.overlay entry.
 *
 * The hooks, inputActions and sessionId are standard props the slot framework
 * supplies. `ctx` is this plugin's own inject face: the registration passes the
 * client context through, exactly as the sibling run-in-terminal plugin does its
 * tab body, because the entry needs it for the one service read in route.ts.
 */
export interface OverlayProps {
  readonly ctx: ClientContext
  readonly useInput: UseInput
  readonly useSession: UseSession
  readonly inputActions: InputActions
  readonly useProjection: UseProjection
  readonly sessionId: string
  readonly children?: ReactNode
}
