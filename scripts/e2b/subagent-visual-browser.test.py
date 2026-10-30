"""Real Chromium + production gateway HTTP handlers; synthetic task and tokens.
The only substitute is VM provisioning: CDP is a real browser session. Retain
screenshots, action receipts and the test directory for inspection on failure.
"""
import asyncio, base64, hashlib, hmac, importlib.util, io, json, os, secrets, tempfile, time, unittest, uuid
from pathlib import Path
from aiohttp import web, ClientSession
from playwright.async_api import async_playwright
from PIL import Image

spec=importlib.util.spec_from_file_location('visual_gateway',Path(__file__).with_name('subagent-gateway.py'))
gateway=importlib.util.module_from_spec(spec);spec.loader.exec_module(gateway)

class VisualGatewayAcceptance(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory=Path(tempfile.mkdtemp(prefix='mikka-visual-browser-'))
        gateway.ROOT=self.directory
        self.key=secrets.token_bytes(32);(self.directory/'key').write_bytes(self.key);(self.directory/'owner').write_text('synthetic-owner')
        self.id=str(uuid.uuid4())
        self.grant={'ownerId':'synthetic-owner','workspaceId':str(uuid.uuid4()),'botId':str(uuid.uuid4()),'subagentId':self.id,'epoch':1,'role':'runtime','exp':int(time.time())+120}
        encoded=base64.urlsafe_b64encode(json.dumps(self.grant).encode()).decode().rstrip('=')
        self.token=encoded+'.'+base64.urlsafe_b64encode(hmac.new(self.key,encoded.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        self.playwright=await async_playwright().start()
        self.browser=await self.playwright.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        self.page=await self.browser.new_page(viewport={'width':1280,'height':800})
        self.cdp=await self.page.context.new_cdp_session(self.page)
        self.b=gateway.Browser(self.grant);self.b.session='actual-target-session';self.b.target='actual-browser';self.b.stopped=False
        async def rpc(method,params=None,session=None):return await self.cdp.send(method,params or {})
        self.b.rpc=rpc
        async def url():return self.page.url
        self.b.url=url
        gateway.AGENTS[self.id]=self.b
        app=web.Application(client_max_size=16384);app.router.add_post('/agents/{id}/action',gateway.action)
        self.runner=web.AppRunner(app,access_log=None);await self.runner.setup();site=web.TCPSite(self.runner,'127.0.0.1',0);await site.start()
        self.endpoint=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/agents/{self.id}/action?token={self.token}'
        self.client=ClientSession()
        await self.page.set_content('''<html><body style="margin:0;background:white;height:3000px"><button id="go" style="position:absolute;left:40px;top:40px;width:120px;height:50px" onclick="window.count=(window.count||0)+1;document.querySelector('#result').innerText='count='+window.count+' trusted='+event.isTrusted">Continue</button><div id="result" style="position:absolute;top:5px">count=0</div><input id="text" style="position:absolute;left:40px;top:120px;width:300px;height:40px"><input type="password" value="synthetic-not-a-secret" style="position:absolute;left:40px;top:200px;width:300px;height:40px;background:red"><canvas id="canvas" width="200" height="100" style="position:absolute;left:400px;top:40px"></canvas><script>const c=document.querySelector('canvas').getContext('2d');c.fillStyle='blue';c.fillRect(0,0,200,100);c.fillStyle='white';c.fillText('Canvas control',15,50)</script></body></html>''')
    async def asyncTearDown(self):
        print('retained visual acceptance evidence: '+str(self.directory))
        gateway.AGENTS.pop(self.id,None)
        await self.client.close();await self.runner.cleanup();await self.browser.close();await self.playwright.stop()
    async def call(self,payload):
        async with self.client.post(self.endpoint,json=payload) as response:
            text=await response.text()
            return response.status,json.loads(text) if response.content_type=='application/json' else text
    async def observe(self):
        status,data=await self.call({'action':'observe'});self.assertEqual(status,200,data)
        image=base64.b64decode(data['screenshot'].split(',')[1]);self.assertTrue(image.startswith(b'\xff\xd8\xff'))
        (self.directory/(data['observationId']+'.jpg')).write_bytes(image)
        return data,image
    async def mutate(self,observation,action):
        payload={**action,'actionId':str(uuid.uuid4()),'expectedObservationId':observation['observationId']}
        status,result=await self.call(payload);self.assertEqual(status,200,result)
        return payload
    async def test_screenshot_real_input_replay_and_stale_fence(self):
        first,image=await self.observe()
        self.assertEqual((first['width'],first['height']),(1280,800))
        pixel=Image.open(io.BytesIO(image)).getpixel((150,220))
        self.assertTrue(all(channel>235 for channel in pixel),pixel) # password is hidden, not red.
        self.assertNotIn('synthetic-not-a-secret',json.dumps(first['observation']))
        payload=await self.mutate(first,{'action':'click','x':90,'y':65})
        self.assertEqual(await self.page.locator('#result').inner_text(),'count=1 trusted=true')
        status,_=await self.call(payload);self.assertEqual(status,200)
        self.assertEqual(await self.page.locator('#result').inner_text(),'count=1 trusted=true')
        status,_=await self.call({**payload,'actionId':str(uuid.uuid4())});self.assertEqual(status,409)
        status,_=await self.call({**payload,'x':500});self.assertEqual(status,409)
        focused,_=await self.observe();await self.mutate(focused,{'action':'click','x':100,'y':140})
        typing,_=await self.observe();await self.mutate(typing,{'action':'type','text':'unattended input'})
        self.assertEqual(await self.page.locator('#text').input_value(),'unattended input')
        screenshot,_=await self.observe();await self.page.evaluate('scrollTo(0,200)')
        status,_=await self.call({'action':'click','x':90,'y':65,'actionId':str(uuid.uuid4()),'expectedObservationId':screenshot['observationId']});self.assertEqual(status,409)
    async def test_guard_blocks_screenshot_and_typing_secrets_and_foreign_tokens(self):
        await self.page.locator('input[type=password]').focus()
        observation,_=await self.observe()
        status,_=await self.call({'action':'type','text':'do-not-insert','actionId':str(uuid.uuid4()),'expectedObservationId':observation['observationId']});self.assertEqual(status,403)
        self.b.guard='credential-insertion-active'
        status,_=await self.call({'action':'observe'});self.assertEqual(status,409)
        # Corrupt the payload; the signature's last base64url char may hold only ignored padding bits.
        bad=self.endpoint.replace('token=','token=x')
        async with self.client.post(bad,json={'action':'observe'}) as response:self.assertEqual(response.status,401)
    async def test_unknown_receipt_cannot_reexecute_and_scroll_is_real(self):
        observation,_=await self.observe()
        payload={'action':'click','x':90,'y':65,'actionId':str(uuid.uuid4()),'expectedObservationId':observation['observationId']}
        path,digest,_=gateway.action_receipt(self.b.path,payload['actionId'],payload)
        gateway.write_action_receipt(path,digest,'invoking')
        status,result=await self.call(payload);self.assertEqual(status,409);self.assertEqual(result,'action_outcome_unknown')
        self.assertEqual(await self.page.locator('#result').inner_text(),'count=0')
        await self.mutate(observation,{'action':'scroll','x':900,'y':500,'deltaX':0,'deltaY':400})
        await asyncio.sleep(.1);self.assertGreater(await self.page.evaluate('scrollY'),0)

if __name__=='__main__':unittest.main()
