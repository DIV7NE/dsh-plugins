/**
 * The one place this plugin touches the shipped composer's DOM.
 *
 * DSH renders the composer placeholder as a real element:
 *
 *   <div class="..." data-composer-placeholder aria-hidden="true">...</div>
 *
 * There is no placeholder-provider extension point, so the only way to put a
 * suggestion where a placeholder belongs is to write this node's text. Keeping
 * that in one module, behind one function, is what makes the coupling cheap to
 * replace if DSH ever ships the hook.
 *
 * React re-writes the node whenever the shell's own placeholder text changes
 * (plan mode toggling, for example), so callers re-assert on every render.
 * Setting the same text twice is free: the assignment is a no-op and React's
 * own attribute diffing is unaffected.
 */

/** The narrow shape this module needs from the placeholder element. */
export interface PlaceholderNode {
  textContent: string | null
}

/** The selector for the shipped placeholder element. */
export const PLACEHOLDER_SELECTOR = '[data-composer-placeholder]'

/**
 * Locate the placeholder node from anywhere inside the composer card.
 * @param from - an element inside the composer, normally the overlay's own.
 * @returns the node, or null when the composer is not mounted.
 */
export function findPlaceholder(from: Element | null): PlaceholderNode | null {
  if (from === null) return null
  const card = from.closest('[class*="root"], form') ?? from.parentElement
  const found = card?.querySelector(PLACEHOLDER_SELECTOR) ?? null
  return found as unknown as PlaceholderNode | null
}

/**
 * Put a suggestion where the placeholder text goes.
 * @param node - the placeholder node, or null.
 * @param text - the suggestion, or null to leave the node alone.
 * @returns whether the node now shows the text.
 */
export function applySuggestion(node: PlaceholderNode | null, text: string | null): boolean {
  if (node === null || text === null) return false
  if (node.textContent !== text) node.textContent = text
  return true
}
/**
 * The shell's own placeholder text for the composer this element sits in.
 *
 * Read from the editor's \`data-placeholder\` attribute, which the shell keeps
 * authoritative and which this plugin never writes. That makes handing the
 * surface back free: no need to remember what the text was before, and no risk
 * of restoring something stale after the shell changes it (a plan-mode toggle,
 * for example) while a suggestion is showing.
 * @param from - an element inside the composer, normally the overlay's own.
 * @returns the shell's text, or null when it cannot be read.
 */
export function shellPlaceholderText(from: Element | null): string | null {
  if (from === null) return null
  const card = from.closest('[class*="root"], form') ?? from.parentElement
  const editor = card?.querySelector('[data-placeholder]') ?? null
  return editor?.getAttribute('data-placeholder') ?? null
}
