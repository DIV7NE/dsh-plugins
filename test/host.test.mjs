/**
 * The host half's testable surface: the byte sequence a Run click produces,
 * the transcript bound, and the fence that decides whether a request may
 * reach a shell at all. Everything else here needs a real pty and a browser.
 *
 *   npm test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  appendTranscript,
  isLoopbackHostname,
  isTrustedRequest,
  pastePayload,
  resolveShell,
  TRANSCRIPT_LIMIT,
} from '../lib/index.js'

test('pastePayload submits once and keeps a backslash continuation intact', () => {
  const snippet = "ssh tf2-vps 'cd /home/x && docker compose logs api -f' \\\n| grep -afE 'mutate_failed|ERROR|panic'"
  assert.equal(
    pastePayload(snippet),
    "ssh tf2-vps 'cd /home/x && docker compose logs api -f' \\\r| grep -afE 'mutate_failed|ERROR|panic'\r",
  )
})

test('pastePayload normalizes CRLF and drops trailing blank lines', () => {
  assert.equal(pastePayload('echo one\r\necho two\n\n'), 'echo one\recho two\r')
  assert.equal(pastePayload(''), '\r')
})

test('appendTranscript keeps only the newest bytes', () => {
  const full = appendTranscript('a'.repeat(TRANSCRIPT_LIMIT), 'tail')
  assert.equal(full.length, TRANSCRIPT_LIMIT)
  assert.equal(full.endsWith('tail'), true)
})

test('isLoopbackHostname accepts only the loopback authorities', () => {
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('127.1.2.3'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('127.0.0.1.evil.example'), false)
  assert.equal(isLoopbackHostname('example.com'), false)
  assert.equal(isLoopbackHostname('127.0.0.999'), false)
})

test('the fence refuses anything that is not the page it serves', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:3080' }), true)
  assert.equal(isTrustedRequest({ host: 'localhost:3080', origin: 'http://localhost:3080' }), true)
  assert.equal(isTrustedRequest({ host: 'localhost:3080', origin: 'http://evil.example' }), false)
  assert.equal(isTrustedRequest({ host: 'evil.example' }), false)
  assert.equal(isTrustedRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), false)
  assert.equal(isTrustedRequest({ host: 'localhost:3080', origin: 'not a url' }), false)
  assert.equal(isTrustedRequest({}), false)
})

test('resolveShell always names a shell', () => {
  assert.equal(resolveShell('/bin/zsh').file, '/bin/zsh')
  assert.equal(resolveShell('  ').file.length > 0, true)
  assert.equal(resolveShell('"C:\\Program Files\\PowerShell\\7\\pwsh.exe"').file, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')
})
