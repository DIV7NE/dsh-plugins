// src/client/placeholder.ts
var PLACEHOLDER_SELECTOR = "[data-composer-placeholder]";
function findPlaceholder(from) {
  if (from === null) return null;
  const card = from.closest('[class*="root"], form') ?? from.parentElement;
  const found = card?.querySelector(PLACEHOLDER_SELECTOR) ?? null;
  return found;
}
function applySuggestion(node, text) {
  if (node === null || text === null) return false;
  if (node.textContent !== text) node.textContent = text;
  return true;
}
function shellPlaceholderText(from) {
  if (from === null) return null;
  const card = from.closest('[class*="root"], form') ?? from.parentElement;
  const editor = card?.querySelector("[data-placeholder]") ?? null;
  return editor?.getAttribute("data-placeholder") ?? null;
}
export {
  PLACEHOLDER_SELECTOR,
  applySuggestion,
  findPlaceholder,
  shellPlaceholderText
};
