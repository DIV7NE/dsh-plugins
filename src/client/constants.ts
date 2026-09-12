/**
 * The vocabulary the client half's two halves share (the code-block injection
 * and the terminal tab), kept in one module so neither imports the other.
 */

/** The page kind this plugin owns in the right Sidebar (`openTab` names it). */
export const TERMINAL_KIND = 'runterminal'

/** The tab type's implementation id — the key its body registers under. */
export const TERMINAL_ID = 'dsh-run-in-terminal:terminal'

/** The host half's WebSocket route. */
export const WS_PATH = '/runterm/pty'

/** Longest terminal selection attached to the composer draft (characters). */
export const ATTACH_LIMIT = 4000
