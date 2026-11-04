import assert from 'node:assert/strict'
import test from 'node:test'
import {verifyProductionRelease} from './production-release-pin.mjs'
const revision='a'.repeat(40),deploymentId='dpl_fixture'
const projectId='prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH',teamId='team_C7lwxVVvnUicFli6112mvxpv'
const env={VERCEL_DEPLOY_TOKEN:'synthetic-vercel-only'}
function fixture({alias={},deployment={},status=200}={}) {
  const calls=[]
  const fetchImpl=async(url,options)=>{
    const parsed=new URL(url);calls.push(parsed)
    assert.equal(parsed.origin,'https://api.vercel.com');assert.equal(parsed.searchParams.get('teamId'),teamId)
    assert.equal(options.method,'GET');assert.equal(options.redirect,'error')
    assert.deepEqual(options.headers,{authorization:'Bearer synthetic-vercel-only','cache-control':'no-store'})
    if(parsed.pathname==='/v4/aliases/app.aspectlylabs.com')return Response.json({alias:'app.aspectlylabs.com',projectId,deploymentId,...alias},{status})
    assert.equal(parsed.pathname,'/v13/deployments/'+deploymentId)
    return Response.json({id:deploymentId,projectId,target:'production',readyState:'READY',meta:{githubCommitSha:revision},...deployment},{status})
  }
  return {calls,run:(overrides={})=>verifyProductionRelease({revision,deploymentId,env,fetchImpl,now:()=>1000,...overrides})}
}
test('separate commit, deployment and current production alias identities bind without retaining private metadata',async()=>{
  const f=fixture(),receipt=await f.run()
  assert.deepEqual(receipt,{source:'vercel-api',alias:'app.aspectlylabs.com',teamId,projectId,deploymentId,revision,checkedAt:'1970-01-01T00:00:01.000Z'})
  assert.equal(f.calls.length,2);assert.doesNotMatch(JSON.stringify(receipt),/synthetic-vercel-only|Bearer|token/)
})
test('missing credentials or invalid fixed IDs stop before any platform request',async()=>{
  for(const overrides of [{env:{}},{revision:deploymentId},{deploymentId:revision},{deploymentId:'dpl_fixture/other'}]){
    const f=fixture();await assert.rejects(f.run(overrides),/^Error: preflight_release_/);assert.equal(f.calls.length,0)
  }
})
test('wrong alias, project, readiness, target or commit cannot bind the release',async()=>{
  for(const changes of [
    {alias:{deploymentId:'dpl_other'}},{alias:{projectId:'prj_other'}},{alias:{alias:'foreign.invalid'}},
    {alias:{redirect:'foreign.invalid'}},{alias:{deletedAt:1}},
    {deployment:{id:'dpl_other'}},{deployment:{projectId:'prj_other'}},{deployment:{target:'preview'}},
    {deployment:{readyState:'BUILDING'}},{deployment:{meta:{githubCommitSha:'b'.repeat(40)}}},{status:403},
  ]){const f=fixture(changes);await assert.rejects(f.run(),/^Error: preflight_release_/)}
})
