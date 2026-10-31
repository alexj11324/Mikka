import { verifyBearer } from '@/lib/linear-sync/webhook'
import { sweepSchedules } from '@/lib/schedules/runtime'

export const runtime='nodejs'
export const maxDuration=60
const headers={'cache-control':'no-store'}
/** The existing minute Worker is the only caller; no session can sweep other owners. */
export async function GET(request:Request){
  const secret=process.env.CRON_SECRET
  if(!secret)return Response.json({error:'Cron is not configured'},{status:503,headers})
  if(!await verifyBearer(request.headers.get('authorization'),secret))return new Response(null,{status:401,headers})
  try{return Response.json(await sweepSchedules(),{headers})}
  catch{return Response.json({error:'scheduleSweepFailed'},{status:502,headers})}
}
