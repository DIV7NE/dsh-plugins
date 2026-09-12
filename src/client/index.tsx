/**
 * dsh-run-in-terminal — browser half.
 *
 * Two contributions that share one idea — a code block and a shell should be
 * one gesture apart:
 *
 * 1. a native right-Sidebar tab type (`runterminal`) whose body is the
 *    integrated terminal, registered the way any page type is: the type into
 *    `ctx.sidebarRightTabs`, its body into the keyed
 *    `sidebar.right.pane.tab` seat under the same id;
 * 2. a Run button on every rendered chat code block, which opens that tab and
 *    hands it the snippet as a navigation parameter.
 *
 * The type registration waits on the `sidebarRightTabs` SERVICE rather than
 * on the slot declaration. The seat declares the slot before it provides the
 * registry, so a declaration-triggered registration would read the registry
 * as missing — and the declaration never collapses, so it would register
 * nothing and never retry.
 */
import { registerRunButtons } from './code-run'
import { TERMINAL_ID, TERMINAL_KIND } from './constants'
import { injectRunStyles } from './styles'
import { TerminalView } from './terminal-view'
import type { ClientContext, TabDefinition, TabRegistry } from './types'

/** Client services the registrations need. */
export const inject = ['slots', 'sessions']

/** What the terminal tab body is handed beyond the slot framework's own props. */
interface TerminalInjected {
  readonly ctx: ClientContext
  readonly sessionId: string
}

/**
 * Client plugin body.
 * @param ctx - the client context.
 * @returns a disposer releasing both contributions.
 */
export function apply(ctx: ClientContext): () => void {
  injectRunStyles()

  const seat = ctx.inject(['sidebarRightTabs'], injected => {
    const tabs = injected.get('sidebarRightTabs') as TabRegistry | undefined
    if (tabs === undefined) return
    const definition: TabDefinition = {
      id: TERMINAL_ID,
      kind: TERMINAL_KIND,
      // A type that ships outside the product sits in the extension band.
      priority: 'extension',
      title: () => 'Terminal',
      guide: [{
        order: 200,
        title: () => 'Terminal',
        description: () => 'Run chat code blocks in an integrated shell.',
      }],
    }
    const disposeType = tabs.register(definition)
    const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TERMINAL_ID,
      inject: (sessionId: string): TerminalInjected => ({ ctx, sessionId }),
    }, TerminalView))
    return () => {
      disposeBody()
      disposeType()
    }
  })

  const disposeButtons = registerRunButtons(ctx)

  return () => {
    disposeButtons()
    void seat.dispose()
  }
}
