import http from 'node:http'
import fs from 'node:fs'
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto'
import {getLlama,LlamaChatSession} from 'node-llama-cpp'
const id='SmolLM2-135M-Instruct-Q4_K_M'
const key=Buffer.from('Bearer '+process.env.E_LOCAL_MODEL_TEST_KEY)
if(key.length<35) throw new Error('missing generated loopback identity')
const root=process.env.E_LOCAL_MODEL_QA_DIR
const llama=await getLlama({gpu:false,build:'never',skipDownload:true})
const model=await llama.loadModel({modelPath:process.env.E_WEIGHT_FILE})
const ctx=await model.createContext({contextSize:768,threads:2})
const seq=ctx.getSequence()
const grammar=await llama.createGrammarForJsonSchema({type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false})
const server=http.createServer(async(req,res)=>{
 const json=(code,body)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body))}
 if(req.socket.remoteAddress!=='127.0.0.1')return json(403,{error:'loopback'})
 if(req.method==='GET'&&req.url==='/health')return json(200,{model:id})
 const supplied=Buffer.from(req.headers.authorization??'')
 if(supplied.length!==key.length||!timingSafeEqual(supplied,key))return json(401,{error:'unauthorized'})
 if(req.method!=='POST'||req.url!=='/v1/chat/completions')return json(404,{error:'unknown route'})
 try{
  let input='';for await(const c of req){input+=c;if(input.length>16000)throw Error('bad request')}
  const data=JSON.parse(input);if(data.model!==id||data.stream===true)throw Error('unsupported model or transport')
  const system=data.messages.find(m=>m.role==='system')?.content
  const user=data.messages.find(m=>m.role==='user')?.content
  if(typeof system!=='string'||typeof user!=='string'||!JSON.parse(user).task?.title)throw Error('outside synthetic input scope')
  const begin=Date.now();fs.appendFileSync(root+'/provider-starts.jsonl',JSON.stringify({started:new Date(begin).toISOString(),promptDigest:createHash('sha256').update(user).digest('hex')})+'\n',{mode:0o600});await seq.clearHistory();const session=new LlamaChatSession({contextSequence:seq,systemPrompt:system})
  const response=await session.prompt(user,{maxTokens:48,temperature:0,grammar})
  const promptTokens=model.tokenize(system+'\n'+user).length;const outputTokens=model.tokenize(response).length
  const receipt={started:new Date(begin).toISOString(),ended:new Date().toISOString(),model:id,weightSha256:'2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d',llamaCpp:'node-llama-cpp@3.22.3, llama.cpp v0.9.0, CPU',network:'AF_INET loopback only',syntheticTask:JSON.parse(user).task,promptDigest:createHash('sha256').update(user).digest('hex'),serverDecoding:"llama.cpp JSON Schema top-level title string; title characters chosen by the model",output:response,outputTokens}
  fs.appendFileSync(root+'/inference.jsonl',JSON.stringify(receipt)+'\n',{mode:0o600})
  json(200,{id:'chatcmpl-'+randomUUID(),object:'chat.completion',created:Math.floor(begin/1000),model:id,choices:[{index:0,message:{role:'assistant',content:response},finish_reason:'stop'}],usage:{prompt_tokens:promptTokens,completion_tokens:outputTokens,total_tokens:promptTokens+outputTokens}})
 }catch(e){console.error(e.name,String(e.message).slice(0,85));json(500,{error:'local inference failed'})}
})
server.listen(3837,'127.0.0.1',()=>console.log('Real CPU model initialized and bound on loopback'))
