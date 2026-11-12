import {NextResponse} from 'next/server'
import {auth} from '@/lib/api-auth'

export const dynamic='force-dynamic'
/** The old wire label is retained for installed clients; Eve owns execution. */
export async function GET(request:Request) {
  const session=await auth.api.getSession({headers:request.headers})
  if(!session?.user)return NextResponse.json({error:'authRequired'},{status:401})
  return NextResponse.json({available:false,runtime:{harness:'ai_sdk'}},{headers:{'Cache-Control':'private, no-store'}})
}
export async function PUT(request:Request) {
  const session=await auth.api.getSession({headers:request.headers})
  if(!session?.user)return NextResponse.json({error:'authRequired'},{status:401})
  return NextResponse.json({error:'notEnabled'},{status:404})
}
