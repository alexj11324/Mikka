import assert from 'node:assert/strict'
import test from 'node:test'
import { eveRunOrigin } from './run-origin'

test('native host tools retain the authenticated source surface and only opaque entry ids',()=>{
  assert.deepEqual(eveRunOrigin('web',undefined,false),{origin:'web',originRef:null})
  assert.deepEqual(eveRunOrigin('web',{telegram:{threadId:'42',messageId:7,text:'private text',telegramUserId:'private user'}},false),
    {origin:'telegram',originRef:{kind:'telegram',chatId:'42',messageId:7}})
  const payload={source:'slack',slack:{teamId:'T1',channelId:'C1',threadTs:'2.0',ts:'3.0',text:'private text',userId:'private user',workspaceId:'untrusted'}}
  assert.deepEqual(eveRunOrigin('slack',payload,false),{origin:'slack',originRef:{kind:'slack',teamId:'T1',channelId:'C1',threadTs:'2.0'}})
  assert.deepEqual(eveRunOrigin('slack',{slack:{teamId:'T1',channelId:'C1',ts:'3.0'}},false),{origin:'slack',originRef:{kind:'slack',teamId:'T1',channelId:'C1',threadTs:'3.0'}})
  assert.deepEqual(eveRunOrigin('slack',{slack:{teamId:'T1'}},false),{origin:'slack',originRef:null})
  assert.deepEqual(eveRunOrigin('web',payload,false),{origin:'web',originRef:null},'foreign payload metadata cannot choose the authenticated surface')
})

test('scheduled native work remains schedule evidence regardless of original surface',()=>{
  for(const surface of ['web','slack'] as const)assert.deepEqual(eveRunOrigin(surface,{telegram:{threadId:'42',messageId:7}},true),{origin:'schedule',originRef:null})
})
