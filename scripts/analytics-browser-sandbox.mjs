import assert from 'node:assert/strict'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Chromium's documented per-binary userns profile preserves its sandbox on
 * Ubuntu runners. The job installs into its own fresh directory, so an old
 * browser revision or a wildcard must never broaden the attachment path.
 * https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
 */
export async function analyticsBrowserProfile(directory) {
  assert.ok(typeof directory === 'string' && directory.startsWith('/') && /^[A-Za-z0-9_./-]+$/.test(directory), 'ANALYTICS_BROWSER_DIRECTORY_INVALID')
  assert.equal(resolve(directory), directory, 'ANALYTICS_BROWSER_DIRECTORY_NOT_CANONICAL')
  assert.equal(await realpath(directory), directory, 'ANALYTICS_BROWSER_DIRECTORY_SYMLINK')
  const revisions = (await readdir(directory, { withFileTypes: true })).filter(entry => /^chromium_headless_shell-\d+$/.test(entry.name))
  assert.equal(revisions.length, 1, 'ANALYTICS_BROWSER_REVISION_AMBIGUOUS')
  assert.ok(revisions[0].isDirectory(), 'ANALYTICS_BROWSER_REVISION_NOT_DIRECTORY')
  const executable = join(directory, revisions[0].name, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
  assert.equal(await realpath(executable), executable, 'ANALYTICS_BROWSER_EXECUTABLE_SYMLINK')
  const info = await lstat(executable)
  assert.ok(info.isFile() && (info.mode & 0o111) !== 0, 'ANALYTICS_BROWSER_EXECUTABLE_INVALID')
  const handle = await open(executable, 'r')
  try {
    const magic = Buffer.alloc(4)
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0)
    assert.ok(bytesRead === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'ANALYTICS_BROWSER_EXECUTABLE_NOT_ELF')
  } finally { await handle.close() }
  return `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile mikka-analytics-chromium "${executable}" flags=(unconfined) {\n  userns,\n}\n`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'ANALYTICS_BROWSER_ARGUMENTS_INVALID')
  assert.equal(process.platform, 'linux', 'ANALYTICS_BROWSER_REQUIRES_LINUX')
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'ANALYTICS_BROWSER_REQUIRES_DISPOSABLE_CI')
  assert.notEqual(process.getuid(), 0, 'ANALYTICS_BROWSER_REQUIRES_NON_ROOT')
  process.stdout.write(await analyticsBrowserProfile(process.argv[2]))
}
