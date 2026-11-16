from pathlib import Path
import sys,json,re
base=Path(sys.argv[1]);qa=base/'run/case'
def optional(p):
 try: return p.read_text()
 except (OSError,UnicodeError): return ''
diagnostic=optional(qa/'daemon.log'); build=optional(base/'build.log')
fields = {name: bool(re.search(pattern,diagnostic,re.I)) for name,pattern in {
 'nodePackageMissing':r'ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package',
 'filePermission':r'permission denied|EACCES|EPERM','tlsTrust':r'CERT_|self.signed|certificate','requestFailed':r'fetch failed|ECONNREFUSED|network unreachable',
 'registrationRejected':r'Device registration token expired or already used','sudoDenied':r'sudo:','gitConfig':r'gitconfig','esbuild':r'esbuild','tsx':r'tsx','invalidGrantInput':r'Invalid registration token',
 'registrationPersisted':r'Logged in|Credential stored|Signed in',
 'childExited':r'ELIFECYCLE|spawn','pino':r'pino','readPackageJson':r'package.json','packageEsm':r'ERR_PACKAGE|ERR_REQUIRE',
 'cannotReadDirectory':r'scandir|readdir','deviceFile':r'device.json','vscodeJsonrpc':r'vscode-jsonrpc','typescriptLoader':r'TransformError|TypeScript','blockedIpc':r'connect EACCES',
 'accessUtf8':r'EINVAL','deprecated':r'DeprecationWarning','http2':r'HTTP 2','cwdUnreadable':r'uv_cwd|getcwd','unsupported':r'not supported','fsEnoent':r'ENOENT',
 'editorGraph':r'@mikka/protocol','swc':r'swc','hashAlgorithm':r'unsupported hash/crypto','pathPrivateNamespace':r'/home/runner/work/_temp/',
 }.items()}
def version(p): return p.read_text().strip() if p.is_file() else None
proof=json.loads(optional(qa/'proof.json') or '{}')
print(json.dumps({'source':version(base/'source.sha'),'interface':'community-system-browser-only','actualChecks':[{k:v for k,v in c.items() if k in ('phase','at','version','actualGoogleOAuth','packagedDesktop')} for c in proof.get('checks',[])],'stage':proof.get('diagnostic'), 'phases':[x['phase'] for x in proof.get('checks',[])], 'success':proof.get('success'), 'workbenchStage':version(base/'stage'), 'buildClasses':sorted(set(re.findall(r'\b(?:E[A-Z_]{2,40}|[A-Z][a-zA-Z]{0,18}Error)\b',build)))[:18], 'buildIndicators':[a for a,p in {'missingModule':r'Cannot find module|Cannot find package|could not resolve','outOfMemory':r'heap out|out of memory','killed':r'killed','diskFull':r'no space left','permissionDenied':r'EACCES|permission denied','database':r'POSTGRES|DATABASE_URL','missingBuild':r'build manifest','git':r'not a git repository','path':r'ENOENT','workflowModel':r'model-metadata-unavailable'}.items() if re.search(p,build,re.I)],'image':version(base/'image.id'), 'nativeLogBytes':len(diagnostic), 'knownMarkers':{k:v for k,v in fields.items() if v},'permittedTransportResult':next((x.get('exit') for x in proof.get('checks',[]) if x.get('phase')=='separate_device_https_version_and_empty_grant_response'),None), 'before':{'permissionRejected': 'ERR_INVALID_PACKAGE_CONFIG' in optional(qa/'before-loader.log'),'readableAfterDedicatedCopy':'Invalid registration token' in optional(qa/'after-loader.log')}, 'nonSecretClasses':sorted(set(re.findall(r'\b(?:E[A-Z_]{2,40}|[A-Z][a-zA-Z]{0,18}Error)\b',diagnostic)))[:16]},indent=2))
