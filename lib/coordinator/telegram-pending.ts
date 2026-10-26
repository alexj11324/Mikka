import {telegramReplyTargets,type TelegramReplyTarget} from '../coordinator-events'
export type PendingTelegramTarget=TelegramReplyTarget&{workspaceId:string|null;sourceEventId:string;sequence:string}
const key=(target:PendingTelegramTarget)=>JSON.stringify([target.workspaceId,target.threadId,target.telegramUserId])
/** One watermark per destination. A later staged message must survive an ACK
 * from an older turn, including when the former arrives during chunk delivery. */
export function addTelegramPending(current:PendingTelegramTarget[],events:ReadonlyArray<{id:string;sequence:string;kind:string;payload:Record<string,unknown>;wake_workspace_id:string|null}>){
 const next=new Map(current.map(t=>[key(t),t]))
 for(const event of events){
  const targets=telegramReplyTargets([event as Parameters<typeof telegramReplyTargets>[0][number]])
  for(const target of targets){
   const value={...target,workspaceId:event.wake_workspace_id,sourceEventId:event.id,sequence:String(event.sequence)}
   if(!/^\d+$/.test(value.sequence))throw new Error('telegramSourceSequenceRequired')
   const old=next.get(key(value))
   if(!old||BigInt(old.sequence)<BigInt(value.sequence))next.set(key(value),value)
  }
 }
 return [...next.values()]
}
export function acknowledgeTelegramPending(current:PendingTelegramTarget[],sent:PendingTelegramTarget){
 return current.filter(t=>key(t)!==key(sent)||BigInt(t.sequence)>BigInt(sent.sequence))
}
export function hasTelegramPending(current:PendingTelegramTarget[],target:PendingTelegramTarget){
 return current.some(t=>key(t)===key(target)&&BigInt(t.sequence)>=BigInt(target.sequence))
}
