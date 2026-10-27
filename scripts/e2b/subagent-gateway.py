"""Root-only capability gateway; no raw CDP listener, no protocol access logs.
Viewer capabilities only receive JPEG frames. Broker capabilities are minted by
the server for a specific owner/bot/subagent and may enter one guarded fill.
"""
import asyncio, base64, hashlib, hmac, json, os, secrets, time
from pathlib import Path
from aiohttp import web, WSMsgType
ROOT = Path('/run/mikka-subagents')
AGENTS = {}

def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))

def token(value, role=None):
    if not isinstance(value, str) or len(value)>4096: raise ValueError()
    payload, signature=value.split('.')
    expected=hmac.new((ROOT/'key').read_bytes(),payload.encode(),hashlib.sha256).digest()
    if not hmac.compare_digest(expected,decode(signature)): raise ValueError()
    grant=json.loads(decode(payload)); now=time.time()
    if not now<grant['exp']<=now+125 or (role and grant['role']!=role): raise ValueError()
    if grant['ownerId'] != (ROOT/'owner').read_text(): raise ValueError()
    return grant

def authorize(request, role=None):
    raw=request.query.get('token','')
    try:
        grant=token(raw,role)
        if grant['subagentId'] != request.match_info['id']: raise ValueError()
        return raw,grant
    except (ValueError,KeyError,TypeError,OSError): raise web.HTTPUnauthorized()

class Browser:
    def __init__(self, grant):
        self.grant=grant;self.pending={};self.seq=0;self.frame=None;self.guard=None
        self.session=None;self.target=None;self.lock=asyncio.Lock();self.viewer=set();self.stopped=False
        self.path=ROOT/grant['subagentId']; self.path.mkdir(mode=0o700,exist_ok=True)
        # Restart never silently unlocks a credential-bearing page.
        self.guard_file=self.path/'guard'
        if self.guard_file.exists(): self.guard='locked'
    async def start(self):
        self.process=await asyncio.create_subprocess_exec('node','/opt/mikka/computer/subagent-cdp.mjs',self.grant['subagentId'],stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
        for _ in range(100):
            try: self.reader,self.writer=await asyncio.open_unix_connection(str(self.path/'cdp.sock'),limit=4*1024*1024);break
            except (FileNotFoundError,ConnectionRefusedError): await asyncio.sleep(.1)
        else:raise RuntimeError()
        self.read_task=asyncio.create_task(self.read())
        targets=await self.rpc('Target.getTargets')
        self.target=next(t['targetId'] for t in targets['targetInfos'] if t['type']=='page')
        attached=await self.rpc('Target.attachToTarget',{'targetId':self.target,'flatten':True})
        self.session=attached['sessionId']
        await self.rpc('Page.enable',session=self.session)
        if not self.guard:await self.rpc('Page.startScreencast',{'format':'jpeg','quality':60,'maxWidth':1280,'maxHeight':800,'everyNthFrame':2},self.session)
    async def read(self):
        try:
            while line:=await self.reader.readline():
                message=json.loads(line)
                if 'id' in message:
                    future=self.pending.pop(message['id'],None)
                    if future and not future.done():future.set_result(message)
                elif message.get('method')=='Page.screencastFrame':
                    if not self.guard:self.frame=message['params']['data']
                    await self.send('Page.screencastFrameAck',{'sessionId':message['params']['sessionId']},self.session)
        finally:
            self.stopped=True;self.frame=None
            for future in self.pending.values():
                if not future.done():future.set_exception(RuntimeError())
    async def send(self,method,params=None,session=None):
        self.seq+=1; n=self.seq
        self.writer.write((json.dumps({'id':n,'method':method,'params':params or {},**({'sessionId':session} if session else {})})+'\n').encode());await self.writer.drain();return n
    async def rpc(self,method,params=None,session=None):
        # Register before yielding to reader.
        self.seq+=1;n=self.seq;future=asyncio.get_running_loop().create_future();self.pending[n]=future
        self.writer.write((json.dumps({'id':n,'method':method,'params':params or {},**({'sessionId':session} if session else {})})+'\n').encode());await self.writer.drain()
        try:
            answer=await asyncio.wait_for(future,15)
            if 'error'in answer:raise RuntimeError()
            return answer.get('result',{})
        finally:self.pending.pop(n,None)
    async def url(self):
        tree=await self.rpc('Page.getFrameTree',session=self.session);return tree['frameTree']['frame']['url']
    async def stop(self):
        self.stopped=True;self.frame=None
        for ws in list(self.viewer):await ws.close()
        self.process.terminate();await self.process.wait();self.read_task.cancel()

def browser(grant):
    b=AGENTS.get(grant['subagentId'])
    if not b or b.stopped or any(grant.get(k)!=b.grant.get(k) for k in ('ownerId','workspaceId','botId','epoch')):raise web.HTTPNotFound()
    return b

async def start(request):
    _,grant=authorize(request,'runtime')
    if grant['subagentId'] not in AGENTS:
        if sum(not b.stopped for b in AGENTS.values())>=6:raise web.HTTPServiceUnavailable()
        available=int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))
        if available<384*1024:raise web.HTTPServiceUnavailable()
        b=Browser(grant);AGENTS[grant['subagentId']]=b
        try:await b.start()
        except Exception:
            AGENTS.pop(grant['subagentId'],None)
            if getattr(b,'process',None) and b.process.returncode is None:b.process.terminate();await b.process.wait()
            raise web.HTTPServiceUnavailable()
    b=browser(grant)
    return web.json_response({'targetId':b.target,'url':await b.url(),'guarded':bool(b.guard)})

