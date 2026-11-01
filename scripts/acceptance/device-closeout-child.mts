import { registrationLogin } from '../../packages/daemon/src/login'
import { runCli } from '../../packages/daemon/src/cli'

// The parent owns a disposable, attested application and passes a one-use
// enrollment grant over stdin. Never place a credential in argv or stdout.
const origin = process.env.MIKKA_CLOSEOUT_ORIGIN
const dataDir = process.env.MIKKA_CLOSEOUT_DATA_DIR
if (!origin || !dataDir || !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) {
  throw new Error('Owned loopback application and daemon directory required')
}
const quiet = { out() {}, err() {} }
if (process.env.MIKKA_CLOSEOUT_RESTART !== '1') {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 256) throw new Error('Invalid one-use enrollment grant')
  }
  const credential = await registrationLogin({ serverUrl: `${origin}/mikka`, token: input.trim() })
  if (await runCli(['daemon', 'login', '--server', `${origin}/mikka`, '--data-dir', dataDir, '--token', credential], quiet) !== 0) {
    throw new Error('Normal daemon enrollment failed')
  }
}
const code = await runCli(['daemon', '--server', `${origin}/mikka`, '--data-dir', dataDir, '--retain-resources'], quiet)
if (code !== null) process.exitCode = code
