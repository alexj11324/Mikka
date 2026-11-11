import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scratchConnection, emptyScratchSnapshot, type ScratchSnapshot } from './sandbox-filesystem'

test('portable JustBash keeps binary attachments and skill files without host files or credentials',async()=>{
  let saved:ScratchSnapshot=emptyScratchSnapshot()
  const connection=scratchConnection(async work=>{const result=await work(saved);saved=result.snapshot;return result.value})
  const bytes=new Uint8Array([0,255,1,128,10])
  await connection.writeFiles({files:[{path:'/workspace/attachment.bin',content:bytes},{path:'/home/eve/.agents/skills/demo/SKILL.md',content:new TextEncoder().encode('# Demo\nUse this skill.\n')}]})
  let restored=JSON.parse(JSON.stringify(saved)) as ScratchSnapshot
  const next=scratchConnection(async work=>{const result=await work(restored);restored=result.snapshot;return result.value})
  assert.deepEqual(Array.from(await next.readFile({path:'/workspace/attachment.bin'}) as Uint8Array),Array.from(bytes))
  const process=await next.spawn({command:'cat "$HOME/.agents/skills/demo/SKILL.md"; printf "%s" "$ONE_CALL"',env:{ONE_CALL:'synthetic-call-only'},workingDirectory:'/workspace'})
  assert.equal((await process.wait()).exitCode,0)
  assert.equal(await new Response(process.stdout).text(),'# Demo\nUse this skill.\nsynthetic-call-only')
  assert.equal(JSON.stringify(restored).includes('synthetic-call-only'),false)
  assert.equal(await next.readFile({path:'/etc/hostname'}),null)
  const resolved=await next.spawn({command:'realpath -e -z -- /workspace/attachment.bin',env:{},workingDirectory:'/workspace'})
  assert.equal((await resolved.wait()).exitCode,0)
  assert.equal(await new Response(resolved.stdout).text(),'/workspace/attachment.bin\0')
  const blocked=await next.spawn({command:'curl https://example.invalid',env:{},workingDirectory:'/workspace'})
  assert.notEqual((await blocked.wait()).exitCode,0)
})
