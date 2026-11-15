import {createServer} from 'node:https'
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto'
import {readFileSync,appendFileSync} from 'node:fs'
import {getLlama,LlamaChatSession} from 'node-llama-cpp'
const work=process.env.E_CODEX_QA
const modelId='SmolLM2-135M-Instruct-Q4_K_M'
const auth=Buffer.from('Bearer '+process.env.E_LOOPBACK_KEY)
const receipt=(file,v)=>appendFileSync(work+'/'+file,JSON.stringify({at:new Date().toISOString(),...v})+'\n',{mode:0o600})
const llama=await getLlama({gpu:false,build:'never',skipDownload:true})
const model=await llama.loadModel({modelPath:process.env.E_WEIGHT_FILE})
const context=await model.createContext({contextSize:1024,threads:1})
const seq=context.getSequence()
const h=x=>createHash('sha256').update(x).digest('hex')
const server=createServer({key:readFileSync(work+'/endpoint.key'),cert:readFileSync(work+'/endpoint.pem'),minVersion:'TLSv1.2'},async(req,res)=>{
 const raw=Buffer.from(req.headers.authorization??'');const reject=(code)=>{res.writeHead(code);res.end()}
 if(req.socket.remoteAddress!=='127.0.0.1') return reject(403)
 if(req.method==='GET'&&req.url==='/health'){res.writeHead(200);return res.end('ready')}
 if(raw.length!==auth.length||!timingSafeEqual(raw,auth))return reject(401)
 if(req.method!=='POST'||req.url!=='/v1/responses'){receipt('routes.jsonl',{path:req.url?.split('?')[0],method:req.method});return reject(404)}
 let input='';for await(const ch of req){input+=ch;if(input.length>500000)return reject(413)}
 let body;try{body=JSON.parse(input)}catch{return reject(400)}
 const items=Array.isArray(body.input)?body.input:[];const texts=items.filter(v=>v.role==='user').flatMap(v=>typeof v.content==='string'?[v.content]:v.content?.map(p=>p.text??'')??[])
 const prompts=texts.flatMap(v=>[...v.matchAll(/E2262_QA_BEGIN ([^\n]{1,340}?) E2262_QA_END/g)].map(m=>m[1]));const prompt=prompts.at(-1)
 receipt('requests.jsonl',{model:body.model,stream:body.stream,userPromptHashes:prompts.map(h),wireBodySha:h(input),toolsAdvertised:body.tools?.length??0,authenticated:true,tls:req.socket.getProtocol(),accepted:Boolean(prompt)})
 if(!prompt||body.model!==modelId||body.stream!==true)return reject(400)
 const tools=(body.tools??[]).flatMap(entry=>entry.type==='namespace'?(entry.tools??[]).map(t=>({name:t.name,namespace:entry.name})):entry.name?[{name:entry.name}]:[])
 const found=tools.filter(t=>t.name==='submit'||/mikka__submit$/.test(t.name))
 if(prompt.startsWith('The user wants the finished report delivered.')){
  const resultSeen=items.some(i=>i.type==='function_call_output'||i.type==='mcp_call')
  receipt('tools.jsonl',{offered:tools.map(t=>[t.namespace??null,t.name]),selectedSubmit:found,toolResultPresent:resultSeen})
  if(!resultSeen&&found.length===1){
   try{
    await seq.clearHistory()
    const grammar=await llama.createGrammarForJsonSchema({type:'object',properties:{action:{enum:['answer','submit']},summary:{type:'string',maxLength:140}},required:['action','summary'],additionalProperties:false})
    const session=new LlamaChatSession({contextSequence:seq,systemPrompt:'Select one action for the human request. Your JSON has action and summary. To submit a final report, action is submit. To send a chat answer, action is answer.'})
    const generated=await session.prompt(prompt,{temperature:0,maxTokens:90,grammar})
    const decision=JSON.parse(generated)
    receipt('decisions.jsonl',{model:modelId,prompt,generated,generatedTokens:model.tokenize(generated).length})
    if(decision.action==='submit'){
     const t=found[0],rid='resp_'+randomUUID().replaceAll('-',''),cid='call_'+randomUUID().replaceAll('-',''),fid='fc_'+randomUUID().replaceAll('-','')
     let n=0;const event=(type,fields)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:n++,...fields})+'\n\n')
     const base={id:rid,object:'response',model:modelId,created_at:Math.floor(Date.now()/1000)}
     const start={type:'function_call',id:fid,call_id:cid,name:t.name,...(t.namespace?{namespace:t.namespace}:{}),arguments:'',status:'in_progress'}
     const args=JSON.stringify({summary:decision.summary}),done={...start,arguments:args,status:'completed'}
     res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'})
     event('response.created',{response:{...base,status:'in_progress',output:[]}})
     event('response.output_item.added',{output_index:0,item:start})
     event('response.function_call_arguments.delta',{output_index:0,item_id:fid,delta:args})
     event('response.function_call_arguments.done',{output_index:0,item_id:fid,name:t.name,arguments:args})
     event('response.output_item.done',{output_index:0,item:done})
     event('response.completed',{response:{...base,status:'completed',output:[done],usage:{input_tokens:model.tokenize(prompt).length,output_tokens:model.tokenize(generated).length}}})
     res.end();return
    }
   }catch(error){receipt('provider-ends.jsonl',{stage:'structured decision',error:error.name});return reject(500)}
  }
 }
 const responseId='resp_'+randomUUID().replaceAll('-',''),itemId='msg_'+randomUUID().replaceAll('-',''),base={id:responseId,created_at:Math.floor(Date.now()/1000),model:modelId,object:'response'}
 let n=0,output=''
 const emit=(type,props)=>{if(!res.destroyed&&!res.writableEnded)res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:n++,...props})+'\n\n')}
 const item={type:'message',id:itemId,role:'assistant',status:'in_progress',content:[]}
 const abort=new AbortController()
 res.on('close',()=>{if(!res.writableEnded)abort.abort()})
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'})
 emit('response.created',{response:{...base,status:'in_progress',output:[]}})
 emit('response.output_item.added',{output_index:0,item})
 emit('response.content_part.added',{item_id:itemId,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}})
 try{
  await seq.clearHistory()
  const system='Answer this harmless English test request in plain text. Do not call any tools.'
  const session=new LlamaChatSession({contextSequence:seq,systemPrompt:system})
  const result=await session.prompt(prompt,{temperature:0,maxTokens:64,signal:abort.signal,onTextChunk:delta=>{
   if(!output)receipt('first-token.jsonl',{responseId,task:prompt,outputChunkSha:h(delta)})
   output+=delta
   // Keep the first model response streaming long enough for the database and
   // authenticated RPC round trip. Token text is always produced by the GGUF.
   if(prompt.startsWith('List twenty vegetables')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,125)
   emit('response.output_text.delta',{item_id:itemId,output_index:0,content_index:0,delta})
  }})
  if(result!==output)throw Error('Different streamed and final GGUF output')
  const part={type:'output_text',text:result,annotations:[]};const done={...item,status:'completed',content:[part]}
  emit('response.output_text.done',{item_id:itemId,output_index:0,content_index:0,text:result})
  emit('response.content_part.done',{item_id:itemId,output_index:0,content_index:0,part})
  emit('response.output_item.done',{output_index:0,item:done})
  const inp=model.tokenize(system+'\n'+prompt).length,out=model.tokenize(result).length
  receipt('results.jsonl',{responseId,prompt,result,inputTokens:inp,outputTokens:out})
  emit('response.completed',{response:{...base,status:'completed',output:[done],usage:{input_tokens:inp,output_tokens:out,total_tokens:inp+out}}})
  res.end()
 }catch(error){receipt('provider-ends.jsonl',{responseId,aborted:abort.signal.aborted,error:error.name,textBytes:Buffer.byteLength(output)});if(!res.destroyed)res.end()}
})
server.listen(3857,'127.0.0.1')
