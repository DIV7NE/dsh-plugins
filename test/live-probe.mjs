/**
 * Live smoke test for the terminal route, run against a DSH web server that
 * already has this plugin loaded. It is not part of npm test (that suite is
 * hermetic): this one needs a real server, a real shell, and the
 * browser-trust fence exercised from outside.
 *
 *   node test/live-probe.mjs [http://127.0.0.1:3080] [sessionId]
 *
 * It asserts three things:
 *   1. a same-origin handshake is accepted and the host announces itself;
 *   2. a Run frame reaches the shell and its output comes back;
 *   3. a foreign-Origin handshake is refused by the fence.
 */
import { WebSocket } from 'ws'

const base = process.argv[2] ?? 'http://127.0.0.1:3080'
const sessionId = process.argv[3] ?? 'live-probe'
const url = new URL('/runterm/pty', base)
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
url.searchParams.set('session', sessionId)
url.searchParams.set('cols', '100')
url.searchParams.set('rows', '30')

/** Open one socket with the given Origin and collect what comes back. */
function connect(origin) {
  const socket = new WebSocket(url, { headers: { origin } })
  let output = ''
  socket.on('message', raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t === 'data') output += frame.d
  })
  return { socket, output: () => output }
}

const same = connect(base)
let ready = false
same.socket.on('message', raw => {
  if (JSON.parse(String(raw)).t === 'ready') ready = true
})
await new Promise((resolve, reject) => {
  same.socket.on('open', resolve)
  same.socket.on('unexpected-response', (_req, res) => reject(new Error('refused with ' + res.statusCode)))
  same.socket.on('error', reject)
  setTimeout(() => reject(new Error('handshake timed out')), 10000)
})
await new Promise(resolve => setTimeout(resolve, 400))
if (!ready) throw new Error('host never sent a ready frame')
same.socket.send(JSON.stringify({ t: 'run', code: 'echo runterm-ok' }))
for (let i = 0; i < 40 && !same.output().includes('runterm-ok'); i++) {
  await new Promise(resolve => setTimeout(resolve, 250))
}
same.socket.send(JSON.stringify({ t: 'kill' }))
same.socket.close()
if (!same.output().includes('runterm-ok')) {
  throw new Error('shell output never contained the probe marker; got: ' + JSON.stringify(same.output().slice(0, 400)))
}
console.log('PASS handshake accepted and echo runterm-ok round-tripped')

const foreign = connect('http://evil.example')
const outcome = await new Promise(resolve => {
  foreign.socket.on('open', () => resolve('opened'))
  foreign.socket.on('unexpected-response', (_req, res) => resolve('http ' + res.statusCode))
  foreign.socket.on('error', error => resolve('error ' + error.message))
  setTimeout(() => resolve('timed out'), 8000)
})
foreign.socket.terminate()
if (outcome === 'opened') throw new Error('a foreign Origin was allowed to reach a shell')
console.log('PASS foreign Origin refused (' + outcome + ')')
