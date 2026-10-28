"""Real local Chromium and WebSocket regression; all data is synthetic."""
import asyncio, importlib.util, json, shutil, ssl, subprocess, tempfile
from pathlib import Path
from aiohttp import ClientSession, WSMsgType, WSServerHandshakeError, web
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
            result=web.Response(text='''<input name="username"><input type="password"><input name="otp"><script>
              window.focusHijacked=false;window.inputEvents=0;
              const user=document.querySelector('input[name=username]');
              user.addEventListener('focus',()=>{window.focusHijacked=true;document.querySelector('input[type=password]').focus()});
              user.addEventListener('input',()=>window.inputEvents++);
            </script>''',content_type='text/html')
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
        process=await asyncio.create_subprocess_exec(chromium,'--headless','--no-sandbox','--disable-gpu','--no-first-run','--ignore-certificate-errors','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',f'--user-data-dir={path}/chrome','about:blank',stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
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
                gateway.authorize=lambda request,role:('synthetic',grant)
                gateway.token=lambda raw,role:grant
                app=web.Application();app.router.add_get('/agents/{id}/credentials/cdp',gateway.cdp);app.router.add_post('/agents/{id}/credentials/begin',gateway.begin);app.router.add_post('/agents/{id}/credentials/end',gateway.end)
                async with TestClient(TestServer(app)) as client:
                    await browser.rpc('Runtime.evaluate',{'expression':"(()=>{const e=document.createElement('iframe');e.id='unsafe-test';document.body.append(e)})()",'returnByValue':True})
                    async with client.post('/agents/case/credentials/begin?token=synthetic') as denied_begin:assert denied_begin.status==409
                    assert browser.guard and browser.guard_file.exists(), 'failed begin must stay guarded'
                    await browser.rpc('Runtime.evaluate',{'expression':"document.querySelector('#unsafe-test').remove()",'returnByValue':True})
                    browser.guard=None;browser.guard_file.unlink()
                    async with client.post('/agents/case/credentials/begin?token=synthetic') as accepted_begin:
                        assert accepted_begin.status==200
                        token=(await accepted_begin.json())['guardToken']
                    endpoint=f'/agents/case/credentials/cdp?guard={token}'
                    async def response(ws,ident):
                        while True:
                            message=await ws.receive(timeout=10)
                            if message.type!=WSMsgType.TEXT:raise AssertionError('unexpected socket close')
                            data=json.loads(message.data)
                            if data.get('id')==ident:
                                assert 'error' not in data
                                return data['result']
                    async def attach(ws):
                        await ws.send_json({'id':1,'method':'Target.attachToTarget','params':{'targetId':target,'flatten':True}})
                        return (await response(ws,1))['sessionId']
                    async def denied(command,prepare=False):
                        async with client.ws_connect(endpoint) as ws:
                            session=await attach(ws)
                            if prepare:
                                await ws.send_json({'id':2,'method':'Runtime.evaluate','params':{'expression':'globalThis','returnByValue':False},'sessionId':session})
                                obj=(await response(ws,2))['result']['objectId'];command['params']['objectId']=obj
                            command.setdefault('sessionId',session)
                            await ws.send_json(command)
                            while True:
                                msg=await ws.receive(timeout=10)
                                if msg.type in (WSMsgType.CLOSE,WSMsgType.CLOSED):break
                                assert msg.type==WSMsgType.TEXT and 'id' not in json.loads(msg.data)
                    endpoint_url=str(client.make_url(endpoint)).replace('http://','ws://',1)
                    node=await asyncio.create_subprocess_exec('node','--import','tsx',str(Path(__file__).with_name('broker-real-client.test.mjs')),endpoint_url,target,origin,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
                    stdout,stderr=await asyncio.wait_for(node.communicate(),30)
                    if node.returncode:raise RuntimeError('Actual broker client failed: '+stderr.decode())
                    assert stdout.decode().startswith('PASS: actual broker client')
                    async with client.ws_connect(endpoint) as ws:
                        session=await attach(ws)
                        try:
                            await client.ws_connect(endpoint)
                            raise AssertionError('second broker session must be refused')
                        except WSServerHandshakeError as error:
                            assert error.status==409
                        focus=next(expr for expr,selector in gateway.BROKER_FOCUS_EXPRESSIONS.items() if selector==gateway.BROKER_FOCUS_SELECTORS[0])
                        await ws.send_json({'id':5,'method':'Runtime.evaluate','params':{'expression':focus,'returnByValue':True},'sessionId':session})
                        assert (await response(ws,5))['result']['value'] is True
                        async with client.post('/agents/case/credentials/end?token=synthetic',json={'guardToken':token}) as guarded_end:
                            assert guarded_end.status==409, 'cannot release guard while scripts are frozen'
                        await ws.send_json({'id':6,'method':'Input.insertText','params':{'text':'synthetic-user'},'sessionId':session});await response(ws,6)
                        result=await browser.rpc('Runtime.evaluate',{'expression':'document.querySelector("input[name=username]").value','returnByValue':True})
                        assert result['result']['value']=='synthetic-user'
                        events=await browser.rpc('Runtime.evaluate',{'expression':'({focusHijacked:window.focusHijacked,inputEvents:window.inputEvents})','returnByValue':True})
                        assert events['result']['value']=={'focusHijacked':False,'inputEvents':1}, 'focus callbacks stay frozen; one input event reaches the page after resume'
                        for ident,selector,value in [(10,gateway.BROKER_FOCUS_SELECTORS[1],'synthetic-password'),(20,gateway.BROKER_OTP_SELECTOR,'123456')]:
                            expression=next(expr for expr,selected in gateway.BROKER_FOCUS_EXPRESSIONS.items() if selected==selector)
                            await ws.send_json({'id':ident,'method':'Runtime.evaluate','params':{'expression':expression,'returnByValue':True},'sessionId':session})
                            assert (await response(ws,ident))['result']['value'] is True
                            await ws.send_json({'id':ident+1,'method':'Input.insertText','params':{'text':value},'sessionId':session});await response(ws,ident+1)
                            result=await browser.rpc('Runtime.evaluate',{'expression':f'document.querySelector({json.dumps(selector)}).value','returnByValue':True})
                            assert result['result']['value']==value
                        await ws.send_json({'id':2,'method':'Runtime.evaluate','params':{'expression':'globalThis','returnByValue':False},'sessionId':session})
                        obj=(await response(ws,2))['result']['objectId']
                        params={'objectId':obj,'functionDeclaration':gateway.BROKER_STORAGE_FUNCTION,'arguments':[{'value':[['synthetic','value']]}],'returnByValue':True}
                        await ws.send_json({'id':3,'method':'Runtime.callFunctionOn','params':params,'sessionId':session});await response(ws,3)
                        await ws.send_json({'id':4,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':True},'sessionId':session})
                        assert ['synthetic','value'] in (await response(ws,4))['result']['value']
                        await ws.send_json({'id':8,'method':'Network.getCookies','params':{'urls':[origin]},'sessionId':session})
                        cookies=(await response(ws,8))['cookies'];assert any(item['name']=='synthetic_session' for item in cookies)
                        await ws.send_json({'id':7,'method':'Network.setCookies','params':{'cookies':cookies},'sessionId':session});await response(ws,7)
                    for _ in range(100):
                        if not browser.broker_active:break
                        await asyncio.sleep(.01)
                    assert not browser.broker_active
                    async with client.ws_connect(endpoint) as ws:
                        await ws.send_json({'id':1,'method':'Target.attachToTarget','params':{'targetId':'wrong','flatten':True}})
                        assert (await ws.receive(timeout=10)).type in (WSMsgType.CLOSE,WSMsgType.CLOSED)
                    async with client.ws_connect(endpoint) as ws:
                        await ws.send_json({'id':1,'method':'Target.attachToTarget','params':{'targetId':target,'flatten':True,'extra':True}})
                        assert (await ws.receive(timeout=10)).type in (WSMsgType.CLOSE,WSMsgType.CLOSED)
                    await denied({'id':3,'method':'Runtime.evaluate','params':{'expression':'document.cookie','returnByValue':True}})
                    await denied({'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage);alert(1)','returnByValue':True}})
                    await denied({'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':True,'awaitPromise':True}})
                    await denied({'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':False}})
                    await denied({'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':True},'sessionId':'old-session'})
                    await denied({'id':3,'method':'Runtime.compileScript','params':{'expression':'document.cookie'}})
                    await denied({'id':3,'method':'Input.insertText','params':{'text':'synthetic'}})
                    await denied({'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':True},'extra':'injected'})
                    await denied({'id':3,'method':'Runtime.callFunctionOn','params':{'objectId':'ignored','functionDeclaration':'function(){return document.cookie}','arguments':[{'value':[]}],'returnByValue':True}},True)
                    await denied({'id':3,'method':'Runtime.callFunctionOn','params':{'objectId':'ignored','functionDeclaration':gateway.BROKER_STORAGE_FUNCTION,'arguments':[{'value':[],'objectId':'injected'}],'returnByValue':True}},True)
                    await denied({'id':3,'method':'Runtime.callFunctionOn','params':{'objectId':'unknown','functionDeclaration':gateway.BROKER_STORAGE_FUNCTION,'arguments':[{'value':[]}],'returnByValue':True}})
                    await denied({'id':3,'method':'Network.getCookies','params':{'urls':['https://other.invalid']}})
                    await denied({'id':3,'method':'Network.setCookies','params':{'cookies':[{'name':'s','value':'synthetic','domain':'other.invalid'}]}})
                    async with client.ws_connect(endpoint) as ws:
                        session=await attach(ws)
                        focus=next(expr for expr,selector in gateway.BROKER_FOCUS_EXPRESSIONS.items() if selector==gateway.BROKER_FOCUS_SELECTORS[0])
                        await ws.send_json({'id':2,'method':'Runtime.evaluate','params':{'expression':focus,'returnByValue':True},'sessionId':session});await response(ws,2)
                        await browser.rpc('Runtime.evaluate',{'expression':'document.querySelector("input[type=password]").focus()','returnByValue':True})
                        await ws.send_json({'id':3,'method':'Input.insertText','params':{'text':'synthetic'},'sessionId':session})
                        while True:
                            msg=await ws.receive(timeout=10)
                            if msg.type in (WSMsgType.CLOSE,WSMsgType.CLOSED):break
                            assert msg.type==WSMsgType.TEXT and 'id' not in json.loads(msg.data)
                    for injection in (
                        "(()=>{const e=document.createElement('iframe');e.id='unsafe-test';document.body.append(e)})()",
                        "(()=>{const e=document.createElement('div');e.id='unsafe-test';document.body.append(e);e.attachShadow({mode:'closed'}).innerHTML='<input>'})()",
                    ):
                        async with client.ws_connect(endpoint) as ws:
                            session=await attach(ws)
                            focus=next(expr for expr,selector in gateway.BROKER_FOCUS_EXPRESSIONS.items() if selector==gateway.BROKER_FOCUS_SELECTORS[0])
                            await ws.send_json({'id':2,'method':'Runtime.evaluate','params':{'expression':focus,'returnByValue':True},'sessionId':session});await response(ws,2)
                            await browser.rpc('Runtime.evaluate',{'expression':injection,'returnByValue':True})
                            await ws.send_json({'id':3,'method':'Input.insertText','params':{'text':'synthetic'},'sessionId':session})
                            while True:
                                msg=await ws.receive(timeout=10)
                                if msg.type in (WSMsgType.CLOSE,WSMsgType.CLOSED):break
                                assert msg.type==WSMsgType.TEXT and 'id' not in json.loads(msg.data)
                        await browser.rpc('Runtime.evaluate',{'expression':"document.querySelector('#unsafe-test').remove()",'returnByValue':True})
                    await browser.rpc('Page.navigate',{'url':f'https://localhost:{fixture_port}/login'})
                    for _ in range(100):
                        if gateway.browser_origin(await browser.url())!=origin:break
                        await asyncio.sleep(.05)
                    else:raise AssertionError('synthetic cross-origin navigation did not complete')
                    await denied({'id':3,'method':'Runtime.evaluate','params':{'expression':'Object.entries(localStorage)','returnByValue':True}})
                    await browser.rpc('Page.navigate',{'url':origin+'/login'})
                    for _ in range(100):
                        if gateway.browser_origin(await browser.url())==origin:break
                        await asyncio.sleep(.05)
                    else:raise AssertionError('synthetic return navigation did not complete')
                    async with client.ws_connect(endpoint) as ws:
                        session=await attach(ws)
                        async with http.get(f'http://127.0.0.1:{port}/json/close/{target}') as closed:assert closed.status==200
                        while True:
                            msg=await ws.receive(timeout=10)
                            if msg.type in (WSMsgType.CLOSE,WSMsgType.CLOSED):break
                            assert msg.type==WSMsgType.TEXT
                            event=json.loads(msg.data)
                            if event.get('method')=='Target.detachedFromTarget':
                                await ws.send_json({'id':9,'method':'Page.getFrameTree','params':{},'sessionId':session})
                                while (await ws.receive(timeout=10)).type==WSMsgType.TEXT:pass
                                break
                await internal.close()
                unix.close();await unix.wait_closed()
            print('PASS: real Chromium through local broker WebSocket: fixed templates and session storage; wrong target/session/origin, scripts and extra parameters rejected')
        finally:
            process.terminate();await process.wait();await fixture_runner.cleanup()

asyncio.run(main())
