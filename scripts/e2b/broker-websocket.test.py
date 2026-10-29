"""Real local Chromium and WebSocket regression; all data is synthetic."""
import asyncio, base64, hashlib, hmac, importlib.util, json, os, signal, shutil, ssl, subprocess, tempfile, time, uuid
from pathlib import Path
from aiohttp import ClientSession, WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer

spec=importlib.util.spec_from_file_location('gateway',Path(__file__).with_name('subagent-gateway.py'))
gateway=importlib.util.module_from_spec(spec);spec.loader.exec_module(gateway)

async def main():
    chromium=shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser')
    if not chromium:raise RuntimeError('Chromium is required')
    with tempfile.TemporaryDirectory(prefix='pr346-broker-') as directory:
        path=Path(directory)
        fixture=web.Application()
        async def login(_request):
            result=web.Response(text='<form><input name="username" autocomplete="username"><input type="password"><button>Log in</button></form><input name="otp">',content_type='text/html')
            result.set_cookie('synthetic_session','synthetic',httponly=True,path='/')
            return result
        fixture.router.add_get('/login',login)
        # A one-use, local-only test certificate makes the broker exercise its
        # real HTTPS origin contract. No account or provider credential is used.
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-keyout',str(path/'key.pem'),'-out',str(path/'cert.pem')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(path/'cert.pem',path/'key.pem')
        fixture_runner=web.AppRunner(fixture);await fixture_runner.setup()
        fixture_site=web.TCPSite(fixture_runner,'127.0.0.1',0,ssl_context=tls);await fixture_site.start()
        fixture_port=fixture_site._server.sockets[0].getsockname()[1]
        origin=f'https://127.0.0.1:{fixture_port}'
        process=await asyncio.create_subprocess_exec(chromium,'--headless','--no-sandbox','--disable-gpu','--no-first-run','--ignore-certificate-errors','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',f'--user-data-dir={path}/chrome','about:blank',start_new_session=True,stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
        try:
            active=path/'chrome'/'DevToolsActivePort'
            for _ in range(150):
                if active.exists():break
                if process.returncode is not None:raise RuntimeError('Chromium exited')
                await asyncio.sleep(.1)
            else:raise RuntimeError('Chromium did not start')
            port=int(active.read_text().splitlines()[0])
            async with ClientSession() as http:
                async with http.get(f'http://127.0.0.1:{port}/json/version') as response:version=await response.json()
                async with http.put(f'http://127.0.0.1:{port}/json/new?{origin}/login') as response:target=(await response.json())['id']
                internal=await http.ws_connect(version['webSocketDebuggerUrl'])
                await internal.send_json({'id':100,'method':'Target.attachToTarget','params':{'targetId':target,'flatten':True}})
                while True:
                    message=await internal.receive_json(timeout=10)
                    if message.get('id')==100:control_session=message['result']['sessionId'];break
                async def bridge(reader,writer):
                    async with http.ws_connect(version['webSocketDebuggerUrl']) as chrome:
                        async def send():
                            while line:=await reader.readline():await chrome.send_str(line.decode().strip())
                        async def receive():
                            async for msg in chrome:
                                if msg.type==WSMsgType.TEXT:writer.write((msg.data+'\n').encode());await writer.drain()
                        tasks=[asyncio.create_task(send()),asyncio.create_task(receive())]
                        try:await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
                        finally:
                            for task in tasks:task.cancel()
                            await asyncio.gather(*tasks,return_exceptions=True)
                            writer.close();await writer.wait_closed()
                unix=await asyncio.start_unix_server(bridge,path=str(path/'cdp.sock'))
                grant={'subagentId':'case','ownerId':'owner','workspaceId':'workspace','botId':'bot','epoch':1,'role':'broker','exp':9999999999}
                class Browser:
                    guard=None;guard_origin=origin;stopped=False;session=control_session
                    def __init__(self):self.path=path;self.target=target;self.grant=grant;self.override_url=None;self.seq=100;self.lock=asyncio.Lock();self.guard_file=path/'guard';self.frame=None;self.viewer=set()
                    async def rpc(self,method,params=None,session=None):
                        self.seq+=1;ident=self.seq
                        await internal.send_json({'id':ident,'method':method,'params':params or {},'sessionId':session or self.session})
                        while True:
                            data=await internal.receive_json(timeout=10)
                            if data.get('id')==ident:
                                assert 'error' not in data
                                return data['result']
                    async def url(self):return self.override_url or (await self.rpc('Page.getFrameTree'))['frameTree']['frame']['url']
                browser=Browser();gateway.AGENTS['case']=browser
                for _ in range(100):
                    if gateway.browser_origin(await browser.url())==origin:
                        ready=await browser.rpc('Runtime.evaluate',{'expression':'document.readyState','returnByValue':True})
                        if ready.get('result',{}).get('value')=='complete':break
                    await asyncio.sleep(.05)
                else:raise AssertionError('synthetic HTTPS fixture did not finish loading')
                authority=path/'authority';authority.mkdir();(authority/'key').write_bytes(os.urandom(32));(authority/'owner').write_text('owner');gateway.ROOT=authority
                def issue(role='broker',action=None,**changes):
                    payload={**grant,'role':role,'exp':int(time.time())+90,**changes}
                    if action is not None:payload['credentialAction']=action
                    raw=base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
                    signature=base64.urlsafe_b64encode(hmac.new((authority/'key').read_bytes(),raw.encode(),hashlib.sha256).digest()).decode().rstrip('=')
                    return raw+'.'+signature
                app=web.Application()
                for suffix,handler,method in [('cdp',gateway.cdp,'GET'),('begin',gateway.begin,'POST'),('observe',gateway.observe_credentials,'GET'),('continue',gateway.continue_credentials,'POST')]:app.router.add_route(method,'/agents/{id}/credentials/'+suffix,handler)
                app.router.add_get('/agents/{id}/state',gateway.state);app.router.add_post('/agents/{id}/action',gateway.action)
                async with TestClient(TestServer(app)) as client:
                    async def post(path,role='broker',action=None,**changes):
                        async with client.post('/agents/case/'+path+'?token='+issue(role,action,**changes),json={}) as response:return response.status,await response.text()
                    async def observe():
                        async with client.get('/agents/case/credentials/observe?token='+issue('runtime')) as response:
                            assert response.status==200, await response.text()
                            return await response.json()
                    async def evaluate(expression):return (await browser.rpc('Runtime.evaluate',{'expression':expression,'returnByValue':True}))['result'].get('value')
                    async def response(ws,ident):
                        while True:
                            message=await ws.receive(timeout=10)
                            if message.type!=WSMsgType.TEXT:raise AssertionError('unexpected socket close')
                            data=json.loads(message.data)
                            if data.get('id')==ident:
                                assert 'error' not in data, data
                                return data['result']
                    async def attach(ws):
                        await ws.send_json({'id':1,'method':'Target.attachToTarget','params':{'targetId':target,'flatten':True}})
                        return (await response(ws,1))['sessionId']
                    async def fill(observed):
                        endpoint='/agents/case/credentials/cdp?token='+issue()+'&guard='+browser.guard
                        async with client.ws_connect(endpoint) as ws:
                            session=await attach(ws)
                            for index,node in enumerate(observed['inputs']):
                                ident=10+index*10
                                await ws.send_json({'id':ident,'method':'DOM.focus','params':{'backendNodeId':node['backendNodeId']},'sessionId':session});await response(ws,ident)
                                await ws.send_json({'id':ident+1,'method':'Runtime.evaluate','params':{'expression':'document.activeElement','returnByValue':False},'sessionId':session});obj=(await response(ws,ident+1))['result']['objectId']
                                await ws.send_json({'id':ident+2,'method':'DOM.describeNode','params':{'objectId':obj},'sessionId':session});assert (await response(ws,ident+2))['node']['backendNodeId']==node['backendNodeId']
                                await ws.send_json({'id':ident+3,'method':'Input.insertText','params':{'text':'synthetic-'+node['credentialRole']},'sessionId':session});await response(ws,ident+3)
                    async def denied(command):
                        endpoint='/agents/case/credentials/cdp?token='+issue()+'&guard='+browser.guard
                        async with client.ws_connect(endpoint) as ws:
                            session=await attach(ws);command.setdefault('sessionId',session)
                            await ws.send_json(command)
                            while True:
                                msg=await ws.receive(timeout=10)
                                if msg.type in (WSMsgType.CLOSE,WSMsgType.CLOSED):break
                                assert msg.type==WSMsgType.TEXT and 'id' not in json.loads(msg.data)
                    def plan(observed,operation='clear'):
                        return {'actionId':str(uuid.uuid4()),'operation':operation,'targetId':observed['targetId'],'origin':observed['origin'],'loaderId':observed['loaderId'],'inputs':observed['inputs']}
                    async def begin_fill():
                        observed=await observe();assert [item['credentialRole'] for item in observed['inputs']]==['username','password']
                        assert (await post('credentials/begin'))[0]==200
                        await fill(observed)
                        return observed
                    # A role, identity, epoch or expiry mismatch cannot gain the runtime surface.
                    for role in ['broker','view','credential-continuation']:
                        async with client.get('/agents/case/credentials/observe?token='+issue(role)) as result:assert result.status==401
                    async with client.get('/agents/case/credentials/observe?token='+issue('runtime',exp=1)) as result:assert result.status==401
                    async with client.get('/agents/case/credentials/observe?token='+issue('runtime',epoch=2)) as result:assert result.status==404
                    for injection in ["document.body.insertAdjacentHTML('beforeend','<iframe id=unsafe-test></iframe>')", "(()=>{const e=document.createElement('div');e.id='unsafe-test';document.body.append(e);e.attachShadow({mode:'closed'}).innerHTML='<input>'})()", "document.body.insertAdjacentHTML('beforeend','<input id=unsafe-test type=password>')"]:
                        await evaluate(injection)
                        async with client.get('/agents/case/credentials/observe?token='+issue('runtime')) as result:assert result.status==409
                        await evaluate("document.querySelector('#unsafe-test').remove()")
                    await evaluate("document.querySelector('input[type=password]').value='synthetic-existing'")
                    async with client.get('/agents/case/credentials/observe?token='+issue('runtime')) as result:assert result.status==409
                    await evaluate("document.querySelector('input[type=password]').value=''")
                    observed=await begin_fill();assert browser.guard_file.exists()
                    assert await evaluate("document.querySelector('input[type=password]').value")=='synthetic-password'
                    async with client.get('/agents/case/state?token='+issue('runtime')) as result:assert (await result.json())['url'] is None
                    assert (await post('action','runtime'))[0]==409
                    for role in ['broker','runtime','view']:assert (await post('credentials/continue',role,plan(observed)))[0]==401
                    for key,value in [('targetId','wrong'),('loaderId','old'),('origin','https://other.invalid'),('inputs',[{'backendNodeId':1,'credentialRole':'password'}])]:
                        wrong={**plan(observed),key:value};assert (await post('credentials/continue','credential-continuation',wrong))[0]==409
                    for command in [
                        {'id':3,'method':'Runtime.evaluate','params':{'expression':'document.cookie','returnByValue':True}},
                        {'id':3,'method':'Runtime.evaluate','params':{'expression':next(e for e in gateway.BROKER_EVALUATIONS if 'requestSubmit' in e),'returnByValue':True}},
                        {'id':3,'method':'DOM.focus','params':{'backendNodeId':9999999}},
                        {'id':3,'method':'Input.insertText','params':{'text':'synthetic'}},
                        {'id':3,'method':'Network.getCookies','params':{'urls':['https://other.invalid']}},
                        {'id':3,'method':'Network.setCookies','params':{'cookies':[{'name':'s','value':'synthetic','domain':'other.invalid'}]}},
                        {'id':3,'method':'Runtime.compileScript','params':{'expression':'document.cookie'}},
                    ]:await denied(command)
                    # Retain the original broker/session regression coverage.
                    endpoint='/agents/case/credentials/cdp?token='+issue()+'&guard='+browser.guard
                    async with client.ws_connect(endpoint) as ws:
                        session=await attach(ws)
                        await ws.send_json({'id':2,'method':'Runtime.evaluate','params':{'expression':'globalThis','returnByValue':False},'sessionId':session})
                        obj=(await response(ws,2))['result']['objectId']
                        await ws.send_json({'id':3,'method':'Runtime.callFunctionOn','params':{'objectId':obj,'functionDeclaration':gateway.BROKER_STORAGE_FUNCTION,'arguments':[{'value':[['synthetic','value']]}],'returnByValue':True},'sessionId':session});await response(ws,3)
                        await ws.send_json({'id':4,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':True},'sessionId':session})
                        assert ['synthetic','value'] in (await response(ws,4))['result']['value']
                        await ws.send_json({'id':5,'method':'Network.getCookies','params':{'urls':[origin]},'sessionId':session})
                        cookies=(await response(ws,5))['cookies'];assert any(item['name']=='synthetic_session' for item in cookies)
                        await ws.send_json({'id':6,'method':'Network.setCookies','params':{'cookies':cookies},'sessionId':session});await response(ws,6)
                    for params in [{'targetId':'wrong','flatten':True},{'targetId':target,'flatten':True,'extra':True}]:
                        async with client.ws_connect(endpoint) as ws:
                            await ws.send_json({'id':1,'method':'Target.attachToTarget','params':params})
                            assert (await ws.receive(timeout=10)).type in (WSMsgType.CLOSE,WSMsgType.CLOSED)
                    for command in [
                        {'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage);alert(1)','returnByValue':True}},
                        {'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':True,'awaitPromise':True}},
                        {'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':False}},
                        {'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':True},'sessionId':'old-session'},
                        {'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':True},'extra':'injected'},
                        {'id':3,'method':'Runtime.callFunctionOn','params':{'objectId':'unknown','functionDeclaration':gateway.BROKER_STORAGE_FUNCTION,'arguments':[{'value':[]}],'returnByValue':True}},
                    ]:await denied(command)
                    # A changed active node or newly uninspectable document must
                    # not inherit a previously observed node's insert authority.
                    async def deny_after_focus(injection):
                        async with client.ws_connect(endpoint) as ws:
                            session=await attach(ws)
                            await ws.send_json({'id':2,'method':'DOM.focus','params':{'backendNodeId':observed['inputs'][0]['backendNodeId']},'sessionId':session});await response(ws,2)
                            await evaluate(injection)
                            await ws.send_json({'id':3,'method':'Input.insertText','params':{'text':'synthetic'},'sessionId':session})
                            while True:
                                msg=await ws.receive(timeout=10)
                                if msg.type in (WSMsgType.CLOSE,WSMsgType.CLOSED):break
                                assert msg.type==WSMsgType.TEXT and 'id' not in json.loads(msg.data)
                    await deny_after_focus("document.querySelector('input[type=password]').focus()")
                    for injection in ["document.body.insertAdjacentHTML('beforeend','<iframe id=unsafe-test></iframe>')", "(()=>{const e=document.createElement('div');e.id='unsafe-test';document.body.append(e);e.attachShadow({mode:'closed'}).innerHTML='<input>'})()"]:
                        await deny_after_focus(injection);await evaluate("document.querySelector('#unsafe-test').remove()")
                    clear=plan(observed);status,body=await post('credentials/continue','credential-continuation',clear);assert status==200 and json.loads(body)['resumed'] is True,body
                    assert not browser.guard and not browser.guard_file.exists()
                    assert await evaluate("[...document.querySelectorAll('input')].every(e=>!e.value)") is True
                    assert (await post('credentials/continue','credential-continuation',clear))[0]==409
                    # Same-origin submission is a separate consumed action; this
                    # local handler records invocation without any remote account.
                    await evaluate("document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submissions=(window.submissions||0)+1;document.querySelectorAll('input').forEach(n=>n.value='')})")
                    observed=await begin_fill();submit=plan(observed,'submit')
                    status,body=await post('credentials/continue','credential-continuation',submit);assert status==200 and json.loads(body)['resumed'] is True,body
                    assert await evaluate('window.submissions')==1
                    assert (await post('credentials/continue','credential-continuation',submit))[0]==409
                    assert await evaluate('window.submissions')==1
                    # A form that remains populated cannot release the screen.
                    await evaluate("document.querySelector('form').outerHTML='<form onsubmit=event.preventDefault()><input name=username><input type=password></form>'")
                    observed=await begin_fill();submit=plan(observed,'submit')
                    status,body=await post('credentials/continue','credential-continuation',submit);assert status==200 and json.loads(body)['resumed'] is False
                    assert browser.guard and browser.guard_file.exists()
                    assert (await post('credentials/continue','credential-continuation',submit))[0]==409
                    status,body=await post('credentials/continue','credential-continuation',plan(observed));assert status==200 and json.loads(body)['resumed'] is True
                    # A cross-origin form action is rejected and stays hidden.
                    await evaluate("document.querySelector('form').action='https://other.invalid'")
                    observed=await begin_fill();assert (await post('credentials/continue','credential-continuation',plan(observed,'submit')))[0]==409
                    assert browser.guard
                    assert (await post('credentials/continue','credential-continuation',plan(observed)))[0]==200
                    # A changed loader cannot submit stale nodes; explicit Clear
                    # may release an already-empty, inspected same-origin page.
                    observed=await begin_fill();await browser.rpc('Page.reload')
                    for _ in range(100):
                        frame=(await browser.rpc('Page.getFrameTree'))['frameTree']['frame']
                        if frame['loaderId']!=observed['loaderId'] and await evaluate('document.readyState')=='complete':break
                        await asyncio.sleep(.05)
                    assert (await post('credentials/continue','credential-continuation',plan(observed,'submit')))[0]==409
                    status,body=await post('credentials/continue','credential-continuation',plan(observed));assert status==200 and json.loads(body)['resumed'] is True
                    screenshot=await browser.rpc('Page.captureScreenshot',{'format':'png'})
                    (Path('/home/user/workspace')/'pr345-isolated-credential-clear.png').write_bytes(base64.b64decode(screenshot['data']))
                    # Restart's persisted guard never unlocks from old claims.
                    observed=await begin_fill();original=browser.guard;browser.guard='locked'
                    assert (await post('credentials/continue','credential-continuation',plan(observed)))[0]==409
                    browser.guard=original
                    assert (await post('credentials/continue','credential-continuation',plan(observed)))[0]==200
                await internal.close()
                unix.close();await unix.wait_closed()
            print('PASS: isolated HTTPS Chromium + signed gateway: observed nodes, guarded fill, separate one-shot submit/clear, replay/stale loader/origin/role/epoch/expiry/script rejection, hidden unsafe pages; no real service authentication')
        finally:
            # Chromium's browser PID may exit before its profile-writing children.
            # Only signal this test's private process group, never other lanes.
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            await process.wait()
            for _ in range(100):
                try:os.killpg(process.pid,0)
                except ProcessLookupError:break
                await asyncio.sleep(.05)
            else:
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                await asyncio.sleep(.2)
            await fixture_runner.cleanup()

asyncio.run(main())
