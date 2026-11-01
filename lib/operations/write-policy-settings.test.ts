import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createWritePolicySettings } from './write-policy-settings'

function fixture() {
 const scope = { ownerId:'owner', botId:randomUUID(), workspaceId:randomUUID() }
 const state = { permissions:{} as Record<string,string>, version:0, member:true, commits:0, closed:0 }
 let staged: Record<string,string> | undefined
 const pool = { connect:async () => ({ release() {}, query:async (sql:string, args:unknown[]=[]) => {
  if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows:[] }
  if (sql === 'COMMIT') { if (staged) { state.permissions=staged; state.version++ }; state.commits++; return { rows:[] } }
  if (sql.startsWith('select external_write_permissions')) return { rows:args[0] === scope.ownerId && args[1] === scope.botId && args[2] === scope.workspaceId ? [{permissions:state.permissions,version:String(state.version)}] : [] }
  if (sql.startsWith('update agent_kit_heads')) { staged=args[2] as Record<string,string>; return { rows:[{permissions:staged,version:String(state.version+1)}] } }
  throw Error('unexpected query')
 } }) } as unknown as Parameters<typeof createWritePolicySettings>[0]
 const settings=createWritePolicySettings(pool, s => s.botId ? async () => {
  if (!state.member) throw Error('membership revoked')
  return { check:async()=>{ if (!state.member) throw Error('membership revoked') }, close:async()=>{state.closed++} }
 } : undefined)
 return {settings,scope,state}
}
test('settings are scoped, versioned, and acquire membership before commit',async()=>{
 const f=fixture()
 assert.deepEqual(await f.settings.set(f.scope,{write_document:'allow'},'0'),{permissions:{write_document:'allow'},version:'1'})
 assert.equal(f.state.closed,1)
 await assert.rejects(f.settings.set(f.scope,{write_document:'deny'},'0'),/writePolicyChanged/)
 assert.deepEqual(f.state.permissions,{write_document:'allow'})
 f.state.member=false
 await assert.rejects(f.settings.set(f.scope,{write_document:'deny'},'1'),/membership revoked/)
 assert.deepEqual(f.state.permissions,{write_document:'allow'})
 await assert.rejects(f.settings.read({...f.scope,ownerId:'other'}),/agentScopeNotFound/)
})

test('browser actions have no ask: the settings schema rejects it, allow and deny stay valid', async () => {
 const { writePolicySettingsSchema } = await import('./write-policy-settings')
 assert.equal(writePolicySettingsSchema.safeParse({ browser_payment:'ask' }).success, false)
 assert.equal(writePolicySettingsSchema.safeParse({ browser_browse:'allow', browser_payment:'deny' }).success, true)
 // Other write actions keep ask.
 assert.equal(writePolicySettingsSchema.safeParse({ send_slack_message:'ask' }).success, true)
})
