import { appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { readServingPromotion, readWebAuthority } from '../release/cloudflare-promoted-web.mjs'
import { githubRead } from '../release/web-deploy.mjs'

const issue='https://api.github.com/repos/alexj11324/Mikka/issues/1951'
const reference=/^(?:[1-9][0-9]{0,15}-[a-f0-9]{64}|actions:[1-9][0-9]{0,15}:[1-9][0-9]{0,15})$/
const sha=/^[a-f0-9]{64}$/
const digest=text=>createHash('sha256').update(text).digest('hex')
const needed=['scheduledCadence','runtimeComparison','requestSlis','pressureDelivery','filesystemDelivery','queryAttribution']
const approvedRoles=new Set(['admin','write'])
const fixed=(condition,code)=>{if(!condition)throw Error('runtimeMonitor:'+code)}

// The original issue carries a digest pin to its actual completed milestone.
// An untrusted comment, changing the milestone body or traffic rollback keeps
// the Vercel runtime checks active. The Neon/PostHog owner never changes here.
export async function runtimeMonitorOwner({token=process.env.GITHUB_TOKEN,fetchImpl=fetch,now=Date.now(),windowStart=now-900000,
  authority=readWebAuthority,promotion=readServingPromotion,read=githubRead,verifiedPublisher}={}){
  try {
    const origin=await authority(fetchImpl)
    if(origin.provider!=='cloudflare')return {runtime:'vercel',reason:'serving_vercel'}
    const api={token,fetchImpl},parent=await read('/issues/1951',api)
    fixed(parent.url===issue&&parent.number===1951,'issue')
    const pins=[...parent.body.matchAll(/^<!-- MIKKA_RUNTIME_MONITOR_MILESTONE ([1-9][0-9]{0,15})-([a-f0-9]{64}) -->$/gm)]
    if(!pins.length)return {runtime:'vercel',reason:'qualification_pending'}
    fixed(pins.length===1,'milestone')
    const [,id,hash]=pins[0],comment=await read('/issues/comments/'+id,api)
    fixed(String(comment.id)===id&&comment.issue_url===issue&&digest(comment.body)===hash,'milestone')
    fixed(['OWNER','MEMBER','COLLABORATOR'].includes(comment.author_association)&&
      /^[a-zA-Z0-9-]{1,39}$/.test(comment.user?.login)&&Number.isSafeInteger(comment.user.id),'maintainer')
    const milestone=id+'-'+hash
    if(verifiedPublisher){
      // A consumer without public-repository credentials can recheck the
      // original public scheduled job's own successful verification of this pin.
      fixed(await verifiedPublisher(milestone),'publisher')
    }else{
      const role=await read('/collaborators/'+comment.user.login+'/permission',api)
      fixed(role.user?.id===comment.user.id&&approvedRoles.has(role.permission),'maintainer')
    }
    const prefix='MIKKA_RUNTIME_MONITOR_MILESTONE_V1\n'
    fixed(comment.body.startsWith(prefix),'schema')
    const raw=comment.body.slice(prefix.length),m=JSON.parse(raw)
    fixed(Object.keys(m).join('|')==='schema|promotion|firstQuarter|lastQuarter|effectiveAt|evidence'&&JSON.stringify(m)===raw&&
      m.schema==='mikka.runtime-monitor-milestone.v1'&&reference.test(m.promotion),'schema')
    const from=Date.parse(m.firstQuarter),until=Date.parse(m.lastQuarter)
    fixed(Number.isFinite(from)&&Number.isFinite(until)&&new Date(from).toISOString()===m.firstQuarter&&
      new Date(until).toISOString()===m.lastQuarter&&from%900000===0&&until%900000===0&&until-from>=8*900000&&until<=now,'quarters')
    fixed(new Date(comment.created_at).getTime()>=until&&new Date(comment.created_at).getTime()<=now,'milestoneTime')
    const effective=Date.parse(m.effectiveAt)
    fixed(Number.isFinite(effective)&&new Date(effective).toISOString()===m.effectiveAt&&effective%900000===0&&
      effective>=Date.parse(comment.created_at)+900000,'effectiveWindow')
    fixed(m.evidence&&Object.keys(m.evidence).join('|')===needed.join('|'),'evidence')
    for(const key of needed){
      const ref=m.evidence[key]
      fixed(ref&&Object.keys(ref).join('|')==='url|sha256'&&sha.test(ref.sha256)&&
        /^https:\/\/github\.com\/alexj11324\/mikka-cloud\/issues\/4#issuecomment-[1-9][0-9]{0,15}$/.test(ref.url),'evidence')
    }
    const serving=await promotion(m.promotion,{...api,now})
    fixed(serving.product===origin.sha&&Date.parse(serving.verifiedAt)<=from,'promotion')
    if(!Number.isSafeInteger(windowStart)||windowStart<effective)return {runtime:'vercel',reason:'handoff_not_effective'}
    return {runtime:'cloudflare',promotion:m.promotion,milestone,observedUntil:until,reason:'verified_handoff'}
  }catch{return {runtime:'vercel',reason:'handoff_unverified'}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await runtimeMonitorOwner()
  console.log('Runtime source: '+result.runtime+' ('+result.reason+')')
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'runtime='+result.runtime+'\nmilestone='+(result.milestone??'')+'\n')
}
