import ast,copy,hashlib,io,json,pathlib,re,stat,sys,warnings,zipfile
s=sys.argv[1]
assert len(s.encode())==26324
assert hashlib.sha256(s.encode()).hexdigest()=='b73f74994833db10cac6e31e7ab109462e261398a77565d0389d32e4db6a5e9d'
blocks=[]
for m in re.finditer(r"(?m)^([ ]*)python3[^\n]*<<'PY'\n([\s\S]*?)^\1PY[ \t]*$",s):
 prefix=m.group(1);body='\n'.join(x[len(prefix):] if x.startswith(prefix) else x for x in m.group(2).splitlines())
 compile(body,'workflow_python_'+str(len(blocks)),'exec');blocks.append(body)
assert len(blocks)>0
block=next(x for x in blocks if 'def verified_receipt(' in x)
nodes=[n for n in ast.parse(block).body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef,ast.ClassDef))]
ns={'__name__':'archive_guard_fixture'}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'exact_guard','exec'),ns)
verify=ns['verified_receipt'];Rejected=ns['ArchiveRejected']
archive=pathlib.Path('/tmp/issue1505-receipt.zip').read_bytes()
receipt=pathlib.Path('/tmp/issue1505-receipt.json').read_bytes()
members={'receipt.json':{'bytes':2132,'sha256':'80031945234e34264c558f830bd64bfa651858e69dbfdfa6354b62deb2a2022d'}}
assert verify(archive,925,'87124f31fd4cfc332411985814650992fcdad9f21ca6f5a0709f70abb5c41a81',members)==receipt
passed=['actual_original_archive']
def reject_case(name,data,expected,m=members,size=None,sha=None):
 try:verify(data,len(data) if size is None else size,hashlib.sha256(data).hexdigest() if sha is None else sha,m)
 except Rejected as e:
  assert str(e)=='issue1505_cleanup_'+expected,(name,str(e),expected)
 else:raise AssertionError(name+' accepted')
 passed.append(name)
def make_zip(entries):
 stream=io.BytesIO()
 with warnings.catch_warnings():
  warnings.simplefilter('ignore',UserWarning)
  with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as z:
   for name,data,mode in entries:
    info=zipfile.ZipInfo(name);info.create_system=3;info.external_attr=mode<<16;z.writestr(info,data)
 return stream.getvalue()
regular=stat.S_IFREG|0o600
reject_case('outer_size',archive,'archive_size_changed',size=924)
reject_case('outer_digest',archive,'archive_digest_changed',sha='0'*64)
reject_case('manifest',archive,'archive_manifest_invalid',m={'other.json':members['receipt.json']})
for name in ('../receipt.json','nested/receipt.json','nested\\receipt.json'):
 reject_case('path:'+name,make_zip([(name,receipt,regular)]),'archive_member_path_invalid')
reject_case('duplicate',make_zip([('receipt.json',receipt,regular),('receipt.json',receipt,regular)]),'archive_member_duplicate')
reject_case('extra_member',make_zip([('receipt.json',receipt,regular),('extra.json',b'{}',regular)]),'archive_member_set_changed')
reject_case('wrong_member',make_zip([('other.json',receipt,regular)]),'archive_member_set_changed')
reject_case('symlink',make_zip([('receipt.json',receipt,stat.S_IFLNK|0o777)]),'archive_member_not_regular')
bad=copy.deepcopy(members);bad['receipt.json']['bytes']+=1
reject_case('member_size',archive,'archive_member_size_changed',m=bad)
bad=copy.deepcopy(members);bad['receipt.json']['sha256']='0'*64
reject_case('member_digest',archive,'archive_member_digest_changed',m=bad)
reject_case('malformed_zip',b'not-a-zip','archive_invalid')
encrypted=bytearray(make_zip([('receipt.json',receipt,regular)]))
local=encrypted.find(b'PK\x03\x04');central=encrypted.find(b'PK\x01\x02')
encrypted[local+6]|=1;encrypted[central+8]|=1
reject_case('encrypted',bytes(encrypted),'archive_member_encrypted')
p=json.loads(receipt)
def only_sensitive(x):
 if isinstance(x,dict):
  return {k:('[redacted appClientId]' if k=='appClientId' else '[redacted]' if k in {'token','accessToken','refreshToken','clientSecret','password','authorization'} else only_sensitive(v)) for k,v in x.items()}
 if isinstance(x,list):return [only_sensitive(v) for v in x]
 return x
pathlib.Path('/tmp/issue1505-cleanup-final.yml').write_text(s)
pathlib.Path('/tmp/issue1505-masked-receipt.json').write_text(json.dumps(only_sensitive(p),separators=(',',':')))
print(json.dumps({'workflowBytes':len(s.encode()),'workflowSha256':hashlib.sha256(s.encode()).hexdigest(),'pythonBlocksCompiled':len(blocks),'archiveGuardPassed':len(passed),'cases':passed,'receiptBytes':len(receipt),'receiptSha256':hashlib.sha256(receipt).hexdigest(),'ownerTokenResolution':p.get('ownerTokenResolution'),'mintedTokenSha256':p.get('mintedTokenSha256'),'stateTokenSha256':p.get('state',{}).get('tokenSha256'),'minted':{k:v for k,v in p.get('minted',{}).items() if k in {'tokenSha256','checkTokenScopeConfirmed'}}},separators=(',',':')))
