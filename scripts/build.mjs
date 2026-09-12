/**
 * Build both halves of the plugin with esbuild.
 *
 * - `lib/index.js`  — the host half: one ESM bundle, `node-pty` and `ws`
 *   left external so the package's own dependencies are used.
 * - `lib/client.js` — the browser half: one CJS bundle wrapped in the
 *   `window.__ModuleLoader__.load({id, factory})` boilerplate the DSH client
 *   module system consumes. `react`/`react-dom`/`@deepseek-ai/*` stay
 *   external because the shell seeds them in its frozen module table; every
 *   other dependency (xterm and the fit addon) is inlined, so the bundle is
 *   self-contained and needs no `dsh.client.external` entry.
 */
import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = resolve(root, 'lib')

/** Module requests the host/browser shell provides at runtime. */
const PLATFORM_EXTERNAL = [
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  '@deepseek-ai/*',
]

/** The loader boilerplate the client bundle must be wrapped in. */
const CLIENT_ID = 'dsh-run-in-terminal'

await rm(lib, { recursive: true, force: true })
await mkdir(lib, { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(lib, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external: ['node-pty', 'ws'],
  logLevel: 'info',
})

await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  outfile: resolve(lib, 'client.body.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  external: PLATFORM_EXTERNAL,
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})

const body = await readFile(resolve(lib, 'client.body.cjs'), 'utf8')
await rm(resolve(lib, 'client.body.cjs'))
await writeFile(
  resolve(lib, 'client.js'),
  [
    'window.__ModuleLoader__.load({',
    `\tid: "${CLIENT_ID}",`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    body,
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n'),
)
