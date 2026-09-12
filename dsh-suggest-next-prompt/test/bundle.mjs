/**
 * Bundle one client-path module to a temp ESM file so node:test can import it.
 *
 * The browser half is only emitted inside the wrapped client bundle, so its pure
 * modules (the key decision table, the transcript mapping) are otherwise
 * unreachable from the hermetic suite. This builds them on demand instead of
 * adding jsdom or a second package build step.
 */
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cache = new Map()

/**
 * Load one client-path module as ESM.
 * @param relative - path relative to the package root, e.g. 'src/client/keys.ts'.
 * @returns the module's exports.
 */
export async function loadClientModule(relative) {
  const cached = cache.get(relative)
  if (cached !== undefined) return cached
  const dir = await mkdtemp(join(tmpdir(), 'dsh-suggest-'))
  const outfile = join(dir, relative.replace(/[^a-zA-Z0-9]/g, '_') + '.mjs')
  await build({
    entryPoints: [resolve(here, '..', relative)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: false,
    logLevel: 'silent',
  })
  const loaded = await import(pathToFileURL(outfile).href)
  cache.set(relative, loaded)
  return loaded
}
