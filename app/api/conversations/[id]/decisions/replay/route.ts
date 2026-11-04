import { respondGroupDecisionReplay } from '@/lib/group-conversations-route'
export const dynamic='force-dynamic'
export const maxDuration=60
type Context={params:Promise<{id:string}>}
export async function POST(request:Request,{params}:Context){return respondGroupDecisionReplay(request,(await params).id)}
