import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applySuggestion, shellPlaceholderText } from '../lib/placeholder.js'

test('writes the suggestion into the placeholder node', () => {
  const node = { textContent: 'Message or run a task' }
  assert.equal(applySuggestion(node, 'run the tests'), true)
  assert.equal(node.textContent, 'run the tests')
})

test('is a no-op when there is no node', () => {
  assert.equal(applySuggestion(null, 'run the tests'), false)
})

test('leaves the node alone when there is no suggestion', () => {
  const node = { textContent: 'Message or run a task' }
  assert.equal(applySuggestion(node, null), false)
  assert.equal(node.textContent, 'Message or run a task')
})

test('re-asserts the same text without reporting a change twice', () => {
  const node = { textContent: 'run the tests' }
  assert.equal(applySuggestion(node, 'run the tests'), true)
  assert.equal(node.textContent, 'run the tests')
})
test('the shell placeholder text is read from the editor attribute', () => {
  const editor = { getAttribute: name => (name === 'data-placeholder' ? 'Message or run a task' : null) }
  const card = { querySelector: selector => (selector === '[data-placeholder]' ? editor : null) }
  const from = { closest: () => card, parentElement: null }
  assert.equal(shellPlaceholderText(from), 'Message or run a task')
})

test('a missing editor answers null rather than throwing', () => {
  const card = { querySelector: () => null }
  const from = { closest: () => card, parentElement: null }
  assert.equal(shellPlaceholderText(from), null)
  assert.equal(shellPlaceholderText(null), null)
})

test('releasing a suggestion writes the shell text back', () => {
  const node = { textContent: 'run the tests' }
  const editor = { getAttribute: () => 'Message or run a task' }
  const card = { querySelector: selector => (selector === '[data-placeholder]' ? editor : null) }
  const from = { closest: () => card, parentElement: null }
  const shellText = shellPlaceholderText(from)
  applySuggestion(node, shellText)
  assert.equal(node.textContent, 'Message or run a task')
})
