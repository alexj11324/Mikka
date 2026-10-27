/** Disposable E2B check for actual driver waiting, handback and cancellation.
 * E2B_API_KEY stays in this control process; no real user data is used. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Sandbox } from 'e2b'
import { installComputerRuntime, installSubagentRuntime, startDesktop, startSubagentBrowser, stopSubagentBrowser, syncDesktopLease, syncSubagentLease, type DesktopLease } from '../../lib/computer/e2b-provider'

async function main() {

const template = process.env.E2B_COMPUTER_TEMPLATE
if (!template || !process.env.E2B_API_KEY) throw new Error('Disposable E2B template and key are required')
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Driver wait timed out')), 60_000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
const sandbox = await Sandbox.create(template, { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY, timeoutMs: 240_000 })
try {
  await installComputerRuntime(sandbox)
  await startDesktop(sandbox, 1)
  await sandbox.files.write('/tmp/mikka-cookie-server.py', `from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200); self.send_header('Set-Cookie', 'mikka_bot_342=synthetic; Path=/'); self.end_headers(); self.wfile.write(b'fixture')
 def log_message(self, *args): pass
HTTPServer(('127.0.0.1', 18082), Handler).serve_forever()
`, { user: 'user' })
  await sandbox.commands.run('python3 /tmp/mikka-cookie-server.py', { user: 'user', background: true, timeoutMs: 0 })
  await sandbox.commands.run(`export DISPLAY=:1; for i in $(seq 1 60); do window=$(xdotool search --onlyvisible --class chromium 2>/dev/null | tail -1); [ -n "$window" ] && break; sleep .5; done; [ -n "$window" ] || { echo 'Chrome window unavailable'; tail -15 /tmp/chrome-1.log; exit 1; }; xdotool windowactivate --sync "$window"; xdotool key ctrl+l; xdotool type --clearmodifiers 'http://127.0.0.1:18082/'; xdotool key Return; for i in $(seq 1 60); do node -e 'try{const f=require("fs"),c=JSON.parse(f.readFileSync("/home/user/.mikka/shared-cookies/cookies.json"));process.exit(c.some(x=>x.name==="mikka_bot_342"&&x.value==="synthetic")?0:1)}catch{process.exit(1)}' && exit 0; sleep .5; done; echo 'Desktop cookie was not synchronized'; exit 1`, { user: 'user', timeoutMs: 65_000 }).catch(error => { console.error('Desktop fixture:', error.stdout ?? 'unavailable'); throw error })
  console.log('live Bot desktop: login cookie shared')
  await installSubagentRuntime(sandbox)
  const subagentId = randomUUID(), requestId = randomUUID()
  await startSubagentBrowser(sandbox, subagentId)
  await syncSubagentLease(sandbox, { subagentId, botId: randomUUID(), workspaceId: randomUUID(), ownerId: 'synthetic-owner', epoch: 0, controlledBy: null, controlUntil: 0, computerAllowed: true, policyVersion: 0, stopRequested: false })
  await sandbox.files.write(`/home/user/.mikka/subagents/${subagentId}/request-${requestId}.json`, JSON.stringify({ action: 'cookies' }), { user: 'user' })
  await sandbox.commands.run(`/usr/local/bin/node /opt/mikka/computer/subagent-rpc.mjs ${subagentId} ${requestId} > /tmp/mikka-desktop-cookie-fixture.json; node -e 'const fs=require("fs"),r=JSON.parse(fs.readFileSync("/tmp/mikka-desktop-cookie-fixture.json"));if(!r.cookies.some(c=>c.name==="mikka_bot_342"&&c.value==="synthetic"))process.exit(1)'`, { user: 'user', timeoutMs: 30_000 })
  await stopSubagentBrowser(sandbox, subagentId)
  console.log('live Bot desktop: cookie reached headless subagent')
  await sandbox.files.write('/tmp/mikka-driver-test.mjs', await readFile('packages/daemon/src/computer/driver.mjs', 'utf8'), { user: 'mikka-runner' })
  await sandbox.files.write('/tmp/mikka-driver-wait-test.mjs', `import { writeFile } from 'node:fs/promises';
import { detectComputerDriver, executeDriver } from './mikka-driver-test.mjs';
const [bot,owner,mode]=process.argv.slice(2); const driver=await detectComputerDriver('/opt/mikka/computer/cua-driver');
let allowed=true; if(mode==='cancel')setTimeout(()=>{allowed=false},1000);
try { await executeDriver(driver,{name:'get_desktop_state',arguments:{}},':1',{botId:bot,ownerId:owner,policyVersion:1,permitted:()=>allowed}); await writeFile('/tmp/mikka-wait-'+mode,'executed'); }
catch(error) { await writeFile('/tmp/mikka-wait-'+mode,mode==='cancel'&&String(error.message).includes('no longer active')?'cancelled':'failed'); }
`, { user: 'mikka-runner' })
  const botId = randomUUID(), ownerId = 'synthetic-owner'
  const held: DesktopLease = { botId, ownerId, display: 1, epoch: 1, controlledBy: ownerId, controlUntil: Date.now() / 1000 + 120, computerAllowed: true, policyVersion: 1 }
  await syncDesktopLease(sandbox, held)
  const first = await sandbox.commands.run(`node /tmp/mikka-driver-wait-test.mjs ${botId} ${ownerId} normal`, { user: 'mikka-runner', background: true, timeoutMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 2000))
  await sandbox.commands.run('test ! -e /tmp/mikka-wait-normal', { user: 'mikka-runner', timeoutMs: 10_000 })
  await syncDesktopLease(sandbox, { ...held, epoch: 2, controlledBy: null, controlUntil: 0 })
  await bounded(first.wait())
  assert.equal(await sandbox.files.read('/tmp/mikka-wait-normal', { user: 'mikka-runner' }), 'executed')
  await syncDesktopLease(sandbox, { ...held, epoch: 3 })
  const second = await sandbox.commands.run(`node /tmp/mikka-driver-wait-test.mjs ${botId} ${ownerId} cancel`, { user: 'mikka-runner', background: true, timeoutMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 2000))
  await syncDesktopLease(sandbox, { ...held, epoch: 4, controlledBy: null, controlUntil: 0 })
  await bounded(second.wait())
  assert.equal(await sandbox.files.read('/tmp/mikka-wait-cancel', { user: 'mikka-runner' }), 'cancelled')
  console.log('live thread control: wait, handback and cancellation passed')
} finally { await sandbox.kill() }

}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Live test failed"); process.exitCode = 1 })
