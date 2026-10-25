import test from 'node:test'
import assert from 'node:assert/strict'
import {createSubscriptionVaultTokens} from './subscription-vault-auth'
const config=()=>({MIKKA_BYOS_INFISICAL_ORIGIN:'https://app.infisical.com',MIKKA_BYOS_VAULT_AUTH:'universal',MIKKA_BYOS_CUSTODY_CLIENT_ID:'custody-fixture',MIKKA_BYOS_CUSTODY_CLIENT_SECRET:'custody-fixture-secret',MIKKA_BYOS_ACCESS_CLIENT_ID:'access-fixture',MIKKA_BYOS_ACCESS_CLIENT_SECRET:'access-fixture-secret'})
test('custody enrollment has no reader dependency; scoped providers do not share credentials or denial',async()=>{
 const env:NodeJS.ProcessEnv=config(); const seen:string[]=[]
 const tokens=createSubscriptionVaultTokens(()=>env,async(url,options)=>{
  assert.equal(String(url),'https://app.infisical.com/api/v1/auth/universal-auth/login')
  assert.equal(options?.redirect,'error')
  const body=JSON.parse(String(options?.body));seen.push(body.clientId)
  return Response.json({accessToken:`synthetic-${body.clientId}`,tokenType:'Bearer',expiresIn:600})
 })
 delete env.MIKKA_BYOS_ACCESS_CLIENT_SECRET
 assert.equal(await tokens.get('custody'),'synthetic-custody-fixture')
 await assert.rejects(tokens.get('access'))
 env.MIKKA_BYOS_ACCESS_CLIENT_SECRET='access-fixture-secret'
 const access=await tokens.get('access');tokens.reject('access',access)
 await assert.rejects(tokens.get('access'))
 assert.equal(await tokens.get('custody'),'synthetic-custody-fixture')
 assert.deepEqual(seen,['custody-fixture','access-fixture'])
})
test('same identity, disabled auth, or rotated origin fail without static fallback',async()=>{
 const env:NodeJS.ProcessEnv=config(); let calls=0
 const tokens=createSubscriptionVaultTokens(()=>env,async()=>{calls++;throw new Error('must not reach transport')})
 env.MIKKA_BYOS_ACCESS_CLIENT_ID=env.MIKKA_BYOS_CUSTODY_CLIENT_ID
 await assert.rejects(tokens.get('access'))
 env.MIKKA_BYOS_VAULT_AUTH='static';env.MIKKA_BYOS_INFISICAL_TOKEN='synthetic-legacy-admin'
 await assert.rejects(tokens.get('custody'))
 env.MIKKA_BYOS_VAULT_AUTH='universal';env.MIKKA_BYOS_INFISICAL_ORIGIN='https://us.infisical.com'
 await assert.rejects(tokens.get('custody'));assert.equal(calls,0)
})
