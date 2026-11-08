import os,json,re,urllib.request,urllib.error,http.cookiejar,datetime

assert os.environ['GITHUB_REPOSITORY']=='alexj11324/Mikka'
assert os.environ['GITHUB_REF']=='refs/heads/ops/core-baseline-probe-20261108'
assert os.environ['GITHUB_ACTOR']=='alexj11324'
assert os.environ['GITHUB_EVENT_NAME']=='push'
origin='https://app.aspectlylabs.com'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise RuntimeError('redirect_rejected')
jar=http.cookiejar.CookieJar()
opener=urllib.request.build_opener(NoRedirect,urllib.request.HTTPCookieProcessor(jar))
def api(path,body=None):
    assert path in ['/api/auth/sign-in/email','/api/auth/get-session','/api/device-tokens','/api/rpc','/api/auth/sign-out','/api/version']
    headers={'Origin':origin,'Accept':'application/json'}
    if path=='/api/rpc':headers['x-mikka-rpc']='1'
    data=None if body is None else json.dumps(body).encode()
    if data is not None:headers['Content-Type']='application/json'
    with opener.open(urllib.request.Request(origin+'/mikka'+path,data=data,headers=headers),timeout=25) as r:
        assert r.status==200
        return json.load(r)
uuid=lambda v:isinstance(v,str) and re.fullmatch(r'[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}',v) is not None
report={'models':0,'newDevices':0,'newCredentials':0,'newGrants':0,'stage':'sign-in'}
started=False
try:
    assert api('/api/version')['build']=='7e34d869aa80266494cb2e2eefeee5d8e7ff7d4d'
    started=True
    api('/api/auth/sign-in/email',{'email':os.environ['SMOKE_OWNER_EMAIL'],'password':os.environ['SMOKE_OWNER_PASSWORD']})
    user=api('/api/auth/get-session')['user']
    assert user['email']==os.environ['SMOKE_OWNER_EMAIL']
    report['stage']='read-baseline'
    page=api('/api/device-tokens');rows=page.get('tokens')
    report['tokensArray']=isinstance(rows,list)
    report['tokensCount']=len(rows) if isinstance(rows,list) else None
    report['tokensAtPageCap']=isinstance(rows,list) and len(rows)==100
    report['tokenShapeValid']=isinstance(rows,list) and all(uuid(r.get('id')) and isinstance(r.get('name'),str) and isinstance(r.get('createdAt'),str) and datetime.datetime.fromisoformat(r['createdAt'].replace('Z','+00:00')) for r in rows)
    report['tokensNextCursorPresent']=bool(page.get('nextCursor'))
    wire=api('/api/rpc',{'version':1,'action':'agents.pollDevices','args':[]})
    assert wire.get('ok') is True and wire.get('version')==1
    data=wire['result'];devices=data.get('devices')
    report['devicesCount']=len(devices) if isinstance(devices,list) else None
    report['devicesShapeValid']=isinstance(devices,list) and all(uuid(r.get('id')) and isinstance(r.get('name'),str) and type(r.get('enabled')) is bool and type(r.get('online')) is bool and isinstance(r.get('harnesses'),list) for r in devices)
    report['deviceIdsUnique']=isinstance(devices,list) and len({r.get('id') for r in devices})==len(devices)
    report['liveOwnerMatches']=data.get('live',{}).get('ownerId')==user['id']
    report['liveWorkspaceUuid']=uuid(data.get('live',{}).get('workspaceId'))
    report['stage']='read-complete'
except urllib.error.HTTPError as error:
    report['failure']='http_error';report['httpStatus']=error.code
    raise SystemExit(1)
except Exception as error:
    report['failure']='probe_failed';report['errorType']=type(error).__name__
    raise SystemExit(1)
finally:
    try:
        if started:api('/api/auth/sign-out',{})
        report['sessionClosed']=True
    except Exception:report['sessionClosed']=False
    jar.clear()
    print(json.dumps(report,default=bool))
