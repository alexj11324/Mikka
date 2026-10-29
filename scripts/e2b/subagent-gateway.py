"""Root-only capability gateway; no raw CDP listener, no protocol access logs.
Viewer capabilities only receive JPEG frames. Broker capabilities are minted by
the server for a specific owner/bot/subagent and may enter one guarded fill.
"""
import asyncio, base64, fcntl, hashlib, hmac, json, math, os, secrets, time
from pathlib import Path
from urllib.parse import urlsplit
from aiohttp import web, WSMsgType
ROOT = Path('/run/mikka-subagents')
AGENTS = {}
BROKER_METHODS = frozenset(('Page.getFrameTree', 'DOM.getDocument', 'DOM.focus', 'DOM.describeNode', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Input.insertText', 'Network.setCookies', 'Network.getCookies', 'Page.reload'))
BROKER_STORAGE_FUNCTION = 'function(entries){localStorage.clear();for(const [k,v] of entries)localStorage.setItem(k,v)}'
BROKER_OTP_SELECTOR = 'input[autocomplete="one-time-code"],input[name="code"],input[name="otp"]'
BROKER_FOCUS_SELECTORS = ('input[autocomplete="username"],input[type="email"],input[name="username"]', 'input[type="password"]')
BROKER_FOCUS_EXPRESSIONS = {
    **{f'(()=>{{const e=document.querySelector({json.dumps(selector)});if(!e||e.disabled||e.readOnly)return false;e.focus();e.value=\'\';return document.activeElement===e}})()':selector for selector in BROKER_FOCUS_SELECTORS},
    f'''(()=>{{const e=document.querySelector('{BROKER_OTP_SELECTOR}');if(!e||e.disabled||e.readOnly)return false;e.focus();e.value='';return document.activeElement===e}})()''':BROKER_OTP_SELECTOR,
}
BROKER_EVALUATIONS = frozenset((
    *BROKER_FOCUS_EXPRESSIONS,
    '''(()=>{const e=document.querySelector('input[type="password"]');if(!e?.form)return false;e.form.requestSubmit();return true})()''',
    f'''(()=>{{const e=document.querySelector('{BROKER_OTP_SELECTOR}');if(!e?.form)return false;e.form.requestSubmit();return true}})()''',
    '''document.readyState==='complete'&&!document.querySelector('input[type="password"]')''',
    "![...document.querySelectorAll('input,textarea')].some(e=>e.value && (e.tagName==='TEXTAREA'||!['hidden','checkbox','radio','button','submit','reset','image','file','range','color'].includes(e.type)))",
    f'''Boolean([...document.querySelectorAll('{BROKER_OTP_SELECTOR}')].find(e=>!e.disabled&&e.getClientRects().length))''',
    'Object.entries(localStorage)',
))
# Capture the loaded files at process startup, not on each request: replacing
# files on disk does not change an already-running Python gateway.
VERSION = hashlib.sha256(Path(__file__).read_bytes() + Path(__file__).with_name('subagent-cdp.mjs').read_bytes()).hexdigest()

# A site need not label an OTP field with autocomplete. Keep the guarded
# session closed while any text entry remains populated, including OTP fields
# with arbitrary names. Hidden and non-text controls commonly have fixed values.
SAFE_TO_RESUME = """(() => {
  const fields = Array.from(document.querySelectorAll('input,textarea'));
  return !fields.some(e => e.value && (e.tagName === 'TEXTAREA' ||
    !['hidden','checkbox','radio','button','submit','reset','image','file','range','color'].includes(e.type)));
})()"""
SENSITIVE_FIELD = "(e.type === 'password' || /(?:otp|one[\\s_-]*time|verification[\\s_-]*code|security[\\s_-]*code|auth(?:entication)?[\\s_-]*code)/i.test([e.autocomplete,e.name,e.id,e.getAttribute('aria-label'),e.getAttribute('placeholder')].join(' ')))"

def safe_resume_snapshot(frames, document, evaluation):
    """Fail closed when CDP cannot inspect the whole credential-bearing page.

    Nested documents and shadow trees need their own execution contexts; until
    those are fenced, never infer that a top-level empty form is safe to show.
    """
    frame=frames.get('frameTree') if isinstance(frames,dict) else None
    root=document.get('root') if isinstance(document,dict) else None
    if not isinstance(frame,dict) or not isinstance(frame.get('frame'),dict) or not frame['frame'].get('id') or not isinstance(root,dict) or root.get('nodeName') != '#document' or frame.get('childFrames'):return False
    def unsafe(value):
        if isinstance(value,list):return any(unsafe(item) for item in value)
        if not isinstance(value,dict):return False
        if str(value.get('nodeName','')).upper() in ('IFRAME','FRAME'):return True
        # Chromium exposes native input internals as user-agent shadow trees;
        # their value is already checked on the host input. Author-created
        # open and closed trees cannot be inspected by the top-level evaluator.
        if any(root.get('shadowRootType') != 'user-agent' for root in value.get('shadowRoots',[]) if isinstance(root,dict)):return True
        if any(not isinstance(root,dict) for root in value.get('shadowRoots',[])):return True
        return any(unsafe(item) for item in value.values())
    return not unsafe(root) and isinstance(evaluation,dict) and 'exceptionDetails' not in evaluation and isinstance(evaluation.get('result'),dict) and evaluation['result'].get('value') is True

def inspect_mutation_expression(mutation):
    # Text and form metadata are hints, not a proof of a page's JS effects.
    selector=json.dumps(str(mutation.get('selector',''))[:500])
    return f"(() => {{ const e={('document.activeElement' if mutation.get('action')=='key' else 'document.querySelector('+selector+')')}; if (!e) return {{requiresApproval:true}}; const text=(e.innerText||e.getAttribute('aria-label')||'').slice(0,500); const risk=/pay|purchase|buy|delete|remove|cancel|unsubscribe|transfer|send|publish|submit|confirm|付款|支付|购买|删除|取消|转账|发送|发布|确认/i.test(text); return {{requiresApproval:risk || (e.type==='submit' && e.form?.method.toLowerCase()!=='get') || ({json.dumps(mutation.get('action')=='key' and mutation.get('key')=='Enter')} && e.form?.method.toLowerCase()!=='get')}}; }})()"

def browser_origin(value):
    try:
        parsed=urlsplit(value)
        if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.hostname.endswith('.') or parsed.username or parsed.password:return None
        # External credential origins require HTTPS. Loopback HTTP is reserved
        # for the isolated synthetic gateway fixture; the broker API itself
        # accepts only HTTPS credential origins.
        if parsed.scheme=='http' and parsed.hostname not in ('127.0.0.1','localhost','::1'):return None
        host=parsed.hostname.lower();host=f'[{host}]' if ':' in host else host
        port=parsed.port
        if port==0:return None
        return f'{parsed.scheme}://{host}'+(f':{port}' if port and port != (443 if parsed.scheme=='https' else 80) else '')
    except (ValueError,TypeError):return None

def broker_command_allowed(data, target, sessions, objects=None, origin=None):
    if not isinstance(data,dict) or type(data.get('id')) is not int or data['id'] < 1 or not isinstance(data.get('params'),dict):return False
    objects=objects or {}
    method=data.get('method')
    if method=='Target.attachToTarget':
        return set(data)=={'id','method','params'} and not sessions and data['params']=={'targetId':target,'flatten':True}
    if set(data)!={'id','method','params','sessionId'} or not isinstance(method,str) or method not in BROKER_METHODS or not isinstance(data.get('sessionId'),str) or data['sessionId'] not in sessions:return False
    params=data['params']
    if method in ('Page.getFrameTree','Page.reload'):return params=={}
    if method=='DOM.getDocument':return params in ({'depth':-1,'pierce':True},{'depth':-1,'pierce':False})
    if method=='DOM.focus':return set(params)=={'backendNodeId'} and type(params['backendNodeId']) is int and params['backendNodeId']>0
    if method=='DOM.describeNode':return set(params)=={'objectId'} and params['objectId']==objects.get('active:'+data['sessionId'])
    if method=='Runtime.evaluate':
        return set(params)=={'expression','returnByValue'} and isinstance(params['expression'],str) and ((params['expression'] in (BROKER_EVALUATIONS - set(BROKER_FOCUS_EXPRESSIONS) - {e for e in BROKER_EVALUATIONS if 'requestSubmit' in e}) and params['returnByValue'] is True) or (params['expression'] in ('globalThis','document.activeElement') and params['returnByValue'] is False))
    if method=='Runtime.callFunctionOn':
        args=params.get('arguments')
        return set(params)=={'objectId','functionDeclaration','arguments','returnByValue'} and isinstance(params['objectId'],str) and bool(params['objectId']) and params['objectId']==objects.get(data['sessionId']) and params['functionDeclaration']==BROKER_STORAGE_FUNCTION and params['returnByValue'] is True and isinstance(args,list) and len(args)==1 and isinstance(args[0],dict) and set(args[0])=={'value'} and isinstance(args[0]['value'],list) and all(isinstance(item,list) and len(item)==2 and all(isinstance(part,str) for part in item) for item in args[0]['value'])
    if method=='Input.insertText':return set(params)=={'text'} and isinstance(params['text'],str) and 0<len(params['text'])<=4096 and not any(char in params['text'] for char in '\r\n\0')
    if method=='Network.getCookies':return bool(origin) and set(params)=={'urls'} and params['urls']==[origin]
    if method=='Network.setCookies':
        if not origin or set(params)!={'cookies'} or not isinstance(params['cookies'],list) or len(params['cookies'])>500:return False
        host=urlsplit(origin).hostname
        keys={'name','value','domain','path','expires','size','httpOnly','secure','session','sameSite','priority','sameParty','sourceScheme','sourcePort','partitionKey'}
        for item in params['cookies']:
            if not isinstance(item,dict) or not set(item)<=keys or not isinstance(item.get('name'),str) or not isinstance(item.get('value'),str) or not isinstance(item.get('domain'),str):return False
            if not item['name'] or any(len(item[key])>4096 or any(char in item[key] for char in '\r\n\0') for key in ('name','value','domain')):return False
            domain=item['domain'].lstrip('.').lower()
            if not domain or not host or not (host==domain or host.endswith('.'+domain)):return False
            if 'path' in item and (not isinstance(item['path'],str) or not item['path'].startswith('/') or any(char in item['path'] for char in '\r\n\0')):return False
            if any(key in item and type(item[key]) is not bool for key in ('httpOnly','secure','session','sameParty')):return False
            if 'expires' in item and (type(item['expires']) not in (int,float) or not math.isfinite(item['expires'])):return False
            if 'size' in item and (type(item['size']) is not int or item['size']<0):return False
            if 'sourcePort' in item and (type(item['sourcePort']) is not int or not -1<=item['sourcePort']<=65535):return False
            if 'sameSite' in item and item['sameSite'] not in ('Strict','Lax','None'):return False
            if 'priority' in item and item['priority'] not in ('Low','Medium','High'):return False
            if 'sourceScheme' in item and item['sourceScheme'] not in ('Unset','NonSecure','Secure'):return False
            if 'partitionKey' in item:
                key=item['partitionKey']
                if not isinstance(key,dict) or not {'topLevelSite'}<=set(key) or not set(key)<={'topLevelSite','hasCrossSiteAncestor'} or not isinstance(key['topLevelSite'],str):return False
                if 'hasCrossSiteAncestor' in key and type(key['hasCrossSiteAncestor']) is not bool:return False
                site=browser_origin(key['topLevelSite'])
                if not site:return False
                parsed=urlsplit(key['topLevelSite']);site_parts=urlsplit(site)
                if parsed.path not in ('','/') or parsed.query or parsed.fragment or site_parts.scheme!=urlsplit(origin).scheme:return False
                site_host=site_parts.hostname
                if not site_host or not (host==site_host or host.endswith('.'+site_host)):return False
        return True
    return False

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
        self.process=await asyncio.create_subprocess_exec('node','/opt/mikka/computer/subagent-cdp.mjs',self.grant['subagentId'],*([str(self.grant['display'])] if self.grant.get('display') else []),stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
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
    if not b or b.stopped or any(grant.get(k)!=b.grant.get(k) for k in ('ownerId','workspaceId','botId','epoch','display')):raise web.HTTPNotFound()
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
    _,grant=authorize(request,'runtime')
    b=AGENTS.get(grant['subagentId'])
    if b and not b.stopped:
        b=browser(grant);await b.stop()
    return web.json_response({'stopped':True})

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
        b.guard=secrets.token_urlsafe(32);b.guard_file.write_text(b.guard);b.frame=None
        display=b.grant.get('display')
        if display:
            state=Path('/run/mikka-viewer')
            if (state/'guard-protocol').read_text()!='1':raise web.HTTPServiceUnavailable()
            # Same lock used by #161's trusted CUA lease-driver. Wait for an
            # in-flight operation, then exclude screenshots and input until end.
            b.driver_lock=open(state/f'{display}.lock','a')
            deadline=time.time()+20
            while True:
                try:fcntl.flock(b.driver_lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
                except BlockingIOError:
                    if time.time()>deadline:b.driver_lock.close();raise web.HTTPServiceUnavailable()
                    await asyncio.sleep(.05)
            (state/f'{display}.guard').write_text('credentials')
            # VNC acknowledges every pre-existing viewer has closed. New ones
            # are rejected by the marker before a frame can be sent.
            while (state/f'{display}-viewers').exists() and int((state/f'{display}-viewers').read_text())>0:
                if time.time()>deadline:raise web.HTTPServiceUnavailable()
                await asyncio.sleep(.05)
        # A failure keeps the persisted guard closed through restart.
        await b.rpc('Page.stopScreencast',session=b.session)
        tree=await b.rpc('Page.getFrameTree',session=b.session)
        b.guard_loader=tree['frameTree']['frame']['loaderId']
        b.guard_origin=browser_origin(tree['frameTree']['frame']['url'])
        document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
        if not b.guard_origin or not safe_resume_snapshot(tree,document,{'result':{'value':True}}):raise web.HTTPConflict()
        for ws in list(b.viewer):await ws.close()
    base=f'https://{request.host}'
    return web.json_response({'cdpUrl':base.replace('https:','wss:')+request.path.replace('/credentials/begin','/credentials/cdp')+'?token='+request.query['token']+'&guard='+b.guard,'targetId':b.target,'guardToken':b.guard})

async def cdp(request):
    raw,grant=authorize(request,'broker');b=browser(grant)
    guard=request.query.get('guard','')
    if not b.guard or not hmac.compare_digest(guard,b.guard):raise web.HTTPForbidden()
    ws=web.WebSocketResponse(max_msg_size=1024*1024);await ws.prepare(request)
    reader,writer=await asyncio.open_unix_connection(str(b.path/'cdp.sock'),limit=4*1024*1024)
    sessions=set();pending={};objects={};focused={};origin=getattr(b,'guard_origin',None)
    if not origin:
        writer.close();await writer.wait_closed();await ws.close();return ws
    async def incoming():
        async for message in ws:
            token(raw,'broker')
            if b.guard!=guard or message.type!=WSMsgType.TEXT:break
            data=json.loads(message.data)
            # Broker capability is scoped to this page, not a general CDP socket.
            if not broker_command_allowed(data,b.target,sessions,objects,origin) or data['id'] in pending:break
            if data['method']!='Target.attachToTarget' and browser_origin(await b.url())!=origin:break
            if data['method']=='Target.attachToTarget' and any(item[0]=='Target.attachToTarget' for item in pending.values()):break
            if data['method']=='DOM.focus':
                node=data['params']['backendNodeId']
                if node not in {item['backendNodeId'] for item in getattr(b,'credential_nodes',[])}:break
                tree=await b.rpc('Page.getFrameTree',session=b.session)
                if tree['frameTree']['frame']['loaderId']!=getattr(b,'credential_loader',None):break
                focused[data['sessionId']]=node
            if data['method']=='Runtime.callFunctionOn':objects.pop(data['sessionId'],None)
            if data['method']=='Page.reload':objects.pop(data['sessionId'],None);focused.pop(data['sessionId'],None)
            if data['method']=='Runtime.evaluate' and data['params'].get('expression')!='document.activeElement':focused.pop(data['sessionId'],None)
            if data['method']=='Input.insertText':
                node=focused.pop(data['sessionId'],None)
                if not node:break
                tree=await b.rpc('Page.getFrameTree',session=b.session)
                if tree['frameTree']['frame']['loaderId']!=getattr(b,'credential_loader',None):break
                document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
                if not safe_resume_snapshot(tree,document,{'result':{'value':True}}):break
                active=await b.rpc('Runtime.evaluate',{'expression':'document.activeElement','returnByValue':False},b.session)
                obj=active.get('result',{}).get('objectId')
                check=await b.rpc('DOM.describeNode',{'objectId':obj},b.session) if obj else {}
                if check.get('node',{}).get('backendNodeId')!=node or browser_origin(await b.url())!=origin:break
            pending[data['id']]=(data['method'],data.get('sessionId'),data.get('params',{}).get('expression'))
            writer.write((json.dumps(data)+'\n').encode());await writer.drain()
    async def outgoing():
        while line:=await reader.readline():
            token(raw,'broker')
            if b.guard!=guard:break
            data=json.loads(line)
            if data.get('method')=='Target.detachedFromTarget':
                detached=data.get('params',{}).get('sessionId')
                sessions.discard(detached);objects.pop(detached,None);focused.pop(detached,None)
            if data.get('method')=='Page.frameNavigated':
                frame=data.get('params',{}).get('frame',{})
                if not frame.get('parentId') and browser_origin(frame.get('url'))!=origin:break
            call=pending.pop(data.get('id'),None)
            if call and call[0]=='Target.attachToTarget':
                session=data.get('result',{}).get('sessionId')
                if isinstance(session,str) and session:sessions.add(session)
            if call and call[0]=='Runtime.evaluate' and call[2]=='document.activeElement':
                object_id=data.get('result',{}).get('result',{}).get('objectId')
                if isinstance(object_id,str) and object_id:objects['active:'+call[1]]=object_id
            if call and call[0]=='Runtime.evaluate' and call[2]=='globalThis':
                object_id=data.get('result',{}).get('result',{}).get('objectId')
                if isinstance(object_id,str) and object_id:objects[call[1]]=object_id
            if call and call[0]=='Runtime.evaluate' and call[2] in BROKER_FOCUS_EXPRESSIONS and data.get('result',{}).get('result',{}).get('value') is True:
                focused[call[1]]=BROKER_FOCUS_EXPRESSIONS[call[2]]
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
        try:
            tree=await b.rpc('Page.getFrameTree',session=b.session)
            document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
            check=await b.rpc('Runtime.evaluate',{'expression':SAFE_TO_RESUME,'returnByValue':True},b.session)
            safe=browser_origin(tree['frameTree']['frame']['url'])==b.guard_origin and safe_resume_snapshot(tree,document,check)
        except Exception:
            safe=False
        if not safe:raise web.HTTPConflict()
        # Clear the last frame so no buffered pre-fill frame races resumption.
        b.frame=None;await b.rpc('Page.startScreencast',{'format':'jpeg','quality':60,'maxWidth':1280,'maxHeight':800,'everyNthFrame':2},b.session)
        b.guard_file.unlink();b.guard=None
        if b.grant.get('display'):
            (Path('/run/mikka-viewer')/f"{b.grant['display']}.guard").unlink()
            fcntl.flock(b.driver_lock,fcntl.LOCK_UN);b.driver_lock.close()
    return web.json_response({'resumed':True})

async def action(request):
    _,grant=authorize(request,'runtime');b=browser(grant);data=await request.json()
    async with b.lock:
        if b.guard:raise web.HTTPConflict()
        name=data.get('action')
        if data.get('expectedLoaderId'):
            from urllib.parse import urlsplit
            tree=await b.rpc('Page.getFrameTree',session=b.session)
            frame=tree['frameTree']['frame'];u=urlsplit(frame['url'])
            if frame['loaderId']!=data['expectedLoaderId'] or f'{u.scheme}://{u.netloc}'!=data.get('expectedOrigin'):raise web.HTTPConflict()
        if name=='inspectMutation':
            from urllib.parse import urlsplit
            mutation=data.get('mutation',{})
            expression=inspect_mutation_expression(mutation)
            check=await b.rpc('Runtime.evaluate',{'expression':expression,'returnByValue':True},b.session)
            tree=await b.rpc('Page.getFrameTree',session=b.session);frame=tree['frameTree']['frame'];u=urlsplit(frame['url'])
            return web.json_response({**check['result']['value'],'loaderId':frame['loaderId'],'origin':f'{u.scheme}://{u.netloc}'})
        if name=='navigate':
            from urllib.parse import urlparse
            u=urlparse(data.get('url',''))
            if u.scheme not in ('https','http') or not u.hostname or u.username or u.password:raise web.HTTPBadRequest()
            await b.rpc('Page.navigate',{'url':data['url']},b.session)
        elif name=='observe':
            # Exclude all form values, cookies, storage and raw HTML.
            text=await b.rpc('Runtime.evaluate',{'expression':'(() => { const copy=document.body.cloneNode(true); copy.querySelectorAll(\'input,textarea,select,script,style,noscript\').forEach(e=>e.remove()); const elements=Array.from(document.querySelectorAll(\'a,button,input,textarea,select\')).slice(0,150).map((e,i)=>{e.setAttribute(\'data-mikka-ref\',String(i));return {selector:\'[data-mikka-ref=\\"\'+i+\'\\"]\',tag:e.tagName,type:e.type||null,text:[\'INPUT\',\'TEXTAREA\',\'SELECT\'].includes(e.tagName)?null:e.innerText.slice(0,200),label:e.getAttribute(\'aria-label\')||e.getAttribute(\'placeholder\'),href:e.tagName===\'A\'?e.href:null}});return JSON.stringify({url:location.origin+location.pathname,title:document.title,text:(copy.innerText||copy.textContent||\'\').slice(0,16000),elements,needsLogin:Array.from(document.querySelectorAll(\'input[type=password]\')).some(e=>e.getClientRects().length>0)})})()','returnByValue':True},b.session)
            return web.json_response({'observation':json.loads(text['result']['value'])})
        elif name=='type':
            selector=json.dumps(str(data.get('selector',''))[:500])
            expression=f"(() => {{ const e=document.querySelector({selector}); if (!e || {SENSITIVE_FIELD} || !['INPUT','TEXTAREA'].includes(e.tagName)) return false; e.focus(); return true; }})()"
            focused=await b.rpc('Runtime.evaluate',{'expression':expression,'returnByValue':True},b.session)
            if focused.get('result',{}).get('value') is not True:raise web.HTTPForbidden()
            await b.rpc('Input.insertText',{'text':str(data.get('text',''))[:2000]},b.session)
        elif name=='key':
            key=data.get('key')
            if key not in ('Enter','Tab','Escape','ArrowDown','ArrowUp'):raise web.HTTPBadRequest()
            await b.rpc('Input.dispatchKeyEvent',{'type':'keyDown','key':key},b.session)
            await b.rpc('Input.dispatchKeyEvent',{'type':'keyUp','key':key},b.session)
        elif name=='click':
            # The calling harness applies model and metadata-based approval checks.
            selector=json.dumps(str(data.get('selector',''))[:500])
            await b.rpc('Runtime.evaluate',{'expression':f'document.querySelector({selector})?.click()'},b.session)
        else:raise web.HTTPBadRequest()
        return web.json_response({'accepted':True})

# No selector, expression, value, label or HTML is accepted from the caller.
# Metadata comes from the current live top document; nested frames/shadow roots
# fail closed. The browser keeps an independent copy for broker enforcement.
async def observe_credentials(request):
    _,grant=authorize(request,'runtime');b=browser(grant)
    async with b.lock:
        if b.guard:raise web.HTTPConflict()
        tree=await b.rpc('Page.getFrameTree',session=b.session)
        document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
        frame=tree['frameTree']['frame'];origin=browser_origin(frame['url'])
        if not origin or not safe_resume_snapshot(tree,document,{'result':{'value':True}}):raise web.HTTPConflict()
        result=await b.rpc('Runtime.evaluate',{'expression':"""(() => {
          const inputs=[...document.querySelectorAll('input')].filter(e=>!e.disabled&&!e.readOnly&&e.getClientRects().length);
          const passwords=inputs.filter(e=>e.type==='password');
          const users=inputs.filter(e=>['text','email','tel'].includes(e.type)&&(e.autocomplete==='username'||e.type==='email'||e.name==='username'));
          if(passwords.length!==1||users.length>1||[...users,...passwords].some(e=>e.value))return null;
          return [...users,...passwords];
        })()""",'returnByValue':False},b.session)
        obj=result.get('result',{}).get('objectId')
        if not obj:raise web.HTTPConflict()
        props=await b.rpc('Runtime.getProperties',{'objectId':obj,'ownProperties':True},b.session)
        nodes=[]
        for prop in props.get('result',[]):
            if not prop.get('name','').isdigit():continue
            item=prop.get('value',{}).get('objectId')
            node=(await b.rpc('DOM.describeNode',{'objectId':item},b.session))['node'] if item else {}
            attrs=dict(zip(node.get('attributes',[])[::2],node.get('attributes',[])[1::2]))
            role='password' if attrs.get('type','text').lower()=='password' else 'username'
            if node.get('nodeName')!='INPUT' or not isinstance(node.get('backendNodeId'),int):raise web.HTTPConflict()
            nodes.append({'backendNodeId':node['backendNodeId'],'credentialRole':role})
        if len(nodes) not in (1,2) or sum(n['credentialRole']=='password' for n in nodes)!=1:raise web.HTTPConflict()
        after=(await b.rpc('Page.getFrameTree',session=b.session))['frameTree']['frame']
        if after['loaderId']!=frame['loaderId'] or browser_origin(after['url'])!=origin:raise web.HTTPConflict()
        b.credential_nodes=nodes;b.credential_loader=frame['loaderId'];b.credential_origin=origin
        return web.json_response({'targetId':b.target,'origin':origin,'loaderId':frame['loaderId'],'inputs':nodes})

async def resume_guard(b):
    tree=await b.rpc('Page.getFrameTree',session=b.session)
    document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
    check=await b.rpc('Runtime.evaluate',{'expression':SAFE_TO_RESUME,'returnByValue':True},b.session)
    if browser_origin(tree['frameTree']['frame']['url'])!=b.guard_origin or not safe_resume_snapshot(tree,document,check):return False
    b.frame=None
    await b.rpc('Page.startScreencast',{'format':'jpeg','quality':60,'maxWidth':1280,'maxHeight':800,'everyNthFrame':2},b.session)
    b.guard_file.unlink();b.guard=None
    if b.grant.get('display'):
        (Path('/run/mikka-viewer')/f"{b.grant['display']}.guard").unlink()
        fcntl.flock(b.driver_lock,fcntl.LOCK_UN);b.driver_lock.close()
    return True

async def continue_credentials(request):
    # This role is issued only by the trusted approval-ledger executor, never
    # exposed in a viewer, model tool, JSON review, or arbitrary runtime action.
    _,grant=authorize(request,'credential-continuation');b=browser(grant)
    plan=grant.get('credentialAction',{})
    async with b.lock:
        if not b.guard or b.guard=='locked':raise web.HTTPConflict()
        if set(plan)!={'actionId','operation','targetId','origin','loaderId','inputs'} or plan['operation'] not in ('submit','clear'):raise web.HTTPForbidden()
        if plan['targetId']!=b.target or plan['origin']!=b.guard_origin or plan['loaderId']!=b.guard_loader or plan['inputs']!=getattr(b,'credential_nodes',None):raise web.HTTPConflict()
        marker=b.path/('credential-action-'+hashlib.sha256(str(plan['actionId']).encode()).hexdigest())
        # Exclusive creation consumes before an external effect. Unknown outcome
        # stays guarded and cannot be replayed even after gateway restart.
        try:fd=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)
        except FileExistsError:raise web.HTTPConflict()
        tree=await b.rpc('Page.getFrameTree',session=b.session)
        frame=tree['frameTree']['frame']
        if browser_origin(frame['url'])!=plan['origin']:raise web.HTTPConflict()
        if frame['loaderId']!=plan['loaderId']:
            if plan['operation']=='clear' and await resume_guard(b):return web.json_response({'resumed':True,'operation':'clear'})
            raise web.HTTPConflict()
        document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
        if not safe_resume_snapshot(tree,document,{'result':{'value':True}}):raise web.HTTPConflict()
        for node in plan['inputs']:
            if plan['operation']=='submit' and node['credentialRole']!='password':continue
            resolved=await b.rpc('DOM.resolveNode',{'backendNodeId':node['backendNodeId']},b.session)
            obj=resolved.get('object',{}).get('objectId')
            if not obj:raise web.HTTPConflict()
            # The exact function never reads or returns any input value.
            function="""function(operation,role,origin){
              if(this.tagName!=='INPUT'||this.disabled||this.readOnly||!this.getClientRects().length||
                (role==='password'?this.type!=='password':!['text','email','tel'].includes(this.type)))return false;
              if(operation==='clear'){
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(this,'');
                this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;
              }
              if(!this.form||this.form.target&&this.form.target!=='_self'||new URL(this.form.action).origin!==origin)return false;
              HTMLFormElement.prototype.requestSubmit.call(this.form);return true;
            }"""
            effect=await b.rpc('Runtime.callFunctionOn',{'objectId':obj,'functionDeclaration':function,'arguments':[{'value':plan['operation']},{'value':node['credentialRole']},{'value':plan['origin']}],'returnByValue':True},b.session)
            if effect.get('result',{}).get('value') is not True:raise web.HTTPConflict()
        # Navigation is asynchronous. Failure to prove safety does not unlock or
        # claim authentication; a later explicit Clear action can recover it.
        resumed=False
        for _ in range(20):
            await asyncio.sleep(.1)
            try:
                if await resume_guard(b):resumed=True;break
            except Exception:pass
        return web.json_response({'resumed':resumed,'operation':plan['operation']})

async def version(_request):
    return web.Response(text=VERSION, headers={'Cache-Control':'no-store'})

app=web.Application(client_max_size=16384)
app.router.add_get('/version',version)
for suffix,handler,method in [('/start',start,'POST'),('/state',state,'GET'),('/stop',stop,'POST'),('/viewer',viewer,'GET'),('/action',action,'POST'),('/credentials/begin',begin,'POST'),('/credentials/cdp',cdp,'GET'),('/credentials/end',end,'POST'),('/credentials/observe',observe_credentials,'GET'),('/credentials/continue',continue_credentials,'POST')]:app.router.add_route(method,'/agents/{id}'+suffix,handler)
if __name__=='__main__':web.run_app(app,host='0.0.0.0',port=6082,access_log=None,print=None)
