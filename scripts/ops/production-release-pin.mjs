/** Read-only deployment identity, separate from the app's Git build SHA.
 * Token is sent only to Vercel's fixed API origin and never returned/logged. */
export async function verifyProductionRelease({revision,deploymentId,env=process.env,fetchImpl=fetch,now=Date.now}={}) {
  const teamId='team_C7lwxVVvnUicFli6112mvxpv',projectId='prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH',alias='app.aspectlylabs.com'
  const check=(condition,reason)=>{if(!condition)throw Error(reason)}
  check(/^[a-f0-9]{40}$/.test(revision??'') && /^dpl_[A-Za-z0-9]+$/.test(deploymentId??''),'preflight_release_identity_required')
  const token=env.VERCEL_DEPLOY_TOKEN
  check(typeof token==='string' && token.length>0,'preflight_release_auth_required')
  const get=async path=>{
    const url=new URL(path,'https://api.vercel.com')
    url.searchParams.set('teamId',teamId)
    const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{authorization:'Bearer '+token,'cache-control':'no-store'}})
    if(!response.ok){await response.body?.cancel();throw Error('preflight_release_unavailable')}
    return response.json().catch(()=>{throw Error('preflight_release_invalid')})
  }
  const [current,deployment]=await Promise.all([get('/v4/aliases/'+alias),get('/v13/deployments/'+deploymentId)])
  check(current?.alias===alias && current.projectId===projectId && current.deploymentId===deploymentId &&
    current.deletedAt==null && current.redirect==null,'preflight_release_alias_changed')
  check(deployment?.id===deploymentId && (deployment.projectId??deployment.project?.id)===projectId &&
    deployment.target==='production' && deployment.readyState==='READY' &&
    deployment.meta?.githubCommitSha===revision,'preflight_release_deployment_changed')
  return {source:'vercel-api',alias,teamId,projectId,deploymentId,revision,checkedAt:new Date(now()).toISOString()}
}
