import { authorizePolicyWorker } from '@/lib/policy/runtime'
import { PolicyError } from '@/lib/policy/contract'
import { pool } from '@/lib/db'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { SKILL_ARTIFACT_HEADER } from '@mikka/protocol/skill'
import { authenticateDevice } from '@/lib/device-link'
import { skillAssignments } from '@/lib/self-improvement/server'
import { ImprovementError } from '@/lib/self-improvement/contract'

export const dynamic='force-dynamic'
export async function GET(request:Request,{params}:{params:Promise<{runId:string}>}) {
  const caller=await authenticateDevice(request)
  if (!caller) return NextResponse.json({error:'authRequired'},{status:401})
  const {runId}=await params, receiptId=new URL(request.url).searchParams.get('receiptId')
  if (!z.uuid().safeParse(receiptId).success) return NextResponse.json({error:'invalid'},{status:422})
  try {
    const run=(await pool.query('SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2',[runId,caller.userId])).rows[0]
    if(!run)return NextResponse.json({error:"notFound"},{status:404})
    await authorizePolicyWorker(caller.userId,runId,run.issueId??undefined)
    return NextResponse.json(await skillAssignments.revalidate(caller.userId,runId,receiptId!,request.headers.get(SKILL_ARTIFACT_HEADER)==='1'),{headers:{'Cache-Control':'private, no-store'}})
  } catch(error) {
    if(error instanceof PolicyError)return NextResponse.json({error:error.code},{status:error.status})
    if (!(error instanceof ImprovementError)) return NextResponse.json({error:"policyUnavailable"},{status:503})
    return NextResponse.json({error:error.code},{status:error.code==='notFound'?404:409})
  }
}
