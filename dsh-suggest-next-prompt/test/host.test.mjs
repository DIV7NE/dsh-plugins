import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleRequest } from '../lib/index.js'

const headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
const body = { sessionId: 's1', transcript: [{ role: 'user', text: 'write the parser' }] }

const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

function deps(overrides = {}) {
  return {
    settings: { route: ROUTE, timeoutMs: 8000, maxCandidates: 3, maxOutputTokens: 200 },
    agents: { get: id => (id === 's1' ? { id: 's1' } : undefined) },
    commands: { list: () => [{ name: 'compact' }, { name: 'plan' }] },
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '["run the tests", "/compact", "no, do it the lazy way"]' }
      yield { type: 'finish', reason: 'stop' }
    },
    ...overrides,
  }
}

test('refuses a foreign host', async () => {
  const result = await handleRequest(deps(), { headers: { host: 'evil.example.com' }, byteLength: 64, raw: body })
  assert.equal(result.status, 403)
})

test('refuses a body over the byte ceiling', async () => {
  const result = await handleRequest(deps(), { headers, byteLength: 1 << 30, raw: body })
  assert.equal(result.status, 413)
})

test('answers 404 for an unknown session', async () => {
  const result = await handleRequest(deps(), { headers, byteLength: 64, raw: { ...body, sessionId: 'nope' } })
  assert.equal(result.status, 404)
})

test('returns the sanitized shortlist', async () => {
  const result = await handleRequest(deps(), { headers, byteLength: 64, raw: body })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.candidates, ['run the tests', '/compact', 'no, do it the lazy way'])
})

test('drops a command the catalogue does not know', async () => {
  const stream = async function* () {
    yield { type: 'text-delta', index: 0, text: '["/nonexistent", "run the tests"]' }
    yield { type: 'finish', reason: 'stop' }
  }
  const result = await handleRequest(deps({ stream }), { headers, byteLength: 64, raw: body })
  assert.deepEqual(result.body.candidates, ['run the tests'])
})

test('answers an empty shortlist when the model fails, never an error', async () => {
  const stream = async function* () {
    yield { type: 'finish', reason: 'error' }
  }
  const result = await handleRequest(deps({ stream }), { headers, byteLength: 64, raw: body })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.candidates, [])
})

test('answers an empty shortlist when no route is available', async () => {
  const withoutRoute = deps({ settings: { timeoutMs: 8000, maxCandidates: 3, maxOutputTokens: 400, reasoningEffort: 'off' } })
  const result = await handleRequest(withoutRoute, { headers, byteLength: 64, raw: body })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.candidates, [])
})

test('answers an empty shortlist on unparseable model output', async () => {
  const stream = async function* () {
    yield { type: 'text-delta', index: 0, text: 'I think you should run the tests.' }
    yield { type: 'finish', reason: 'stop' }
  }
  const result = await handleRequest(deps({ stream }), { headers, byteLength: 64, raw: body })
  assert.deepEqual(result.body.candidates, [])
})
test('records the auxiliary call in the session log so its cost is auditable', async () => {
  const appended = []
  const stream = async function* () {
    // The real adapter shape: usage, then text, then an OBJECT finish reason.
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }
    yield { type: 'text-delta', index: 0, text: '["run the tests"]' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const sessions = { get: () => ({ append: (type, data) => appended.push({ type, data }) }) }
  const result = await handleRequest(deps({ stream, sessions }), { headers, byteLength: 64, raw: body })

  assert.equal(result.body.candidates.length, 1)
  assert.equal(appended.length, 1, 'exactly one log record per call')
  assert.equal(appended[0].type, 'session/suggest-llm-request')
  assert.deepEqual(appended[0].data.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 })
  assert.equal(appended[0].data.candidates, 1)
  assert.equal(appended[0].data.finish, 'stop')
})

test('a session that cannot be written never costs the suggestion', async () => {
  const sessions = { get: () => ({ append: () => { throw new Error('session closed') } }) }
  const result = await handleRequest(deps({ sessions }), { headers, byteLength: 64, raw: body })
  assert.equal(result.status, 200)
  assert.equal(result.body.candidates.length, 3)
})

test('no session resolvable is not an error either', async () => {
  const sessions = { get: () => undefined }
  const result = await handleRequest(deps({ sessions }), { headers, byteLength: 64, raw: body })
  assert.equal(result.status, 200)
  assert.equal(result.body.candidates.length, 3)
})
