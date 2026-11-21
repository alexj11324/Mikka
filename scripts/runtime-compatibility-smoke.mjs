import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { availableEvePort } from './eve-service.mjs'

// No model calls, external services, accounts or production data. `pnpm start`
// owns the actual compiled app and Eve peer; readiness checks its build identity.
const built = JSON.parse(await readFile('.output/mikka-build.json', 'utf8'))
assert.equal(built.node, process.version, 'build must use the runtime being tested')
const port = await availableEvePort()
const origin = `http://127.0.0.1:${port}`
const child = spawn('pnpm', ['start', '--hostname', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, BETTER_AUTH_URL: origin, MIKKA_APP_ORIGIN: origin },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) })
const stop = signal => {
  if (!Number.isInteger(child.pid)) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
try {
  await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('compiled app readiness timed out')), 240_000)
    const finish = error => { clearTimeout(timer); if (error) reject(error); else resolve() }
    child.once('error', finish)
    child.once('exit', (code, signal) => finish(new Error(`compiled app exited before readiness: ${code ?? signal}`)))
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      process.stdout.write(chunk)
      output = (output + chunk.toString()).slice(-16_384)
      if (/Ready in \d+ms/.test(output)) finish()
    })
  })
  const version = await fetch(`${origin}/mikka/api/version`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(version.status, 200)
  assert.equal((await version.json()).build, built.appBuild)
  const eve = await fetch(`${origin}/mikka/api/agents/eve/v1/health`, { signal: AbortSignal.timeout(30_000) })
  assert.equal(eve.status, 200, 'packaged Eve must handle its real health route')
  console.log(`Node ${process.version}: compiled app ${built.revision} and packaged Eve started; Eve health ${await eve.text()}`)
} finally {
  // Only this smoke's process group, including the pnpm wrapper and Eve child.
  const timer = setTimeout(() => stop('SIGKILL'), 35_000)
  stop('SIGTERM')
  await exited
  clearTimeout(timer)
}
