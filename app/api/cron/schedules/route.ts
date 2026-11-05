import { cronUnauthorized } from '@/lib/cron-auth'
import { cronJob } from '@/lib/background'
import { scheduleNextDue, sweepSchedules } from '@/lib/schedules/runtime'
import { armDueTimer } from '@/lib/due-timer'

export const runtime='nodejs'
export const maxDuration=60
const headers={'cache-control':'no-store'}
/** The minute Worker calls this every 10 minutes (#1212): the schedules due timer (lib/due-timer.ts) does the
 * work at its due time; this sweep recovers a timer start that was lost and re-arms it. No session can sweep other owners. */
async function handleGET(request:Request){
  const refused=await cronUnauthorized(request);if(refused)return refused
  try{const counts=await sweepSchedules();if(await scheduleNextDue()!==null)await armDueTimer('schedules');return Response.json(counts,{headers})}
  catch{return Response.json({error:'scheduleSweepFailed'},{status:502,headers})}
}

export const GET = cronJob('schedules', handleGET)
