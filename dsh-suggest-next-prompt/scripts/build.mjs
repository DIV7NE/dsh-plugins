/**
 * Build both halves of dsh-suggest-next-prompt with esbuild.
 *
 * - `lib/index.js`   — the host half: one ESM bundle. Nothing is external: the
 *   package has no runtime dependency, and `./protocol` is inlined so the
 *   installed plugin resolves no internal path of its own.
 * - `lib/client.js`  — the browser half: one CJS bundle wrapped in the
 *   `window.__ModuleLoader__.load({id, factory})` boilerplate the DSH client
 *   module system consumes. `react`/`react-dom`/`@deepseek-ai/*` stay external
 *   because the shell seeds them in its frozen module table; everything else is
 *   inlined, so the bundle is self-contained and needs no `dsh.client.external`
 *   entry.
 * - `lib/protocol.js` and `lib/placeholder.js` — small ESM bundles so the
 *   hermetic tests can import the pure modules directly, without a server, a
 *   browser, or a model.
 *
 * Nothing is minified, on purpose: an unreadable bundle reads as obfuscation to
 * a marketplace source scan, and this package is meant to be listable.
 */
import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = resolve(root, 'lib')

/** Module requests the browser shell provides at runtime. */
const PLATFORM_EXTERNAL = [
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  'react/jsx-runtime',
  '@deepseek-ai/*',
]

/** The id the client module loader keys this plugin's bundle under. */
const CLIENT_ID = 'dsh-suggest-next-prompt'

const shared = {
  bundle: true,
  target: 'es2022',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
}

await rm(lib, { recursive: true, force: true })
await mkdir(lib, { recursive: true })

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(lib, 'index.js'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
})

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/protocol.ts')],
  outfile: resolve(lib, 'protocol.js'),
  format: 'esm',
  platform: 'neutral',
})

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/client/placeholder.ts')],
  outfile: resolve(lib, 'placeholder.js'),
  format: 'esm',
  platform: 'neutral',
})

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  outfile: resolve(lib, 'client.body.cjs'),
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: PLATFORM_EXTERNAL,
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
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
