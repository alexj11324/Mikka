// Offline contract probe: startup only, synthetic HOME, no model turn or credentials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const binary = process.env.CODEX_CONTRACT_BIN

test('official Codex reports the actual explicit approval policy and sandbox', { skip: !binary && 'CODEX_CONTRACT_BIN not supplied', timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mikka-codex-contract-'))
  assert.match(execFileSync(binary!, ['--version'], { env: { PATH:process.env.PATH, HOME:dir, CODEX_HOME:dir }, encoding:'utf8' }), /codex-cli 0\.163\.0/)
  const child = spawn(binary!, ['app-server'], { cwd:dir, env:{ PATH:process.env.PATH, HOME:dir, CODEX_HOME:dir }, stdio:['pipe','pipe','ignore'] })
  const pending = new Map<number, (message: any) => void>()
  const lines = createInterface({ input:child.stdout })
  lines.on('line', line => { try { const msg=JSON.parse(line); pending.get(msg.id)?.(msg) } catch {} })
  const call = (id:number, method:string, params:object) => new Promise<any>((resolve,reject) => {
    const timer=setTimeout(() => reject(Error('contract timeout')),8000)
    pending.set(id, msg=>{ clearTimeout(timer); pending.delete(id); resolve(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc:'2.0',id,method,params })+'\n')
  })
  try {
    const init=await call(1,'initialize',{clientInfo:{name:'mikka-contract-test',version:'1'},capabilities:null})
    assert.ok(init.result)
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n')
    const thread=await call(2,'thread/start',{cwd:dir,approvalPolicy:'on-request',sandbox:'danger-full-access',ephemeral:true})
    assert.equal(thread.result.approvalPolicy,'on-request')
    assert.equal(thread.result.sandbox.type,'dangerFullAccess')
  } finally {
    lines.close()
    // Only the child created by this invocation is stopped; its directory and
    // diagnostics are retained. No previously retained process is addressed.
    child.kill('SIGTERM')
    await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit',()=>resolve()) })
  }
})
