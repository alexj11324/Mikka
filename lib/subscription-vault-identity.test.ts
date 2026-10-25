import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {subscriptionVaultCredentials} from './subscription-vault-identity'
import {createSubscriptionVaultTokens} from './subscription-vault-auth'
import {universalAuthTokenProvider} from './credentials/universal-auth'
const config=():NodeJS.ProcessEnv=>({NODE_ENV:'test',MIKKA_BYOS_VAULT_AUTH:'universal',MIKKA_BYOS_INFISICAL_ORIGIN:'https://app.infisical.com',MIKKA_BYOS_CUSTODY_CLIENT_ID:'synthetic-shared',MIKKA_BYOS_CUSTODY_CLIENT_SECRET:'synthetic-secret',MIKKA_BYOS_ACCESS_CLIENT_ID:'synthetic-shared',MIKKA_BYOS_ACCESS_CLIENT_SECRET:'synthetic-secret',MIKKA_BYOS_TRANSFER_SOURCE_CLIENT_ID:'synthetic-shared',MIKKA_BYOS_TRANSFER_SOURCE_CLIENT_SECRET:'synthetic-secret'})
test('only exact server opt-in admits shared source and access; no credential fallback',()=>{
 const env=config()
 for(const flag of [undefined,'0','true','yes']) {
  env.MIKKA_BYOS_SHARED_IDENTITY=flag
  assert.equal(subscriptionVaultCredentials(env,'source'),undefined)
  assert.equal(subscriptionVaultCredentials(env,'access'),undefined)
 }
 env.MIKKA_BYOS_SHARED_IDENTITY='1'
 assert.ok(subscriptionVaultCredentials(env,'source'))
 assert.ok(subscriptionVaultCredentials(env,'access'))
 delete env.MIKKA_BYOS_TRANSFER_SOURCE_CLIENT_SECRET
 assert.equal(subscriptionVaultCredentials(env,'source'),undefined)
 env.MIKKA_BYOS_VAULT_AUTH='static'
 assert.equal(subscriptionVaultCredentials(env,'custody'),undefined)
})
test('real isolated HTTP: shared source denial isolates caches; issuer 30-day tokens accepted',async()=>{
 let ttl=600,calls=0
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  assert.equal(req.url,'/api/v1/auth/universal-auth/login')
  assert.deepEqual(JSON.parse(raw),{clientId:'synthetic-shared',clientSecret:'synthetic-secret'})
  calls++;res.setHeader('content-type','application/json')
  res.end(JSON.stringify({accessToken:'synthetic-identical-lease',tokenType:'Bearer',expiresIn:ttl}))
 })
 server.listen(0,'127.0.0.1');await once(server,'listening')
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const fetcher:typeof fetch=async(url,options)=>{
   assert.equal(String(url),'https://app.infisical.com/api/v1/auth/universal-auth/login')
   return fetch(`http://127.0.0.1:${address.port}/api/v1/auth/universal-auth/login`,options)
  }
  const env=config();env.MIKKA_BYOS_SHARED_IDENTITY='1'
  const tokens=createSubscriptionVaultTokens(()=>env,fetcher)
  const source=universalAuthTokenProvider({origin:env.MIKKA_BYOS_INFISICAL_ORIGIN!,credentials:()=>subscriptionVaultCredentials(env,'source'),fetch:fetcher,minimumValidityMs:105000})
  const custody=await tokens.get('custody'),access=await tokens.get('access'),lease=await source.getAccessToken()
  assert.equal(calls,3);source.rejectAccessToken(lease)
  await assert.rejects(source.getAccessToken())
  assert.equal(await tokens.get('custody'),custody);assert.equal(await tokens.get('access'),access)
  ttl=2592000
  const long=createSubscriptionVaultTokens(()=>env,fetcher)
  assert.equal(await long.get('custody'),'synthetic-identical-lease')
  assert.equal(await long.get('access'),'synthetic-identical-lease')
 }finally{server.close();await once(server,'close')}
})
