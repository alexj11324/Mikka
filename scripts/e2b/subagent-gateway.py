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
BROKER_METHODS = frozenset(('Page.getFrameTree', 'DOM.getDocument', 'DOM.focus', 'DOM.describeNode', 'DOM.resolveNode', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Input.insertText', 'Input.dispatchKeyEvent', 'Network.setCookies', 'Network.getCookies', 'Page.reload'))
BROKER_SUBMIT_FUNCTION = 'function(){if(!this.isConnected||this.ownerDocument!==document||!this.form||this.disabled)return false;const f=this.form;const method=(this.getAttribute("formmethod")||f.getAttribute("method")||"get").toLowerCase();const target=this.getAttribute("formtarget")||f.getAttribute("target")||"";const url=new URL(this.getAttribute("formaction")||f.getAttribute("action")||location.href,document.baseURI);if(method!=="post"||url.origin!==location.origin||url.username||url.password||!["","_self"].includes(target))return false;HTMLFormElement.prototype.requestSubmit.call(f,this);return true}'
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
# Keep input outlines visible for the vision model while masking editable text.
# Original inline styles stay in an isolated world and are restored before
# scripts resume. A presence check blocks populated sensitive controls.
MASK_VISUAL_FIELDS = """(() => {
  globalThis.__mikkaMasks = [];
  globalThis.__mikkaMaskStyle = null;
  if (document.readyState !== 'complete') return false;
  if ([...document.querySelectorAll('input,textarea')].some(e => e.value && (e.type === 'password' || /(?:otp|one[\\s_-]*time|verification[\\s_-]*code|security[\\s_-]*code|auth(?:entication)?[\\s_-]*code)/i.test([e.autocomplete,e.name,e.id,e.getAttribute('aria-label'),e.getAttribute('placeholder')].join(' '))))) return false;
  const roots = [...document.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=image]):not([type=range]):not([type=color]),textarea,select,[contenteditable]:not([contenteditable="false"])')];
  const elements = [...new Set(roots.flatMap(e => [e, ...e.querySelectorAll('*')]))];
  const properties = ['color','-webkit-text-fill-color','text-shadow','caret-color','transition'];
  globalThis.__mikkaMasks = elements.map(e => [e, properties.map(p => [p,e.style.getPropertyValue(p),e.style.getPropertyPriority(p)])]);
  const style=document.createElement('style');
  style.textContent='input::placeholder,textarea::placeholder{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}';
  document.head.appendChild(style); globalThis.__mikkaMaskStyle=style;
  for (const e of elements) {
    e.style.setProperty('transition','none','important'); e.style.setProperty('color','transparent','important');
    e.style.setProperty('-webkit-text-fill-color','transparent','important'); e.style.setProperty('text-shadow','none','important'); e.style.setProperty('caret-color','transparent','important');
  }
  const hidden = s => s.webkitTextFillColor === 'rgba(0, 0, 0, 0)' && s.textShadow === 'none';
  return elements.every(e => hidden(getComputedStyle(e)) && ['::before','::after'].every(p => { const s=getComputedStyle(e,p); return s.content==='none'||s.content==='normal'||hidden(s); }) && (!['INPUT','TEXTAREA'].includes(e.tagName)||hidden(getComputedStyle(e,'::placeholder'))));
})()"""
RESTORE_VISUAL_FIELDS = """(() => {
  if (!Array.isArray(globalThis.__mikkaMasks)) return false;
  for (const [e,properties] of globalThis.__mikkaMasks) {
    for (const [p,v,priority] of properties) { if (v) e.style.setProperty(p,v,priority); else e.style.removeProperty(p); }
  }
  globalThis.__mikkaMaskStyle?.remove(); delete globalThis.__mikkaMaskStyle;
  delete globalThis.__mikkaMasks; return true;
})()"""
OBSERVE_DOM = """(() => {
  for (const e of document.querySelectorAll('[data-mikka-ref]')) e.removeAttribute('data-mikka-ref');
  const copy=document.body.cloneNode(true);
  copy.querySelectorAll('input,textarea,select,script,style,noscript').forEach(e=>e.remove());
  const elements=Array.from(document.querySelectorAll('a,button,input,textarea,select')).slice(0,150).map((e,i)=>{
    e.setAttribute('data-mikka-ref',String(i));
    return {selector:'[data-mikka-ref="'+i+'"]',tag:e.tagName,type:e.type||null,text:['INPUT','TEXTAREA','SELECT'].includes(e.tagName)?null:e.innerText.slice(0,200),label:e.getAttribute('aria-label')||e.getAttribute('placeholder'),href:e.tagName==='A'?e.href:null};
  });
  return JSON.stringify({url:location.origin+location.pathname,title:document.title,text:(copy.innerText||copy.textContent||'').slice(0,16000),elements});
})()"""

def observed_targets(document, count):
    """Bind displayed selectors to CDP node identities, not page attributes."""
    found={}
    def visit(node):
        if not isinstance(node,dict):return
        attrs=node.get('attributes',[])
        if isinstance(attrs,list) and len(attrs)%2==0:
            for key,value in zip(attrs[::2],attrs[1::2]):
                if key=='data-mikka-ref' and isinstance(value,str) and value.isdecimal():
                    index=int(value);backend=node.get('backendNodeId')
                    if index in found or not isinstance(backend,int) or backend<=0:raise web.HTTPConflict()
                    found[index]=backend
        for child in node.get('children',[]):visit(child)
    visit(document.get('root'))
    if set(found)!=set(range(count)):raise web.HTTPConflict()
    return {str(index):found[index] for index in range(count)}

def valid_observed_input(document, backend_id, role):
    """Inspect only top-level DOM nodes; the caller separately rejects frames and shadows."""
    def find(node):
        if not isinstance(node,dict):return None
        if node.get('backendNodeId')==backend_id:return node
        for child in node.get('children',[]):
            result=find(child)
            if result:return result
        return None
    node=find(document.get('root')) if isinstance(document,dict) else None
    attrs=node.get('attributes') if isinstance(node,dict) else None
    if not isinstance(attrs,list) or len(attrs)%2 or any(not isinstance(v,str) for v in attrs):return False
    values=dict(zip((k.lower() for k in attrs[::2]),attrs[1::2]))
    allowed=('password',) if role=='password' else ('text','email','tel') if role=='username' else ()
    return node.get('nodeName')=='INPUT' and 'disabled' not in values and 'readonly' not in values and values.get('type','text').lower() in allowed
def valid_observed_submit(document, backend_id):
    def find(node):
        if not isinstance(node,dict):return None
        if node.get('backendNodeId')==backend_id:return node
        for child in node.get('children',[]):
            value=find(child)
            if value:return value
        return None
    node=find(document.get('root')) if isinstance(document,dict) else None
    attrs=node.get('attributes') if isinstance(node,dict) else None
    if not isinstance(attrs,list) or len(attrs)%2 or any(not isinstance(v,str) for v in attrs):return False
    values=dict(zip((k.lower() for k in attrs[::2]),attrs[1::2]))
    if 'disabled' in values:return False
    return (node.get('nodeName')=='BUTTON' and values.get('type','submit').lower()=='submit') or (node.get('nodeName')=='INPUT' and values.get('type','').lower()=='submit')

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

def broker_command_allowed(data, target, sessions, objects=None, origin=None, observed_node=None, active_objects=None, observed_inputs=None, submit_node=None, submit_objects=None):
    if not isinstance(data,dict) or type(data.get('id')) is not int or data['id'] < 1 or not isinstance(data.get('params'),dict):return False
    objects=objects or {}
    method=data.get('method')
    if method=='Target.attachToTarget':
        return set(data)=={'id','method','params'} and not sessions and data['params']=={'targetId':target,'flatten':True}
    if set(data)!={'id','method','params','sessionId'} or not isinstance(method,str) or method not in BROKER_METHODS or not isinstance(data.get('sessionId'),str) or data['sessionId'] not in sessions:return False
    params=data['params']
    allowed_inputs=observed_inputs or ({observed_node:None} if observed_node is not None else {})
    if method=='DOM.resolveNode':return submit_node is not None and params=={'backendNodeId':submit_node}
    if method=='Runtime.callFunctionOn' and submit_node is not None and params.get('functionDeclaration')==BROKER_SUBMIT_FUNCTION:
        return set(params)=={'objectId','functionDeclaration','returnByValue'} and isinstance(params.get('objectId'),str) and params['objectId']==(submit_objects or {}).get(data['sessionId']) and params['returnByValue'] is True
    if observed_node is not None:
        if method=='Runtime.evaluate':
            if params=={'expression':'document.activeElement','returnByValue':False}:return True
            if params.get('expression') not in ('globalThis', 'Object.entries(localStorage)', "![...document.querySelectorAll('input,textarea')].some(e=>e.value && (e.tagName==='TEXTAREA'||!['hidden','checkbox','radio','button','submit','reset','image','file','range','color'].includes(e.type)))"):return False
        if method=='DOM.getDocument':return params in ({'depth':-1,'pierce':False},{'depth':-1,'pierce':True})
    if method in ('Page.getFrameTree','Page.reload'):return params=={}
    if method=='DOM.getDocument':return params=={'depth':-1,'pierce':True}
    if method=='DOM.focus':return observed_node is not None and type(params.get('backendNodeId')) is int and set(params)=={'backendNodeId'} and params['backendNodeId'] in allowed_inputs
    if method=='DOM.describeNode':return observed_node is not None and set(params)=={'objectId'} and isinstance(params['objectId'],str) and params['objectId']==(active_objects or {}).get(data['sessionId'])
    if method=='Runtime.evaluate':
        return set(params)=={'expression','returnByValue'} and isinstance(params['expression'],str) and ((params['expression'] in BROKER_EVALUATIONS and params['returnByValue'] is True) or (params['expression']=='globalThis' and params['returnByValue'] is False))
    if method=='Runtime.callFunctionOn':
        args=params.get('arguments')
        return set(params)=={'objectId','functionDeclaration','arguments','returnByValue'} and isinstance(params['objectId'],str) and bool(params['objectId']) and params['objectId']==objects.get(data['sessionId']) and params['functionDeclaration']==BROKER_STORAGE_FUNCTION and params['returnByValue'] is True and isinstance(args,list) and len(args)==1 and isinstance(args[0],dict) and set(args[0])=={'value'} and isinstance(args[0]['value'],list) and all(isinstance(item,list) and len(item)==2 and all(isinstance(part,str) for part in item) for item in args[0]['value'])
    if method=='Input.dispatchKeyEvent':return observed_node is not None and params in ({'type':'keyDown','key':'a','code':'KeyA','modifiers':2,'windowsVirtualKeyCode':65,'commands':['selectAll']},{'type':'keyUp','key':'a','code':'KeyA','modifiers':2})
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
        self.session=None;self.target=None;self.lock=asyncio.Lock();self.viewer=set();self.brokers=set();self.stopped=False
        self.broker_active=False;self.credential_scripts_disabled=False
        self.path=ROOT/grant['subagentId']; self.path.mkdir(mode=0o700,exist_ok=True)
        self.revoked_file=self.path/'revoked'
        self.stopped=self.revoked_file.exists()
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
                    if not self.guard and not self.stopped:self.frame=message['params']['data']
                    await self.send('Page.screencastFrameAck',{'sessionId':message['params']['sessionId']},self.session)
        finally:
            self.stopped=True;self.frame=None
            for future in self.pending.values():
                if not future.done():future.set_exception(RuntimeError())
    async def send(self,method,params=None,session=None):
        self.seq+=1; n=self.seq
        self.writer.write((json.dumps({'id':n,'method':method,'params':params or {},**({'sessionId':session} if session else {})})+'\n').encode());await self.writer.drain();return n
    async def rpc(self,method,params=None,session=None):
        if self.stopped:raise RuntimeError('Browser capability revoked')
        return await self._rpc(method,params,session)
    async def _rpc(self,method,params=None,session=None):
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
        # Revoke the gateway capability durably, while retaining its browser,
        # profile, socket, logs and guard markers for audit and recovery.
        self.revoked_file.write_text('stopped')
        for ws in list(self.viewer):await ws.close()
        for ws in list(self.brokers):await ws.close()
        if self.session:
            # Mechanical suspension is allowed after capability revocation;
            # ordinary runtime RPC remains denied. Failure is not success.
            await self._rpc('Emulation.setScriptExecutionDisabled',{'value':True},self.session)
            await self._rpc('Page.stopScreencast',session=self.session)

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
        if b.stopped:raise web.HTTPGone()
        try:await b.start()
        except Exception:
            # Keep the failed launch discoverable and deny its old grants.
            await b.stop()
            raise web.HTTPServiceUnavailable()
    b=browser(grant)
    return web.json_response({'targetId':b.target,'url':await b.url(),'guarded':bool(b.guard)})

async def state(request):
    _,grant=authorize(request,'runtime');b=browser(grant)
    return web.json_response({'targetId':b.target,'url':None if b.guard else await b.url(),'guarded':bool(b.guard)})

async def stop(request):
    _,grant=authorize(request,'runtime')
    b=AGENTS.get(grant['subagentId'])
    if b:
        if any(grant.get(k)!=b.grant.get(k) for k in ('ownerId','workspaceId','botId','epoch','display')):raise web.HTTPNotFound()
        await b.stop()
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
        node=grant.get('backendNodeId');role=grant.get('credentialRole')
        if (node is not None or role is not None) and (type(node) is not int or node<=0 or role not in ('username','password') or not isinstance(grant.get('loaderId'),str) or not grant['loaderId'] or not browser_origin(grant.get('origin'))):raise web.HTTPForbidden()
        extra=grant.get('additionalInput');submit=grant.get('submitNodeId')
        if extra is not None and (not isinstance(extra,dict) or set(extra)!={'backendNodeId','role'} or type(extra.get('backendNodeId')) is not int or extra['backendNodeId']<=0 or extra['backendNodeId']==node or extra.get('role') not in ('username','password') or extra['role']==role or node is None):raise web.HTTPForbidden()
        if submit is not None and (type(submit) is not int or submit<=0 or submit==node or (extra and submit==extra['backendNodeId']) or node is None):raise web.HTTPForbidden()
        b.guard_node=node;b.guard_role=role
        b.guard_inputs={node:role} if node is not None else {}
        if extra:b.guard_inputs[extra['backendNodeId']]=extra['role']
        b.guard_submit=submit
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
        if node is not None and (grant['loaderId']!=b.guard_loader or browser_origin(grant['origin'])!=b.guard_origin or not valid_observed_input(document,node,role)):raise web.HTTPConflict()
        if any(not valid_observed_input(document,key,value) for key,value in b.guard_inputs.items()) or (submit is not None and not valid_observed_submit(document,submit)):raise web.HTTPConflict()
        for ws in list(b.viewer):await ws.close()
    base=f'https://{request.host}'
    return web.json_response({'cdpUrl':base.replace('https:','wss:')+request.path.replace('/credentials/begin','/credentials/cdp')+'?token='+request.query['token']+'&guard='+b.guard,'targetId':b.target,'guardToken':b.guard})

async def cdp(request):
    raw,grant=authorize(request,'broker');b=browser(grant)
    guard=request.query.get('guard','')
    async with b.lock:
        if not b.guard or not hmac.compare_digest(guard,b.guard):raise web.HTTPForbidden()
        if getattr(b,'guard_node',None) is not None and (grant.get('backendNodeId')!=b.guard_node or grant.get('credentialRole')!=b.guard_role or grant.get('loaderId')!=b.guard_loader or browser_origin(grant.get('origin'))!=b.guard_origin):raise web.HTTPForbidden()
        expected_inputs={grant.get('backendNodeId'):grant.get('credentialRole')} if grant.get('backendNodeId') is not None else {}
        if grant.get('additionalInput'):expected_inputs[grant['additionalInput']['backendNodeId']]=grant['additionalInput']['role']
        if getattr(b,'guard_inputs',{})!=expected_inputs or getattr(b,'guard_submit',None)!=grant.get('submitNodeId'):raise web.HTTPForbidden()
        if getattr(b,'broker_active',False):raise web.HTTPConflict()
        b.broker_active=True
    try:return await broker_cdp_session(request,b,grant,raw,guard)
    finally:
        async with b.lock:b.broker_active=False

async def broker_cdp_session(request,b,grant,raw,guard):
    ws=web.WebSocketResponse(max_msg_size=1024*1024);await ws.prepare(request)
    b.brokers.add(ws)
    if b.stopped:
        b.brokers.discard(ws);await ws.close();return ws
    try:reader,writer=await asyncio.open_unix_connection(str(b.path/'cdp.sock'),limit=4*1024*1024)
    except Exception:
        b.brokers.discard(ws);await ws.close();raise
    sessions=set();pending={};objects={};active_objects={};submit_objects={};focused={};origin=getattr(b,'guard_origin',None);observed_node=getattr(b,'guard_node',None);input_done=asyncio.Event()
    if not origin:
        b.brokers.discard(ws);writer.close();await writer.wait_closed();await ws.close();return ws
    observed_inputs=getattr(b,'guard_inputs',{}) or ({observed_node:getattr(b,'guard_role',None)} if observed_node is not None else {})
    submit_node=getattr(b,'guard_submit',None)
    async def incoming():
        async for message in ws:
            token(raw,'broker')
            if b.stopped or b.guard!=guard or message.type!=WSMsgType.TEXT:break
            data=json.loads(message.data)
            # Broker capability is scoped to this page, not a general CDP socket.
            if not broker_command_allowed(data,b.target,sessions,objects,origin,observed_node,active_objects,observed_inputs,submit_node,submit_objects) or data['id'] in pending:break
            if data['method']!='Target.attachToTarget' and browser_origin(await b.url())!=origin:break
            if data['method']=='Target.attachToTarget' and any(item[0]=='Target.attachToTarget' for item in pending.values()):break
            if data['method']=='Runtime.callFunctionOn':objects.pop(data['sessionId'],None)
            if data['method']=='Page.reload':objects.pop(data['sessionId'],None);focused.pop(data['sessionId'],None)
            if data['method']=='DOM.focus':
                if getattr(b,'credential_scripts_disabled',False):break
                b.credential_scripts_disabled=True
                await b.rpc('Emulation.setScriptExecutionDisabled',{'value':True},b.session)
                tree=await b.rpc('Page.getFrameTree',session=b.session)
                document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
                frame=tree.get('frameTree',{}).get('frame',{})
                if frame.get('loaderId')!=b.guard_loader or browser_origin(frame.get('url'))!=origin or not safe_resume_snapshot(tree,document,{'result':{'value':True}}) or not valid_observed_input(document,data['params']['backendNodeId'],observed_inputs.get(data['params']['backendNodeId'])):break
            if data['method']=='Runtime.evaluate':
                if data['params']['expression']!='document.activeElement':focused.pop(data['sessionId'],None)
                if data['params']['expression'] in BROKER_FOCUS_EXPRESSIONS:
                    if getattr(b,'credential_scripts_disabled',False):break
                    # Freeze page scripts before focus, so a site callback or
                    # timer cannot retarget the subsequent native CDP input.
                    b.credential_scripts_disabled=True
                    await b.rpc('Emulation.setScriptExecutionDisabled',{'value':True},b.session)
            if data['method']=='Runtime.callFunctionOn' and data['params'].get('functionDeclaration')==BROKER_SUBMIT_FUNCTION:
                tree=await b.rpc('Page.getFrameTree',session=b.session)
                document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
                frame=tree.get('frameTree',{}).get('frame',{})
                if getattr(b,'credential_scripts_disabled',False) or frame.get('loaderId')!=b.guard_loader or browser_origin(frame.get('url'))!=origin or not safe_resume_snapshot(tree,document,{'result':{'value':True}}) or not valid_observed_submit(document,submit_node):break
            if data['method']=='Input.dispatchKeyEvent' and (not focused.get(data['sessionId']) or not getattr(b,'credential_scripts_disabled',False)):break
            if data['method']=='Input.insertText':
                selector=focused.pop(data['sessionId'],None)
                if not selector or not getattr(b,'credential_scripts_disabled',False):break
                tree=await b.rpc('Page.getFrameTree',session=b.session)
                document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
                if not safe_resume_snapshot(tree,document,{'result':{'value':True}}):break
                if type(selector) is int:
                    frame=tree.get('frameTree',{}).get('frame',{})
                    if frame.get('loaderId')!=b.guard_loader or not valid_observed_input(document,selector,observed_inputs.get(selector)):break
                    check=await b.rpc('Runtime.evaluate',{'expression':'document.activeElement','returnByValue':False},b.session)
                else:
                    check=await b.rpc('Runtime.evaluate',{'expression':f"(()=>{{const e=document.querySelector({json.dumps(selector)});return e && !e.disabled && !e.readOnly && document.activeElement===e ? e : null}})()",'returnByValue':False},b.session)
                element=check.get('result',{}).get('objectId')
                if not isinstance(element,str) or not element or browser_origin(await b.url())!=origin:break
                if type(selector) is int:
                    described=await b.rpc('DOM.describeNode',{'objectId':element},b.session)
                    if described.get('node',{}).get('backendNodeId')!=selector:break
                input_done.clear()
            else:element=None
            argument=data.get('params',{}).get('backendNodeId') if data['method']=='DOM.focus' else data.get('params',{}).get('expression')
            # No await between the last revocation check and enqueueing I/O.
            if b.stopped:break
            pending[data['id']]=(data['method'],data.get('sessionId'),argument,element)
            writer.write((json.dumps(data)+'\n').encode());await writer.drain()
    async def outgoing():
        while line:=await reader.readline():
            token(raw,'broker')
            if b.stopped or b.guard!=guard:break
            data=json.loads(line)
            if data.get('method')=='Target.detachedFromTarget':
                detached=data.get('params',{}).get('sessionId')
                sessions.discard(detached);objects.pop(detached,None);focused.pop(detached,None)
            if data.get('method')=='Page.frameNavigated':
                frame=data.get('params',{}).get('frame',{})
                if not frame.get('parentId') and browser_origin(frame.get('url'))!=origin:break
            call=pending.get(data.get('id'))
            if call and call[0]=='Target.attachToTarget':
                session=data.get('result',{}).get('sessionId')
                if isinstance(session,str) and session:sessions.add(session)
            if call and call[0]=='DOM.resolveNode':
                object_id=data.get('result',{}).get('object',{}).get('objectId')
                if isinstance(object_id,str) and object_id:submit_objects[call[1]]=object_id
            if call and call[0]=='Runtime.evaluate' and call[2]=='globalThis':
                object_id=data.get('result',{}).get('result',{}).get('objectId')
                if isinstance(object_id,str) and object_id:objects[call[1]]=object_id
            if call and call[0]=='Runtime.evaluate' and call[2]=='document.activeElement':
                object_id=data.get('result',{}).get('result',{}).get('objectId')
                if isinstance(object_id,str) and object_id:active_objects[call[1]]=object_id
            if call and call[0]=='DOM.focus' and 'error' not in data:focused[call[1]]=call[2]
            if call and call[0]=='Runtime.evaluate' and call[2] in BROKER_FOCUS_EXPRESSIONS and data.get('result',{}).get('result',{}).get('value') is True:
                focused[call[1]]=BROKER_FOCUS_EXPRESSIONS[call[2]]
            if call and call[0]=='Input.insertText':
                # Native input is complete before scripts resume. The browser
                # suppresses page listeners while frozen; dispatch one input
                # event to the exact captured element after resuming.
                await b.rpc('Emulation.setScriptExecutionDisabled',{'value':False},b.session)
                b.credential_scripts_disabled=False
                if 'error' not in data:
                    if browser_origin(await b.url())!=origin:break
                    emitted=await b.rpc('Runtime.callFunctionOn',{'objectId':call[3],'functionDeclaration':'function(){if(!this.isConnected)return false;this.dispatchEvent(new Event("input",{bubbles:true}));return true}','returnByValue':True},b.session)
                    if emitted.get('result',{}).get('value') is not True:break
                input_done.set()
            if call:pending.pop(data['id'],None)
            if b.stopped:break
            await ws.send_str(line.decode().strip())
    async def expiry():
        await asyncio.sleep(max(0,grant['exp']-time.time()))
    tasks=[asyncio.create_task(f()) for f in (incoming,outgoing,expiry)]
    try:await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
    finally:
        if getattr(b,'credential_scripts_disabled',False) and any(call[0]=='Input.insertText' for call in pending.values()):
            try:await asyncio.wait_for(input_done.wait(),15)
            except asyncio.TimeoutError:pass
        for task in tasks:task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        # If an input outcome is unknown, leave scripts disabled and the guard
        # closed. Otherwise release the short-lived freeze on disconnect.
        if not b.stopped and getattr(b,'credential_scripts_disabled',False) and not any(call[0]=='Input.insertText' for call in pending.values()):
            try:
                await b.rpc('Emulation.setScriptExecutionDisabled',{'value':False},b.session)
                b.credential_scripts_disabled=False
            except Exception:pass
        b.brokers.discard(ws)
        writer.close();await writer.wait_closed();await ws.close()
    return ws

async def end(request):
    _,grant=authorize(request,'broker');b=browser(grant);data=await request.json()
    async with b.lock:
        if not b.guard or not hmac.compare_digest(data.get('guardToken',''),b.guard):raise web.HTTPForbidden()
        if getattr(b,'credential_scripts_disabled',False):raise web.HTTPConflict()
        try:
            tree=await b.rpc('Page.getFrameTree',session=b.session)
            document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
            check=await b.rpc('Runtime.evaluate',{'expression':SAFE_TO_RESUME,'returnByValue':True},b.session)
            safe=safe_resume_snapshot(tree,document,check)
        except Exception:
            safe=False
        if not safe:raise web.HTTPConflict()
        # Clear the last frame so no buffered pre-fill frame races resumption.
        b.frame=None;await b.rpc('Page.startScreencast',{'format':'jpeg','quality':60,'maxWidth':1280,'maxHeight':800,'everyNthFrame':2},b.session)
        if b.stopped:raise web.HTTPConflict()
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
            tree=await b.rpc('Page.getFrameTree',session=b.session)
            frame=tree['frameTree']['frame'];u=urlsplit(frame['url'])
            if frame['loaderId']!=data['expectedLoaderId'] or f'{u.scheme}://{u.netloc}'!=data.get('expectedOrigin'):raise web.HTTPConflict()
        if name=='inspectMutation':
            tree=await b.rpc('Page.getFrameTree',session=b.session);frame=tree['frameTree']['frame'];u=urlsplit(frame['url'])
            if u.scheme not in ('https','http') or not u.hostname or u.username or u.password:raise web.HTTPConflict()
            return web.json_response({'loaderId':frame['loaderId'],'origin':f'{u.scheme}://{u.netloc}'})
        if name=='inspectCredentialSubmit':
            if set(data)!={'action','loaderId','origin','backendNodeId'} or type(data.get('backendNodeId')) is not int or data['backendNodeId']<=0:raise web.HTTPBadRequest()
            tree=await b.rpc('Page.getFrameTree',session=b.session);frame=tree.get('frameTree',{}).get('frame',{})
            document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
            origin=browser_origin(frame.get('url'))
            if origin!=browser_origin(data.get('origin')) or frame.get('loaderId')!=data['loaderId'] or not safe_resume_snapshot(tree,document,{'result':{'value':True}}) or not valid_observed_submit(document,data['backendNodeId']):raise web.HTTPConflict()
            return web.json_response({'targetId':b.target,'loaderId':frame['loaderId'],'origin':origin,'backendNodeId':data['backendNodeId']})
        if name=='inspectCredentialTarget':
            if set(data)!={'action','loaderId','origin','backendNodeId','role'} or type(data.get('backendNodeId')) is not int or data['backendNodeId']<=0 or data.get('role') not in ('username','password') or not isinstance(data.get('loaderId'),str):raise web.HTTPBadRequest()
            tree=await b.rpc('Page.getFrameTree',session=b.session);frame=tree.get('frameTree',{}).get('frame',{})
            document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
            origin=browser_origin(frame.get('url'))
            if not origin or origin!=browser_origin(data.get('origin')) or frame.get('loaderId')!=data['loaderId'] or not safe_resume_snapshot(tree,document,{'result':{'value':True}}) or not valid_observed_input(document,data['backendNodeId'],data['role']):raise web.HTTPConflict()
            return web.json_response({'targetId':b.target,'loaderId':frame['loaderId'],'origin':origin,'backendNodeId':data['backendNodeId'],'role':data['role']})
        if name=='navigate':
            from urllib.parse import urlparse
            u=urlparse(data.get('url',''))
            if u.scheme not in ('https','http') or not u.hostname or u.username or u.password:raise web.HTTPBadRequest()
            await b.rpc('Page.navigate',{'url':data['url']},b.session)
        elif name=='observe':
            # Capture only while scripts are frozen and all editable values
            # are hidden in an isolated world. Nested documents and shadow
            # trees remain blocked until their contents can be fenced.
            await b.rpc('Emulation.setScriptExecutionDisabled',{'value':True},b.session)
            context=None;restored=False
            try:
                tree=await b.rpc('Page.getFrameTree',session=b.session)
                document=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
                if not safe_resume_snapshot(tree,document,{'result':{'value':True}}):raise web.HTTPConflict()
                world=await b.rpc('Page.createIsolatedWorld',{'frameId':tree['frameTree']['frame']['id'],'worldName':'mikka-visual-mask'},b.session)
                context=world['executionContextId']
                masked=await b.rpc('Runtime.evaluate',{'expression':MASK_VISUAL_FIELDS,'contextId':context,'returnByValue':True},b.session)
                if 'exceptionDetails' in masked or masked.get('result',{}).get('value') is not True:raise web.HTTPConflict()
                screenshot=await b.rpc('Page.captureScreenshot',{'format':'jpeg','quality':60},b.session)
                if not isinstance(screenshot.get('data'),str) or not screenshot['data']:raise web.HTTPServiceUnavailable()
                # Keep scripts frozen through element labeling and CDP node
                # identity collection, so a model-selected target cannot be
                # silently swapped for a different element with the same ref.
                text=await b.rpc('Runtime.evaluate',{'expression':OBSERVE_DOM,'contextId':context,'returnByValue':True},b.session)
                if 'exceptionDetails' in text:raise web.HTTPConflict()
                observation=json.loads(text['result']['value'])
                snapshot=await b.rpc('DOM.getDocument',{'depth':-1,'pierce':True},b.session)
                targets=observed_targets(snapshot,len(observation['elements']))
                current=await b.rpc('Page.getFrameTree',session=b.session)
                before=tree['frameTree']['frame'];after=current['frameTree']['frame']
                if before.get('id')!=after.get('id') or before.get('loaderId')!=after.get('loaderId') or before.get('url')!=after.get('url'):raise web.HTTPConflict()
            finally:
                if context is None:restored=True
                else:
                    try:
                        result=await b.rpc('Runtime.evaluate',{'expression':RESTORE_VISUAL_FIELDS,'contextId':context,'returnByValue':True},b.session)
                        restored='exceptionDetails' not in result and result.get('result',{}).get('value') is True
                    except Exception:restored=False
                if restored:await b.rpc('Emulation.setScriptExecutionDisabled',{'value':False},b.session)
                else:
                    b.guard='locked';b.guard_file.write_text('locked')
                    raise web.HTTPConflict()
            return web.json_response({'observation':observation,'screenshot':screenshot['data'],'loaderId':before.get('loaderId'),'targets':targets})
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
            # The calling harness applies the configured permission policy.
            selector=json.dumps(str(data.get('selector',''))[:500])
            await b.rpc('Runtime.evaluate',{'expression':f'document.querySelector({selector})?.click()'},b.session)
        else:raise web.HTTPBadRequest()
        return web.json_response({'accepted':True})

async def version(_request):
    return web.Response(text=VERSION, headers={'Cache-Control':'no-store'})

app=web.Application(client_max_size=16384)
app.router.add_get('/version',version)
for suffix,handler,method in [('/start',start,'POST'),('/state',state,'GET'),('/stop',stop,'POST'),('/viewer',viewer,'GET'),('/action',action,'POST'),('/credentials/begin',begin,'POST'),('/credentials/cdp',cdp,'GET'),('/credentials/end',end,'POST')]:app.router.add_route(method,'/agents/{id}'+suffix,handler)
if __name__=='__main__':web.run_app(app,host='0.0.0.0',port=6082,access_log=None,print=None)
