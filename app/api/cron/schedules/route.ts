import { cronUnauthorized } from '@/lib/cron-auth'
import { cronJob } from '@/lib/background'
import { sweepSchedules } from '@/lib/schedules/runtime'

export const runtime='nodejs'
export const maxDuration=60
const headers={'cache-control':'no-store'}
/** The existing minute Worker is the only caller; no session can sweep other owners. */
async function handleGET(request:Request){
  const refused=await cronUnauthorized(request);if(refused)return refused
  try{return Response.json(await sweepSchedules(),{headers})}
  catch{return Response.json({error:'scheduleSweepFailed'},{status:502,headers})}
}

export const GET = cronJob('schedules', handleGET)
