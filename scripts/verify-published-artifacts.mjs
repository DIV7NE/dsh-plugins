/**
 * Verify what the repository actually PUBLISHES, not what the working tree has.
 *
 * Why this exists: every local packaging check passes a broken package, because
 * npm pack includes whatever is on disk. A .gitignore that excludes lib/ makes
 * the committed tree ship no bundle at all, while the working copy still has one
 * — which is exactly how dsh-chrome-agent reached a published commit whose
 * manifest pointed at a main file that did not exist.
 *
 * So this clones the committed tree into a temporary directory and packs from
 * THERE, then asserts each plugin's tarball carries the entry point its manifest
 * declares. Run from the repository root:
 *
 *   node scripts/verify-published-artifacts.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = (() => {
  const at = process.argv.indexOf('--repo')
  const given = at === -1 ? undefined : process.argv[at + 1]
  return given === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
    : resolve(given)
})()

/**
 * Whether this platform needs a shell to run npm.
 *
 * On Windows npm is a batch shim (npm.cmd). Node refuses to spawn a .cmd directly
 * — EINVAL, since the CVE-2024-27980 hardening — and spawning a bare `npm` gives
 * ENOENT, because Node does not resolve shell shims. Either way it works from a
 * shell and not from Node, so npm goes through one.
 */
const NEEDS_SHELL = process.platform === 'win32'

/** Run a command, returning trimmed stdout, or throwing with its stderr. */
function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: NEEDS_SHELL,
    }).trim()
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
    throw new Error(command + ' ' + args.join(' ') + ' failed in ' + cwd + '\n' + stderr)
  }
}

/** Every DSH plugin package in this repository, with its manifest-relative path. */
const PLUGINS = [
  { label: 'dsh-run-in-terminal', dir: '.' },
  { label: 'dsh-chrome-agent', dir: 'dsh-chrome-agent' },
  { label: 'dsh-suggest-next-prompt', dir: 'dsh-suggest-next-prompt' },
]

const work = mkdtempSync(join(tmpdir(), 'dsh-published-'))
let failures = 0

try {
  // A local clone reads the committed tree only — uncommitted and ignored files
  // simply are not there.
  run('git', ['clone', '--quiet', '--no-hardlinks', root, work], root)
  const commit = run('git', ['rev-parse', '--short', 'HEAD'], root)
  process.stdout.write('Verifying artifacts as published at ' + commit + '\n\n')

  for (const plugin of PLUGINS) {
    const dir = resolve(work, plugin.dir)
    // Read the manifest with fs rather than a node -p expression: the shell npm
    // needs on Windows also eats the quotes an embedded expression requires.
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

    // What the manifest promises the package contains.
    const declaredMain = typeof manifest.main === 'string' ? manifest.main : null
    const declaredFiles = Array.isArray(manifest.files) ? manifest.files : []
    const claimsLib = declaredFiles.some(entry => entry.replace(/\/+$/, '') === 'lib')

    if (declaredMain === null || !claimsLib) {
      process.stdout.write('SKIP ' + plugin.label + ' — manifest declares no lib/ payload\n')
      continue
    }

    const tarball = run('npm', ['pack', '--silent'], dir)
    // tar writes CRLF on Windows, so every entry would otherwise carry a trailing
    // \r and no comparison would ever match. Normalizing here keeps one code path
    // for every platform instead of a Windows-only comparison bug that passes on
    // the Linux runner.
    const entries = run('tar', ['-tf', join(dir, tarball)], dir)
      .split('\n')
      .map(line => line.replace(/\r$/, ''))
      .filter(Boolean)
    const packaged = entries.map(line => line.replace(/^package\//, ''))
    const expected = declaredMain.replace(/^\.\//, '')

    if (!packaged.includes(expected)) {
      failures++
      process.stdout.write('FAIL ' + plugin.label + ' — ' + expected + ' is NOT in the published tarball\n')
      process.stdout.write('     the committed tree ships ' + packaged.length + ' files; lib/ is likely ignored by .gitignore\n')
      continue
    }
    process.stdout.write('PASS ' + plugin.label + ' — ' + expected + ' present in the published tarball (' + entries.length + ' files)\n')
  }
} catch (error) {
  failures++
  process.stdout.write('FAIL ' + String(error.message) + '\n')
} finally {
  rmSync(work, { recursive: true, force: true })
}

process.stdout.write('\n' + (failures === 0 ? 'All published artifacts carry their declared entry point.\n' : failures + ' published artifact(s) broken.\n'))
process.exit(failures === 0 ? 0 : 1)