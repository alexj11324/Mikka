import {expect,it,vi} from 'vitest'
import {runGroupReviewBatch,type GroupReviewAssignment,type GroupReviewLink} from '../src/runs/group-review-worker'
const claim:GroupReviewAssignment={status:'claimed',harness:'codex',runId:'run',claimEpoch:1,envelope:{contract:'mikka.group-review.v1',workId:'run',triggerMessageId:'trigger',conversationId:'group',instruction:'trusted contract',untrustedData:{}},capabilities:{tools:[],history:[],repository:null,credentials:null}}
function link(value=claim):GroupReviewLink{return{poll:async()=>({runIds:['run']}),claim:async()=>value,check:async()=>({live:true}),complete:vi.fn(async()=>({status:'completed'}))}}
it('refuses a privileged assignment before invoking any processor',async()=>{
 const processor=vi.fn();await expect(runGroupReviewBatch(link({...claim,capabilities:{...claim.capabilities,tools:['shell']}}),processor)).rejects.toThrow('Unsafe group assignment');expect(processor).not.toHaveBeenCalled()
})
it('does not compute after pre-execution authorization was revoked',async()=>{
 const transport=link(),processor=vi.fn();transport.check=async()=>({live:false});await expect(runGroupReviewBatch(transport,processor)).resolves.toEqual([]);expect(processor).not.toHaveBeenCalled()
})
it('host shutdown aborts a processor that never returns without committing output',async()=>{
 const transport=link(),controller=new AbortController()
 await expect(runGroupReviewBatch(transport,async()=>{queueMicrotask(()=>controller.abort());return new Promise(()=>{})},controller.signal)).rejects.toThrow('stopped')
 expect(transport.complete).not.toHaveBeenCalled()
})