async def state(request):
    _,grant=authorize(request,'runtime');b=browser(grant)
    return web.json_response({'targetId':b.target,'url':None if b.guard else await b.url(),'guarded':bool(b.guard)})

async def stop(request):
    _,grant=authorize(request,'runtime');b=browser(grant);await b.stop();return web.json_response({'stopped':True})

async def viewer(request):
    raw,grant=authorize(request,'view');b=browser(grant)
    ws=web.WebSocketResponse(max_msg_size=1024);await ws.prepare(request);b.viewer.add(ws)
    try:
        while not ws.closed and not b.stopped:
            token(raw,'view')
            # Server-only send. Any input is ignored; viewers never get CDP.
            if not b.guard and b.frame:await ws.send_json({'type':'frame','data':b.frame})
            await asyncio.sleep(.25)
    except (ValueError,ConnectionError,RuntimeError):pass
    finally:b.viewer.discard(ws);await ws.close()
    return ws

async def begin(request):
    _,grant=authorize(request,'broker');b=browser(grant)
    async with b.lock:
        if b.guard:raise web.HTTPConflict()
        # Persist before any operation; a failure stays locked through restart.
        b.guard=secrets.token_urlsafe(32);b.guard_file.write_text(b.guard);b.frame=None
        await b.rpc('Page.stopScreencast',session=b.session)
        tree=await b.rpc('Page.getFrameTree',session=b.session)
        b.guard_loader=tree['frameTree']['frame']['loaderId']
        for ws in list(b.viewer):await ws.close()
    base=f'https://{request.host}'
    return web.json_response({'cdpUrl':base.replace('https:','wss:')+request.path.replace('/credentials/begin','/credentials/cdp')+'?token='+request.query['token']+'&guard='+b.guard,'targetId':b.target,'guardToken':b.guard})

