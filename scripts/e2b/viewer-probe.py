"""Disposable sandbox acceptance: real RFB pixels, server-side view-only,
control, expiry, owner binding and live revocation. No provider/model tokens.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import struct
import subprocess
import time
from pathlib import Path
from aiohttp import ClientSession, WSServerHandshakeError

root = Path('/run/mikka-viewer')
state = {'botId': 'probe-bot', 'ownerId': 'probe-owner', 'display': 1,
         'epoch': 1, 'controlledBy': 'probe-owner', 'controlUntil': time.time()+240}

def sign(**changes):
    grant = {**state, 'userId': 'probe-owner', 'mode': 'view', 'exp': int(time.time())+120, **changes}
    payload = base64.urlsafe_b64encode(json.dumps(grant).encode()).rstrip(b'=')
    sig = hmac.new((root/'key').read_bytes(), payload, hashlib.sha256).digest()
    return (payload+b'.'+base64.urlsafe_b64encode(sig).rstrip(b'=')).decode()

def publish():
    (root/'1.next').write_text(json.dumps(state))
    (root/'1.next').replace(root/'1.json')

def mouse():
    output = subprocess.check_output(['xdotool','getmouselocation','--shell'],env={**os.environ,'DISPLAY':':1'}).decode()
    return dict(line.split('=') for line in output.strip().splitlines())

class RFB:
    def __init__(self, ws): self.ws, self.buffer = ws, b''
    async def read(self, n):
        while len(self.buffer)<n:
            self.buffer += await self.ws.receive_bytes(timeout=10)
        result,self.buffer=self.buffer[:n],self.buffer[n:]
        return result
    async def handshake(self):
        assert (await self.read(12)).startswith(b'RFB 003.')
        await self.ws.send_bytes(b'RFB 003.008\n')
        count=(await self.read(1))[0]
        assert 1 in await self.read(count)
        await self.ws.send_bytes(b'\x01')
        assert await self.read(4)==b'\0\0\0\0'
        await self.ws.send_bytes(b'\x01')
        init=await self.read(24)
        self.width,self.height=struct.unpack('>HH',init[:4])
        self.bpp=init[4]
        await self.read(struct.unpack('>I',init[20:24])[0])
        assert (self.width,self.height)==(1280,800)
    async def pixels(self):
        await self.ws.send_bytes(struct.pack('>BBHi',2,0,1,0))
        await self.ws.send_bytes(struct.pack('>BBHHHH',3,0,0,0,1280,800))
        header=await self.read(4)
        assert header[0]==0 and struct.unpack('>H',header[2:])[0]>0
        rect=await self.read(12)
        _,_,w,h,encoding=struct.unpack('>HHHHi',rect)
        assert encoding==0
        pixels=await self.read(w*h*self.bpp//8)
        assert len(pixels)>1000
    async def pointer(self,x,y): await self.ws.send_bytes(struct.pack('>BBHH',5,0,x,y))

async def main():
    publish()
    async with ClientSession() as session:
        for token in ['',sign(exp=1),sign(ownerId='someone-else'),sign(mode='control',userId='someone-else'),sign()+'bad']:
            try:
                await session.ws_connect('http://127.0.0.1:6080/vnc?token='+token)
                raise AssertionError('invalid grant accepted')
            except WSServerHandshakeError as error: assert error.status==401
        async with session.ws_connect('http://127.0.0.1:6080/vnc?token='+sign(),protocols=['binary']) as ws:
            rfb=RFB(ws); await rfb.handshake(); await rfb.pixels()
            before=mouse()
            await rfb.pointer(91,93); await asyncio.sleep(.3)
            after=mouse(); assert (before['X'],before['Y'])==(after['X'],after['Y'])
        async with session.ws_connect('http://127.0.0.1:6080/vnc?token='+sign(mode='control'),protocols=['binary']) as ws:
            rfb=RFB(ws); await rfb.handshake()
            await rfb.pointer(121,123); await asyncio.sleep(.3)
            after=mouse(); assert (after['X'],after['Y'])==('121','123')
            state['epoch']+=1; state['controlledBy']=None; publish()
            await asyncio.sleep(.7)
            message=await ws.receive(timeout=3)
            assert message.type.name in ('CLOSE','CLOSED','CLOSING')
    print(json.dumps({'livePixels':True,'viewOnlyEnforced':True,'controlWorks':True,'revocationClosesSocket':True,'invalidGrantsDenied':True}))

if __name__=='__main__': asyncio.run(main())
