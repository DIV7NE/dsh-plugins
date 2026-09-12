/**
 * Rebuild and reinstall dsh-suggest-next-prompt into a DSH profile, in one
 * command:
 *
 *   node scripts/install-profile.mjs [profileName]     # profileName defaults to web
 *
 * The install goes through npm pack + `dsh plugin add <tarball>` rather than a
 * local directory link, because pnpm mis-creates the directory junction for a
 * cross-drive local dependency in this profile layout: the junction resolves to
 * `<profile>\\D:\\projects\\dshpluginsdev` instead of the real directory, so the
 * launcher cannot read the package manifest, never sees `dsh.bundle.patch`, and
 * never adds the package to `dsh.profile.bundles`. A tarball installs as a real
 * directory and reconciles correctly.
 */
import { execSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.argv[2] ?? 'web'
const PACKAGE = 'dsh-suggest-next-prompt'

/** Run one command in the package directory, echoing it first. */
function run(command) {
  process.stdout.write('\n$ ' + command + '\n')
  execSync(command, { cwd: root, stdio: 'inherit' })
}

/** Run one command, tolerating a non-zero exit (the teardown before a reinstall). */
function runQuietly(command) {
  try {
    run(command)
  } catch {
    process.stdout.write('(' + command + ' exited non-zero; continuing)\n')
  }
}

for (const stale of readdirSync(root).filter(name => name.endsWith('.tgz'))) {
  rmSync(resolve(root, stale))
}

run('npm run build')
run('npm pack')

const tarball = readdirSync(root).filter(name => name.endsWith('.tgz'))[0]
if (tarball === undefined) throw new Error('npm pack produced no tarball')
// An absolute, forward-slash spec: pnpm resolves a bare relative path against
// the profile directory, not against this one.
const spec = 'file:' + resolve(root, tarball).replace(/\\\\/g, '/')

runQuietly('dsh plugin --profile ' + profile + ' remove ' + PACKAGE)
run('dsh plugin --profile ' + profile + ' add "' + spec + '"')
process.stdout.write('\nRestart the DSH server for this profile so it reloads its bundle stack, then reload the page.\n')
