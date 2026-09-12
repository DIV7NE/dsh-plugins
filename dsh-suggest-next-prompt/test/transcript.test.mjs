import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClientModule } from './bundle.mjs'

const { buildTranscript, lastTurnComplete, newestTurn } = await loadClientModule('src/client/transcript.ts')

const turn = (n, prompt, response) => ({ turn: n, seq: n, prompt, response })

test('a turn with an empty response is not a finished turn', () => {
  assert.equal(lastTurnComplete(undefined), false)
  assert.equal(lastTurnComplete([]), false)
  assert.equal(lastTurnComplete([turn(1, 'hi', '')]), false)
  assert.equal(lastTurnComplete([turn(1, 'hi', '   ')]), false)
})

test('the newest entry decides, not any entry', () => {
  assert.equal(lastTurnComplete([turn(1, 'a', 'done'), turn(2, 'b', '')]), false)
  assert.equal(lastTurnComplete([turn(1, 'a', ''), turn(2, 'b', 'done')]), true)
})

test('a completed turn reads as the user\'s turn', () => {
  assert.equal(lastTurnComplete([turn(1, 'hi', 'hello')]), true)
})

test('an open turn contributes its prompt but no assistant message', () => {
  const built = buildTranscript([turn(1, 'a', 'done'), turn(2, 'b', '')])
  assert.deepEqual(built, [
    { role: 'user', text: 'a' },
    { role: 'assistant', text: 'done' },
    { role: 'user', text: 'b' },
  ])
})

test('blank previews are skipped rather than sent as empty messages', () => {
  assert.deepEqual(buildTranscript([turn(1, '', '')]), [])
  assert.deepEqual(buildTranscript([turn(1, '   ', '  ')]), [])
})

test('the transcript is trimmed to the newest messages', () => {
  const turns = Array.from({ length: 20 }, (_, i) => turn(i, 'p' + i, 'r' + i))
  const built = buildTranscript(turns)
  assert.equal(built.length, 12)
  assert.deepEqual(built[built.length - 1], { role: 'assistant', text: 'r19' })
})
test('the newest turn number is the suggestion identity', () => {
  assert.equal(newestTurn(undefined), null)
  assert.equal(newestTurn([]), null)
  assert.equal(newestTurn([turn(1, 'a', 'done'), turn(2, 'b', 'done')]), 2)
})

test('the identity survives a re-published array with the same turn', () => {
  // The store may re-publish the outline; a suggestion belongs to the TURN, so
  // regenerating must key on this number rather than on array identity.
  const first = [turn(1, 'a', '')]
  const republished = [...first]
  assert.equal(newestTurn(first), newestTurn(republished))
})
