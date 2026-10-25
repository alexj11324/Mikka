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
    return NextResponse.json(await skillAssignments.revalidate(caller.userId,runId,receiptId!,request.headers.get(SKILL_ARTIFACT_HEADER)==='1'),{headers:{'Cache-Control':'private, no-store'}})
  } catch(error) {
    if (!(error instanceof ImprovementError)) throw error
    return NextResponse.json({error:error.code},{status:error.code==='notFound'?404:409})
  }
}
