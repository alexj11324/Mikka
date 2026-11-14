import { assertNoSecret, type SecretFingerprint } from '../credentials/fingerprint'
import { credentialMasker, identityMasker, maskStreamStep, withCredentialMasking } from '../secrets/mask'

type Block = {pending:string;unreleased:string;blocked:boolean}
/** A security projection of native eve lines. One source line remains one line,
 * so eve's own cursors, replay and React state remain authoritative. */
export function maskEveStream(ownerId:string,fingerprints:SecretFingerprint[],startIndex=0) {
  const holdback = Math.max(0,...fingerprints.map(value=>value.length-1))
  const masker = withCredentialMasking(identityMasker)
  const blocks = new Map<string,Block>()
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  let pending='',index=0
  function safe(value:unknown):any {
    if (typeof value === 'string') {
      const masked = credentialMasker(value)
      try {assertNoSecret(ownerId,masked,fingerprints);return masked} catch {return '[redacted]'}
    }
    if (Array.isArray(value)) return value.map(safe)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[safe(key), /^(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key) ? '[redacted]' : safe(item)]))
    return value
  }
  function event(value:any) {
    if (value?.type === 'call.input') return {...value,data:{...value.data,delta:''}}
    if (value?.type === 'content.delta' && typeof value.data?.partId === 'string' && typeof value.data?.delta === 'string') {
      const id=value.data.partId,block=blocks.get(id)??{pending:'',unreleased:'',blocked:false}
      blocks.set(id,block)
      if (block.blocked) return {...value,data:{...value.data,delta:''}}
      const step=maskStreamStep(masker,block.pending,value.data.delta,false)
      block.pending = step.pending
      // Any newly completed fingerprint begins in the previous unreleased suffix or the new text.
      const text = block.unreleased + step.release
      try { assertNoSecret(ownerId,text,fingerprints) } catch { block.blocked = true }
      const through = Math.max(0, text.length - holdback)
      const delta = block.blocked ? '' : text.slice(0, through)
      block.unreleased = block.blocked ? '' : text.slice(through)
      return {...value,data:{...value.data,delta}}
    }
    if (value?.type === 'content.completed') blocks.delete(value.data?.partId)
    return safe(value)
  }
  function line(text:string,controller:TransformStreamDefaultController<Uint8Array>) {
    if (!text.trim()) return
    const value=JSON.parse(text)
    if (value?.$eve) {
      if (value.$eve === 'position' && Number.isSafeInteger(value.next)) index=value.next
      if (index>=startIndex) controller.enqueue(encoder.encode(JSON.stringify(safe(value))+'\n'))
      return
    }
    const projected=Array.isArray(value?.facts)?{...value,facts:value.facts.map(event)}
      :value?.progress?{...value,progress:event(value.progress)}:null
    if (!projected) throw new Error('eveProtocolUnavailable')
    if (index++>=startIndex) controller.enqueue(encoder.encode(JSON.stringify(projected)+'\n'))
  }
  return new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,controller) {
      pending+=decoder.decode(chunk,{stream:true})
      for (;;) {const newline=pending.indexOf('\n');if(newline<0)break;const value=pending.slice(0,newline);pending=pending.slice(newline+1);line(value,controller)}
    },
    flush(controller) {pending+=decoder.decode();if(pending)line(pending,controller)},
  })
}
