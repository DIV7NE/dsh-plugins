/**
 * Structural mirrors of the DSH client faces this plugin uses.
 *
 * The package deliberately imports no `@deepseek-ai/*` runtime or type
 * module: the plugin is built and installed out of tree, and the surfaces it
 * touches are small and stable enough to restate. Everything here is what the
 * plugin actually reads, not a copy of the upstream contract.
 */
import type { ReactNode } from 'react'

/** The client context face this plugin uses. */
export interface ClientContext {
  /** Cordis service read (non-reactive). */
  get(name: string): unknown
  /** Wait for services to exist before running the callback. */
  inject(names: readonly string[], callback: (injected: ClientContext) => void | (() => void)): { dispose(): void | Promise<void> }
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(registration: unknown, component: unknown): () => void
  }
  sessions: {
    list: {
      getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> }
      subscribe(listener: () => void): () => void
    }
  }
}

/** One native right-Sidebar tab type's static registration. */
export interface TabDefinition {
  id: string
  kind: string
  priority?: 'extension' | 'builtin' | 'fallback'
  title: (address: string) => string
  guide?: ReadonlyArray<{ order: number; title: () => string; description?: () => string }>
}

/** The right-Sidebar tab-type registry (`ctx.sidebarRightTabs`). */
export interface TabRegistry {
  register(definition: TabDefinition): () => void
}

/** The navigation the last `openTab` recorded on a tab. */
export interface TabNavigation {
  readonly address: string
  readonly params: unknown
  readonly revision: number
}

/** What the slot framework hands a tab body through `useTabInfo`. */
export interface TabInfo {
  readonly tab: {
    readonly id: string
    readonly kind: string
    readonly title: string
    readonly visible: boolean
    readonly navigation: TabNavigation
    readonly signal: AbortSignal
  }
}

/** The props the terminal body receives (framework hook + this plugin's inject face). */
export interface TerminalViewProps {
  readonly ctx: ClientContext
  readonly sessionId: string
  readonly useTabInfo: () => TabInfo
  readonly children?: ReactNode
}
