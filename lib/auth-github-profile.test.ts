import assert from 'node:assert/strict'
import { test } from 'node:test'
import { githubVerifiedProfile } from './auth-github-profile'
function fixture(emails: unknown, profile: unknown = { id: 123, email: 'display@example.test', login: 'synthetic' }) {
 return githubVerifiedProfile(async (url, init) => { assert.equal(init?.redirect, 'error'); return Response.json(String(url).endsWith('/emails') ? emails : profile) })
}
test('GitHub uses verified primary email rather than a verified public non-primary address', async () => {
 const result = await fixture([{email:'primary@example.test',primary:true,verified:true},{email:'display@example.test',primary:false,verified:true}])({accessToken:'synthetic'})
 assert.equal(result?.user.email,'primary@example.test');assert.equal(result?.data.id,123);assert.equal(result?.user.emailVerified,true)
})
test('GitHub rejects missing/unverified/ambiguous primary emails and malformed subjects', async () => {
 for(const emails of [[],[{email:'a@example.test',primary:true,verified:false}],[{email:'a@example.test',primary:false,verified:true}],[{email:'a@example.test',primary:true,verified:true},{email:'b@example.test',primary:true,verified:true}],[{email:'bad',primary:true,verified:true}]]) assert.equal(await fixture(emails)({accessToken:'synthetic'}),null)
 assert.equal(await fixture([{email:'a@example.test',primary:true,verified:true}],{id:'123'})({accessToken:'synthetic'}),null)
 assert.equal(await fixture([])({}),null)
})
test('GitHub profile retrieval fails closed on HTTP or malformed JSON without logging credentials', async () => {
 for (const request of [async()=>new Response('upstream denied',{status:403}),async()=>new Response('malformed',{status:200}),async()=>{throw new Error('synthetic network failure')}]) assert.equal(await githubVerifiedProfile(request)({accessToken:'synthetic'}),null)
})
