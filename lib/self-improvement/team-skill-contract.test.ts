import assert from 'node:assert/strict'
import test from 'node:test'
import { skillMarkdown } from '@mikka/protocol/skill'
import { resolveTeamSkillContent, teamSkillArtifact, teamSkillUploadSchema } from './team-skill-contract'

const upload={name:'Team review',description:null,instructions:'Review the changed code.',source:'workspace-upload',
  license:'MIT',format:'single-skill-md-v1',dependencies:[],permissions:[]}
test('the first team format accepts canonical guidance bytes and rejects permission or dependency expansion',()=>{
  assert.ok(teamSkillUploadSchema.safeParse(upload).success)
  for(const changed of [{permissions:['network']},{dependencies:[{name:'package',version:'latest'}]},
    {format:'zip'},{source:'https://untrusted.example/redirect'},{files:[{path:'../escape',content:'bad'}]},
    {symlink:'outside'},{sha256:'a'.repeat(64)},{name:'Team\npermissions: allow'}])
    assert.equal(teamSkillUploadSchema.safeParse({...upload,...changed}).success,false)
})
test('assignment content must match the exact registered digest, identity and canonical raw bytes',()=>{
  const skillId='10000000-0000-4000-8000-000000000001',versionId='10000000-0000-4000-8000-000000000002'
  const markdown=skillMarkdown(upload),artifact=teamSkillArtifact(versionId,skillId,markdown)
  assert.equal(resolveTeamSkillContent({skillId,...upload},artifact,markdown).instructions,upload.instructions)
  assert.throws(()=>resolveTeamSkillContent({skillId,...upload},{...artifact,sha256:'f'.repeat(64)},markdown))
  assert.throws(()=>resolveTeamSkillContent({skillId,...upload},artifact,markdown+'unreviewed change'))
})
