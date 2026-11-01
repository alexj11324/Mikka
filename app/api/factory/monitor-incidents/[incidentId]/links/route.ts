import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { FactoryError } from '@/lib/factory/contract'
import { factoryMonitorIssueLinks } from '@/lib/factory/server'
import { GitHubAccessError } from '@/lib/github/user-access'

export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store'}
async function respond(request:Request,{params}:{params:Promise<{incidentId:string}>}){
  const session=await auth.api.getSession({headers:request.headers})
  if(!session?.user)return NextResponse.json({error:'authRequired'},{status:401,headers})
  if(request.method==='POST'&&request.headers.get('origin')!==new URL(request.url).origin)return NextResponse.json({error:'originRejected'},{status:403,headers})
  try{
    const {incidentId}=await params
    const result=request.method==='POST'
      ?await factoryMonitorIssueLinks.linkGitHub(session.user.id,incidentId,request.headers,await request.json().catch(()=>null))
      :await factoryMonitorIssueLinks.read(session.user.id,incidentId)
    return NextResponse.json(result,{headers})
  }catch(error){
    if(error instanceof GitHubAccessError)return NextResponse.json({error:error.code},{status:error.status,headers})
    if(error instanceof FactoryError){
      const status=error.code==='factoryNotFound'?404:error.code==='factoryInvalid'?422:409
      return NextResponse.json({error:error.code},{status,headers})
    }
    return NextResponse.json({error:'factoryUnavailable'},{status:503,headers})
  }
}
export const GET=respond
export const POST=respond
