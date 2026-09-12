/**
 * The stylesheet this plugin injects once per activation. It carries two
 * things: the Run button that sits beside DSH's own Copy button in a code
 * block's banner, and the terminal pane's box.
 */
import xtermCss from '@xterm/xterm/css/xterm.css'

/** The plugin's own rules (kept small: DSH's theme variables do the colour work). */
const PLUGIN_CSS = [
  // The action row lays its buttons out inline, so a following sibling needs a
  // real gap: this button is 0-width until then and would sit under Copy.
  '.runterm-run{box-sizing:border-box;display:inline-flex;align-items:center;flex:none;height:16px;margin:0 0 0 6px;',
  'padding:0 6px;border:0;border-radius:3px;color:var(--dsw-alias-label-secondary,#9aa0a6);',
  'background:var(--dsw-alias-bg-layer-1,#2a2a2a);font:inherit;font-size:11px;line-height:1;cursor:pointer}',
  '.runterm-run:hover{color:var(--dsw-alias-label-primary,#e8eaed)}',
  '.runterm-pane{position:relative;display:flex;flex:1;min-height:0;height:100%;flex-direction:column;',
  'background:var(--dsw-alias-bg-base,#1e1e1e)}',
  '.runterm-host{flex:1;min-height:0;padding:6px 0 6px 8px;overflow:hidden}',
  '.runterm-notice{padding:4px 8px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6);',
  'border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}',
  '.runterm-menu{position:fixed;z-index:9999;min-width:190px;padding:4px;border-radius:6px;',
  'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-1,#2a2a2a);',
  'box-shadow:0 8px 24px rgb(0 0 0 / 35%)}',
  '.runterm-menu button{display:block;width:100%;padding:5px 8px;border:0;border-radius:4px;background:none;',
  'color:var(--dsw-alias-label-primary,#e8eaed);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
  '.runterm-menu button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08))}',
  '.runterm-menu button:disabled{color:var(--dsw-alias-label-caption,#6b7075);cursor:default}',
  '.runterm-host .xterm{padding:0}',
].join('')

/** Inject the xterm stylesheet and the plugin's rules once per document. */
export function injectRunStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('dsh-run-in-terminal-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-run-in-terminal-style'
  style.textContent = xtermCss + PLUGIN_CSS
  document.head.appendChild(style)
}
