import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClientModule } from './bundle.mjs'

// keys.ts lives on the browser path, which the main build only emits inside the
// wrapped client bundle, so the decision table is exercised through an
// esbuild-on-demand build in test/bundle.mjs.
const { decideKey } = await loadClientModule('src/client/keys.ts')

const visible = { visible: true, empty: true }
const hidden = { visible: false, empty: true }
const typed = { visible: true, empty: false }
const key = (over = {}) => ({ key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over })

test('Tab accepts, so it is never a silent no-op', () => {
  assert.equal(decideKey(key(), visible), 'accept')
})

test('Shift+Tab is left to the browser', () => {
  assert.equal(decideKey(key({ shiftKey: true }), visible), 'ignore')
})

test('arrows cycle in both directions', () => {
  assert.equal(decideKey(key({ key: 'ArrowDown' }), visible), 'next')
  assert.equal(decideKey(key({ key: 'ArrowUp' }), visible), 'prev')
})

test('Escape dismisses', () => {
  assert.equal(decideKey(key({ key: 'Escape' }), visible), 'dismiss')
})

test('Enter is never claimed, so it keeps its submit meaning', () => {
  assert.equal(decideKey(key({ key: 'Enter' }), visible), 'ignore')
  assert.equal(decideKey(key({ key: 'Enter', ctrlKey: true }), visible), 'ignore')
})

test('nothing is claimed while the suggestion is hidden', () => {
  assert.equal(decideKey(key(), hidden), 'ignore')
  assert.equal(decideKey(key({ key: 'ArrowDown' }), hidden), 'ignore')
})

test('nothing is claimed once the user has typed', () => {
  assert.equal(decideKey(key(), typed), 'ignore')
  assert.equal(decideKey(key({ key: 'ArrowDown' }), typed), 'ignore')
})

test('an IME composition keystroke is never intercepted', () => {
  assert.equal(decideKey(key({ isComposing: true }), visible), 'ignore')
  assert.equal(decideKey(key({ key: 'ArrowDown', isComposing: true }), visible), 'ignore')
})

test('ordinary typing is ignored', () => {
  assert.equal(decideKey(key({ key: 'a' }), visible), 'ignore')
  assert.equal(decideKey(key({ key: 'Home' }), visible), 'ignore')
})
