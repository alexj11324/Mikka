// electron-builder afterSign hook (electron-builder.yml): notarize the signed
// Mikka.app and staple its ticket before the dmg and zip are built from it.
//
// electron-builder's own `mac.notarize` stapled right after Apple accepted the
// app and gave up after three retries a few seconds apart. Three releases in a
// row (2026-11-02) failed there with stapler error 68 / NSURLErrorDomain -1005
// while fetching the new ticket from api.apple-cloudkit.com. Here the staple
// waits and retries for about five minutes. Nothing is skipped: the signature
// is verified first, notarization must be Accepted, and the stapled app must
// pass `stapler validate`.

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Seconds to wait before each staple retry: six tries after the first, about five minutes. */
export const STAPLE_RETRY_DELAYS = [15, 30, 45, 60, 75, 90]

/**
 * notarytool credentials from the same variables electron-builder reads: an
 * Apple ID with an app-specific password, an App Store Connect API key, or a
 * keychain profile. Null when none is set (an unsigned local build).
 */
export function notaryAuth(env) {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_KEYCHAIN, APPLE_KEYCHAIN_PROFILE } = env
  if (APPLE_ID || APPLE_APP_SPECIFIC_PASSWORD) {
    if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) throw new Error('APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID need to be set together')
    return ['--apple-id', APPLE_ID, '--password', APPLE_APP_SPECIFIC_PASSWORD, '--team-id', APPLE_TEAM_ID]
  }
  if (APPLE_API_KEY || APPLE_API_KEY_ID || APPLE_API_ISSUER) {
    if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) throw new Error('APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER need to be set together')
    return ['--key', APPLE_API_KEY, '--key-id', APPLE_API_KEY_ID, '--issuer', APPLE_API_ISSUER]
  }
  if (APPLE_KEYCHAIN_PROFILE) return ['--keychain-profile', APPLE_KEYCHAIN_PROFILE, ...(APPLE_KEYCHAIN ? ['--keychain', APPLE_KEYCHAIN] : [])]
  return null
}

/** Staples, retrying with STAPLE_RETRY_DELAYS; throws the last error once they run out. */
export async function stapleWithRetry(staple, { delays = STAPLE_RETRY_DELAYS, sleep = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)), log = console.log } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await staple()
      return attempt + 1
    } catch (error) {
      if (attempt >= delays.length) throw error
      log(`staple attempt ${attempt + 1} failed (${String(error?.stderr || error?.message || error).trim().split('\n').at(-1)}); retrying in ${delays[attempt]}s`)
      await sleep(delays[attempt])
    }
  }
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const auth = notaryAuth(process.env)
  if (!auth) {
    console.warn('No notarization credentials; the app is signed but not notarized')
    return
  }
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const dir = await mkdtemp(join(tmpdir(), 'mikka-notarize-'))
  try {
    const zip = join(dir, 'Mikka.zip')
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip])
    const { stdout } = await run('xcrun', ['notarytool', 'submit', zip, ...auth, '--wait', '--output-format', 'json'], { maxBuffer: 16 * 1024 * 1024 })
    const result = JSON.parse(stdout)
    if (result.status !== 'Accepted') {
      const details = await run('xcrun', ['notarytool', 'log', result.id, ...auth]).then(({ stdout: log }) => log, () => '')
      throw new Error(`Notarization ${result.status} (${result.id})\n${details}`)
    }
    console.log(`Notarization accepted (${result.id})`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const attempts = await stapleWithRetry(() => run('xcrun', ['stapler', 'staple', appPath]))
  await run('xcrun', ['stapler', 'validate', appPath])
  console.log(`Stapled and validated after ${attempts} attempt(s)`)
}
