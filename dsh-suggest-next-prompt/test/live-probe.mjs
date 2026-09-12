/**
 * Non-hermetic probe for a running server that has this plugin loaded.
 *
 *   node test/live-probe.mjs http://127.0.0.1:3080
 *
 * It asserts three things the hermetic suite cannot: that the route is actually
 * mounted by the booted profile, that the same-origin fence admits a real
 * browser-shaped request, and that a foreign Origin and an oversized body are
 * both refused. A 405 here means the plugin row is not loaded — check
 * `dsh --profile web --dump-config` before looking anywhere else.
 */
import { MAX_BODY_BYTES, SUGGEST_PATH } from '../lib/protocol.js'

const base = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const origin = new URL(base).origin
const url = base + SUGGEST_PATH
const body = JSON.stringify({ sessionId: 'live-probe', transcript: [{ role: 'user', text: 'say hi' }] })

let failures = 0

/** Report one assertion. */
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  process.stdout.write((ok ? 'PASS ' : 'FAIL ') + label + ' (expected ' + String(expected) + ', got ' + String(actual) + ')\n')
}

/** Send one request and return the status; 0 marks a transport failure. */
async function status(headers, payload, method = 'POST') {
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: payload }),
    })
    return response.status
  } catch (error) {
    process.stdout.write('  request error: ' + String(error) + '\n')
    return 0
  }
}

check('same-origin request is admitted', await status({ origin }, body), 200)
check('foreign Origin is refused', await status({ origin: 'http://evil.example.com' }, body), 403)
check('non-POST is refused', await status({ origin }, undefined, 'GET'), 405)
check('oversized body is refused', await status({ origin }, 'x'.repeat(MAX_BODY_BYTES + 1)), 413)

// The same-origin 200 above proves the fence admits a browser-shaped request.
// A body that is over the ceiling is refused before any model call is made, so
// this probe never spends tokens.
process.stdout.write(failures === 0 ? '\nlive probe: all checks passed\n' : '\nlive probe: ' + String(failures) + ' failed\n')
process.exit(failures === 0 ? 0 : 1)
