import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ciAuthErrorCode, loadCiGithubToken } from './ci-github-token.mjs'

export async function runDeliveryWithCiToken({
  readFixture = async () => JSON.parse(await readFile(process.env.MIKKA_1503_FIXTURE_STATE_FILE ?? 'scripts/ops/issue1503/fixture-state.json', 'utf8')),
  loadToken = loadCiGithubToken,
  spawnChild = spawn,
} = {}) {
  let token = await loadToken(await readFixture())
  // The credential is an environment value, never an argument, log, artifact,
  // model input or retained secret file. The DB runtime is closed before spawn.
  const child = spawnChild(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./delivery.mjs', import.meta.url))],
    { shell: false, stdio: 'inherit', env: { ...process.env, ISSUE1503_CI_GITHUB_TOKEN: token } })
  token = undefined
  return await new Promise((resolve, reject) => {
    child.once('error', cause => reject(new Error('issue1503_ci_auth_spawn_failed', { cause })))
    child.once('exit', code => resolve(Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runDeliveryWithCiToken() }
  catch (cause) {
    console.error(JSON.stringify({ phase: 'ci_read_auth', code: ciAuthErrorCode(cause) }))
    process.exitCode = 1
  }
}
