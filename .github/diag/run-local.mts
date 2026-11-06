// Runs the product's 添加这台电脑 steps with the real login shell. No token is
// minted: reaching `connect` proves check, install and service all passed.
import { homedir } from 'node:os'
const { SshInstaller, runProcess, loginShell } = await import(process.argv[2])
let done!: () => void
const finished = new Promise<void>(resolve => { done = resolve })
const installer = new SshInstaller('https://app.aspectlylabs.com/mikka', async () => { throw new Error('diagnostic: no registration token') }, (s: any) => {
  console.log(JSON.stringify({ step: s.step, status: s.status, detail: s.detail, reason: s.reason, values: s.values }))
  if (s.status === 'failed' || s.status === 'online') done()
}, runProcess, homedir(), undefined, undefined, 'prod', loginShell(), async () => false)
await installer.beginLocal()
await finished
const state = installer.state()
console.log('RESULT', state.step === 'connect' && state.reason === 'diagnostic: no registration token' ? 'INSTALLED' : 'FAILED')
