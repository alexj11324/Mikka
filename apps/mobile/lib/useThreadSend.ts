import { useRef, useState } from 'react'
import { uuid } from 'expo'
import { api, ApiError } from './api'
import { apiCache } from './api-cache'
import { threadSendErrorLine } from './thread-send-error'

/** Retain the same UUID/body after an ambiguous response. A new recipient,
 * credential authorization or account cannot reuse an earlier submission. */
export function useThreadSend(id:string|null,executionGrantId:string,reload:()=>Promise<void>) {
  const pending=useRef<{id:string;text:string;executionGrantId:string;requestId:string;context:number}|null>(null)
  const busy=useRef(false)
  const [sending,setSending]=useState(false),[sendFailed,setSendFailed]=useState<string|null>(null)
  async function send(text:string) {
    if(!id||busy.current)return false
    const context=apiCache.context()
    const previous=pending.current
    const submission=previous?.id===id&&previous.text===text&&previous.executionGrantId===executionGrantId&&previous.context===context
      ?previous:{id,text,executionGrantId,context,requestId:uuid.v4()}
    pending.current=submission;busy.current=true;setSending(true);setSendFailed(null)
    try{
      await api(`/api/mobile/threads/${id}`,{method:'POST',body:{text,requestId:submission.requestId,...executionGrantId?{executionGrantId}:{}}})
      if(!apiCache.commit(context,()=>{pending.current=null;setSendFailed(null)}))return false
      await reload()
      return true
    }catch(error){
      apiCache.commit(context,()=>setSendFailed(threadSendErrorLine(error instanceof ApiError&&error.status<500?error.code:null)))
      return false
    }finally{busy.current=false;setSending(false)}
  }
  return {send,sending,sendFailed}
}
