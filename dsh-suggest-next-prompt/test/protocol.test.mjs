import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_BODY_BYTES, isFailure, isTrustedRequest, parseRequest } from '../lib/protocol.js'

const ok = { sessionId: 's1', transcript: [{ role: 'user', text: 'hi' }] }

test('accepts a minimal request', () => {
  const parsed = parseRequest(ok, 64)
  assert.equal(isFailure(parsed), false)
  assert.deepEqual(parsed.transcript, [{ role: 'user', text: 'hi' }])
})

test('rejects an oversized body rather than truncating it', () => {
  const parsed = parseRequest(ok, MAX_BODY_BYTES + 1)
  assert.equal(isFailure(parsed), true)
  assert.equal(parsed.status, 413)
})

test('rejects unknown fields', () => {
  const parsed = parseRequest({ ...ok, extra: 1 }, 64)
  assert.equal(isFailure(parsed), true)
  assert.equal(parsed.status, 400)
})

test('rejects a bad role and a non-string text', () => {
  assert.equal(isFailure(parseRequest({ sessionId: 's1', transcript: [{ role: 'system', text: 'x' }] }, 64)), true)
  assert.equal(isFailure(parseRequest({ sessionId: 's1', transcript: [{ role: 'user', text: 7 }] }, 64)), true)
})

test('rejects a route with only one half', () => {
  assert.equal(isFailure(parseRequest({ ...ok, route: { provider: 'deepseek' } }, 64)), true)
})

test('accepts a complete route', () => {
  const parsed = parseRequest({ ...ok, route: { provider: 'deepseek', model: 'deepseek-chat' } }, 64)
  assert.equal(isFailure(parsed), false)
  assert.deepEqual(parsed.route, { provider: 'deepseek', model: 'deepseek-chat' })
})

test('the fence admits loopback and refuses everything else', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:3080' }), true)
  assert.equal(isTrustedRequest({ host: 'localhost:3080', origin: 'http://localhost:3080' }), true)
  assert.equal(isTrustedRequest({ host: 'evil.example.com' }), false)
  assert.equal(isTrustedRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), false)
  assert.equal(isTrustedRequest({ host: '127.0.0.1:3080', origin: 'http://evil.example.com' }), false)
  assert.equal(isTrustedRequest({}), false)
})
import { MAX_CANDIDATE_CHARS, MAX_CANDIDATES, buildPrompt, sanitizeCandidates } from '../lib/protocol.js'

test('drops every malformed candidate and keeps the rest in order', () => {
  const values = [
    '',
    '   ',
    'add tests for the parser',
    'line one\nline two',
    'x'.repeat(MAX_CANDIDATE_CHARS + 1),
    'has\u0007control',
    'add tests for the parser',
    'run it and fix the failure',
    'a fourth candidate',
    'a fifth candidate',
  ]
  assert.deepEqual(sanitizeCandidates(values, []), [
    'add tests for the parser',
    'run it and fix the failure',
    'a fourth candidate',
  ])
})

test('refuses a command that is not in the live catalogue', () => {
  assert.deepEqual(sanitizeCandidates(['/compact', '/plan'], ['compact']), ['/compact'])
})

test('tolerates a command with trailing arguments', () => {
  assert.deepEqual(sanitizeCandidates(['/plan the migration'], ['plan']), ['/plan the migration'])
})

test('drops non-strings', () => {
  assert.deepEqual(sanitizeCandidates([1, null, {}, 'run the tests'], []), ['run the tests'])
})

test('never returns more than the cap', () => {
  const many = Array.from({ length: 10 }, (_, i) => 'candidate ' + i)
  assert.equal(sanitizeCandidates(many, []).length, MAX_CANDIDATES)
})

test('framing states the one-line rule and the catalogue', () => {
  const request = { sessionId: 's1', transcript: [{ role: 'user', text: 'hi' }] }
  const framed = buildPrompt(request, ['compact', 'plan'])
  assert.match(framed.system, /one line/)
  assert.match(framed.system, /compact, plan/)
  assert.equal(framed.user, '{"turns":[{"role":"user","text":"hi"}]}')
})

test('framing forbids commands when the catalogue is empty', () => {
  const framed = buildPrompt({ sessionId: 's1', transcript: [] }, [])
  assert.match(framed.system, /Do not suggest slash commands/)
})
