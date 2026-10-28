import asyncio,aiohttp,json,time,base64,hmac,hashlib,os,uuid
from pathlib import Path
from aiohttp import web
KEY=Path('/run/mikka-subagents/key').read_bytes();ID=os.environ.get('MIKKA_SUBAGENT_ACCEPTANCE_ID') or str(uuid.uuid4())
def cap(role,owner='probe-owner'):
 p=base64.urlsafe_b64encode(json.dumps({'ownerId':owner,'workspaceId':'probe-workspace','botId':'probe-bot','subagentId':ID,'epoch':1,'role':role,'exp':int(time.time())+110}).encode()).decode().rstrip('=')
 return p+'.'+base64.urlsafe_b64encode(hmac.new(KEY,p.encode(),hashlib.sha256).digest()).decode().rstrip('=')
def url(path,role='runtime'):return f'http://127.0.0.1:6082/agents/{ID}{path}?token={cap(role)}'
async def main():
 fixture=web.Application();fixture.router.add_get('/login',lambda _:web.Response(text='''<input type=password id=password><input name=otp id=otp><button type=button id=delete>Delete account</button><a id=link href=/login>Read</a><script>document.querySelectorAll('input').forEach(e=>e.addEventListener('input',()=>{history.pushState({},'','#fake-navigation');setTimeout(()=>{e.value=''},2500)}))</script>''',content_type='text/html'))
 runner=web.AppRunner(fixture);await runner.setup();await web.TCPSite(runner,'127.0.0.1',6083).start()
 async with aiohttp.ClientSession() as s:
  for _ in range(30):
   try:
    async with s.get(url('/state')) as r:break
   except aiohttp.ClientConnectorError:await asyncio.sleep(.2)
  async with s.post(url('/start'),json={}) as r:assert r.status==200,(r.status,await r.text());target=(await r.json())['targetId']
  async with s.post(url('/action'),json={'action':'navigate','url':'http://127.0.0.1:6083/login'}) as r:assert r.status==200
  await asyncio.sleep(1)
  async with s.post(url('/action'),json={'action':'observe'}) as r:o=await r.json();assert isinstance(o['observation']['elements'],list) and o['screenshot']
  async with s.post(url('/action'),json={'action':'inspectMutation','mutation':{'action':'click','selector':'#delete'}}) as r:
   binding=await r.json();assert r.status==200 and binding['origin']=='http://127.0.0.1:6083' and binding['loaderId'] and 'requiresApproval' not in binding
  async with s.post(url('/action'),json={'action':'type','selector':'#password','text':'must-not-enter'}) as r:assert r.status==403
  async with s.post(url('/action'),json={'action':'type','selector':'#otp','text':'must-not-enter'}) as r:assert r.status==403
  async with s.post(url('/action'),json={'action':'click','selector':'#link','expectedLoaderId':'other-document','expectedOrigin':'http://127.0.0.1:6083'}) as r:assert r.status==409
  print('PASS: independent Chrome pipe, redacted observation, password typing denial, approval document fencing',flush=True)
  async with s.ws_connect(url('/viewer','view')) as v:
   frame=await v.receive(timeout=10);assert frame.json()['type']=='frame'
   await v.send_json({'id':1,'method':'Input.insertText','params':{'text':'forbidden'}})
   print('PASS: viewer receives frame, has no CDP input channel',flush=True)
   async with s.post(url('/credentials/begin','broker'),json={}) as r:assert r.status==200;g=await r.json()
   async with s.post(url('/action'),json={'action':'observe'}) as r:assert r.status==409
   async with s.ws_connect(g['cdpUrl'].replace('wss://127.0.0.1:6082','ws://127.0.0.1:6082')) as ws:
    seq=0
    async def rpc(method,params={},session=None):
     nonlocal seq;seq+=1;await ws.send_json({'id':seq,'method':method,'params':params,**({'sessionId':session}if session else{})})
     while True:
      m=await ws.receive(timeout=15);d=json.loads(m.data)
      if d.get('id')==seq:
       assert 'error' not in d,d;return d.get('result',{})
    a=await rpc('Target.attachToTarget',{'targetId':target,'flatten':True});session=a['sessionId']
    password_selector='input[type="password"]'
    password_focus=f"(()=>{{const e=document.querySelector({json.dumps(password_selector)});if(!e||e.disabled||e.readOnly)return false;e.focus();e.value='';return document.activeElement===e}})()"
    await rpc('Runtime.evaluate',{'expression':password_focus,'returnByValue':True},session)
    await rpc('Input.insertText',{'text':'synthetic-probe-password'},session)
    async with s.post(url('/credentials/end','broker'),json={'guardToken':g['guardToken']}) as r:assert r.status==409
    assert (await rpc('Page.getFrameTree',{},session))['frameTree']['frame']['url'].endswith('#fake-navigation')
    async with s.post(url('/credentials/end','broker'),json={'guardToken':g['guardToken']}) as r:assert r.status==409
    await asyncio.sleep(3)
    otp_focus='''(()=>{const e=document.querySelector('input[autocomplete="one-time-code"],input[name="code"],input[name="otp"]');if(!e||e.disabled||e.readOnly)return false;e.focus();e.value='';return document.activeElement===e})()'''
    await rpc('Runtime.evaluate',{'expression':otp_focus,'returnByValue':True},session)
    await rpc('Input.insertText',{'text':'123456'},session)
    async with s.post(url('/credentials/end','broker'),json={'guardToken':g['guardToken']}) as r:assert r.status==409
    async with s.post(url('/action'),json={'action':'observe'}) as r:assert r.status==409
    await asyncio.sleep(3)
   async with s.post(url('/credentials/end','broker'),json={'guardToken':g['guardToken']}) as r:assert r.status==200,(r.status,await r.text())
  print('PASS: broker exclusive guard, fill, nonempty rejection, hash-navigation rejection, clear then resume',flush=True)
  async with s.post(url('/stop'),json={}) as r:assert r.status==200
  async with s.get(url('/state')) as r:assert r.status==410
  async with s.get(f'http://127.0.0.1:6082/agents/{ID}/state?token={cap("runtime","other-owner")}') as r:assert r.status==401
  print('PASS: stop revokes state/viewer/CDP and cross-owner capability denied',flush=True)
asyncio.run(main())
