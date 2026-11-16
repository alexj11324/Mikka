import assert from 'node:assert/strict'

export async function verifyCleanup(scope:any, origin:string, result:any, record:any, recoverDevice:any) {
  const session = async () => {
    const response = await scope.owner.request('/api/auth/get-session')
    assert.equal(response.status,200)
    return response.json()
  }
  assert.equal((await session()).session.id,result.session.id)
  const grantResponse=await scope.owner.request('/api/devices/enrollment',{method:'POST'})
  assert.equal(grantResponse.status,200)
  const {token}=await grantResponse.json()
  const enrolled=await fetch(origin+'/mikka/v1/devices/enroll',{
    method:'POST',headers:{authorization:'Bearer '+token},redirect:'error',
  })
  assert.equal(enrolled.status,200)
  await enrolled.body?.cancel()
  const list=await scope.owner.request('/api/device-tokens')
  assert.equal(list.status,200)
  const {tokens}=await list.json()
  assert.equal(tokens.length,1)
  const id=tokens[0].id
  const revoke=()=>scope.owner.request('/api/device-tokens/'+id+'/revoke',{method:'POST'})
  const signout=await fetch(origin+'/mikka/api/auth/sign-out',{
    method:'POST',headers:{authorization:'Bearer '+result.token,origin,'content-type':'application/json'},body:'{}',redirect:'error',
  })
  assert.equal(signout.status,200)
  await signout.body?.cancel()
  const expired=await revoke()
  assert.equal(expired.status,401)
  await expired.body?.cancel()
  record('native_logout_invalidates_original_owner_revoke',{status:expired.status})
  await recoverDevice(id,true)
  const current=await session()
  assert.equal(current.user.id,scope.owner.userId)
  assert.notEqual(current.session.id,result.session.id)
  record('same_lease_same_owner_fresh_session_revokes_real_device')
  // Repeat the real failure independently. The shared finalizer must still
  // retire the actual lease, and must preserve the failed revoke as a failure.
  const repeated=await scope.owner.request('/api/auth/sign-out',{
    method:'POST',headers:{'content-type':'application/json'},body:'{}',
  })
  assert.equal(repeated.status,200)
  await repeated.body?.cancel()
  record('second_owner_logout_before_independent_lease_release')
  return id
}