async def cdp(request):
    raw,grant=authorize(request,'broker');b=browser(grant)
    guard=request.query.get('guard','')
    if not b.guard or not hmac.compare_digest(guard,b.guard):raise web.HTTPForbidden()
    ws=web.WebSocketResponse(max_msg_size=1024*1024);await ws.prepare(request)
    reader,writer=await asyncio.open_unix_connection(str(b.path/'cdp.sock'),limit=4*1024*1024)
    async def incoming():
        async for message in ws:
            token(raw,'broker')
            if b.guard!=guard or message.type!=WSMsgType.TEXT:break
            # Broker is a trusted deterministic service, never a model session.
            data=json.loads(message.data)
            writer.write((json.dumps(data)+'\n').encode());await writer.drain()
    async def outgoing():
        while line:=await reader.readline():
            token(raw,'broker')
            if b.guard!=guard:break
            await ws.send_str(line.decode().strip())
    async def expiry():
        await asyncio.sleep(max(0,grant['exp']-time.time()))
    tasks=[asyncio.create_task(f()) for f in (incoming,outgoing,expiry)]
    try:await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True);writer.close();await writer.wait_closed();await ws.close()
    return ws

async def end(request):
    _,grant=authorize(request,'broker');b=browser(grant);data=await request.json()
    async with b.lock:
        if not b.guard or not hmac.compare_digest(data.get('guardToken',''),b.guard):raise web.HTTPForbidden()
        check=await b.rpc('Runtime.evaluate',{'expression':"Array.from(document.querySelectorAll('input')).every(e => !e.value)",'returnByValue':True},b.session)
        tree=await b.rpc('Page.getFrameTree',session=b.session)
        if (not getattr(b,'guard_loader',None) or tree['frameTree']['frame']['loaderId']==b.guard_loader) and check.get('result',{}).get('value') is not True:raise web.HTTPConflict()
        # Clear the last frame so no buffered pre-fill frame races resumption.
        b.frame=None;await b.rpc('Page.startScreencast',{'format':'jpeg','quality':60,'maxWidth':1280,'maxHeight':800,'everyNthFrame':2},b.session)
        b.guard_file.unlink();b.guard=None
    return web.json_response({'resumed':True})

async def action(request):
    _,grant=authorize(request,'runtime');b=browser(grant);data=await request.json()
    async with b.lock:
        if b.guard:raise web.HTTPConflict()
        name=data.get('action')
        if name=='navigate':
            from urllib.parse import urlparse
            u=urlparse(data.get('url',''))
            if u.scheme not in ('https','http') or not u.hostname or u.username or u.password:raise web.HTTPBadRequest()
            await b.rpc('Page.navigate',{'url':data['url']},b.session)
        elif name=='observe':
            # Exclude all form values, cookies, storage and raw HTML.
            text=await b.rpc('Runtime.evaluate',{'expression':"JSON.stringify({url:location.href,title:document.title,links:Array.from(document.querySelectorAll('a')).slice(0,80).map(e=>({text:e.innerText.slice(0,160),href:e.href})),buttons:Array.from(document.querySelectorAll('button')).slice(0,80).map(e=>e.innerText.slice(0,160)),needsLogin:!!document.querySelector('input[type=password]')})",'returnByValue':True},b.session)
            return web.json_response({'observation':json.loads(text['result']['value'])})
        elif name=='click':
            # Selector comes from the bot; irreversible actions still require approval in its harness.
            selector=json.dumps(str(data.get('selector',''))[:500])
            await b.rpc('Runtime.evaluate',{'expression':f'document.querySelector({selector})?.click()'},b.session)
        else:raise web.HTTPBadRequest()
        return web.json_response({'accepted':True})

app=web.Application(client_max_size=16384)
for suffix,handler,method in [('/start',start,'POST'),('/state',state,'GET'),('/stop',stop,'POST'),('/viewer',viewer,'GET'),('/action',action,'POST'),('/credentials/begin',begin,'POST'),('/credentials/cdp',cdp,'GET'),('/credentials/end',end,'POST')]:app.router.add_route(method,'/agents/{id}'+suffix,handler)
if __name__=='__main__':web.run_app(app,host='0.0.0.0',port=6082,access_log=None,print=None)
