"""One bounded official-Claude CA observation; no install, model, or template build.

Only the runner receives E2B_API_KEY. The VM sees a fixed read-only Python
program. A second fresh VM is used only when the first valid observation did
not reproduce the failed file shape. Provider error messages never enter JSON.
"""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import re

SDK_VERSION = '2.62.0'
FAILED_SOURCE = 'd63b5e1b2e70baa368cf42ec6f9b13691571b6e0'
FAILED_RUN = '42326876749'
FAILED_BEFORE_SHA = 'fd1175201e861f159f0d6ae42523b0f5d754ade8a36d105e8b7110b180101862'
FAILED_AFTER_SHA = '21899698fbaa1da5314e42bc049b146f16cddb2e7540822b2a15f009f8342996'
CA_PATH = '/usr/local/share/ca-certificates/e2b-ca.crt'
PATHS = [CA_PATH, '/etc/ssl/certs/ca-certificates.crt', '/usr/local/share/e2b/ssl-certs.tar']
APPLICATION = 'mikka-issue1503-ca-control'
MAX_INSTANCES = 2

REMOTE_PROGRAM = r'''
import hashlib,json,os,pathlib,re,ssl,stat,subprocess
paths=[('/usr/local/share/ca-certificates/e2b-ca.crt',65536),('/etc/ssl/certs/ca-certificates.crt',4194304),('/usr/local/share/e2b/ssl-certs.tar',16777216)]
def fingerprint(s):
 return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def read_entry(name,maximum):
 p=pathlib.Path(name)
 try: before=p.lstat()
 except FileNotFoundError: return {'path':name,'kind':'missing'},None
 kind='file' if stat.S_ISREG(before.st_mode) else 'link' if stat.S_ISLNK(before.st_mode) else 'other'
 row={'path':name,'kind':kind,'mode':stat.S_IMODE(before.st_mode),'uid':before.st_uid,'gid':before.st_gid,'size':before.st_size}
 if kind=='link':
  target=os.readlink(p)
  row['target']=target if re.fullmatch(r'[A-Za-z0-9_./@+~()=: -]{1,2048}',target) else None
  row['targetSha256']=hashlib.sha256(target.encode()).hexdigest()
  return row,None
 if kind!='file' or before.st_size>maximum:
  row['tooLarge']=before.st_size>maximum
  return row,None
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as f:
  opened=os.fstat(f.fileno())
  data=f.read(maximum+1)
  ended=os.fstat(f.fileno())
 row['stable']=fingerprint(before)==fingerprint(opened)==fingerprint(ended)==fingerprint(p.lstat()) and len(data)==before.st_size
 row['sha256']=hashlib.sha256(data).hexdigest()
 return row,data
def x509(data,path):
 result={'singleCertificatePem':False,'parses':False,'ca':False,'subjectEqualsIssuer':False,'selfSignatureVerified':False,'containsPrivateKey':b'PRIVATE KEY' in data}
 if not re.fullmatch(rb'\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*',data): return result
 result['singleCertificatePem']=True
 try: der=ssl.PEM_cert_to_DER_cert(data.decode('ascii'))
 except (ValueError,UnicodeError): return result
 result['derSha256']=hashlib.sha256(der).hexdigest()
 detail=subprocess.run(['openssl','x509','-inform','PEM','-noout','-text','-subject','-issuer'],input=data,capture_output=True,timeout=5,check=False)
 result['parseExitCode']=detail.returncode
 if detail.returncode: return result
 result['parses']=True
 output=detail.stdout.decode('utf-8',errors='replace')
 result['ca']=bool(re.search(r'\bCA:TRUE\b',output))
 subject=re.search(r'^subject=(.*)$',output,re.M)
 issuer=re.search(r'^issuer=(.*)$',output,re.M)
 if subject and issuer:
  result['subjectEqualsIssuer']=subject[1].strip()==issuer[1].strip()
  result['subjectSha256']=hashlib.sha256(subject[1].strip().encode()).hexdigest()
  result['issuerSha256']=hashlib.sha256(issuer[1].strip().encode()).hexdigest()
 verify=subprocess.run(['openssl','verify','-check_ss_sig','-CAfile',path,path],capture_output=True,timeout=5,check=False)
 result['verifyExitCode']=verify.returncode
 result['selfSignatureVerified']=verify.returncode==0 and result['subjectEqualsIssuer']
 return result
try:
 rows=[]; bodies={}
 for name,maximum in paths:
  row,data=read_entry(name,maximum);rows.append(row);bodies[name]=data
 root=bodies[paths[0][0]]
 proof=x509(root,paths[0][0]) if root is not None else None
 if root is not None:
  # One observation must describe the same bytes while OpenSSL reads the path.
  checked,_=read_entry(*paths[0])
  rows[0]['stable']=rows[0].get('stable') is True and checked==rows[0]
 bundle=bodies[paths[1][0]]
 print(json.dumps({'version':1,'files':rows,'x509':proof,'rootPemInBundle':root.strip() in bundle if root is not None and bundle is not None else None,'mikkaPresent':any(os.path.lexists(p) for p in ['/opt/mikka','/home/user/.mikka/bootstrap.json','/home/user/.mikka/worker/device.json'])},separators=(',',':')))
except Exception as error:
 print(json.dumps({'version':1,'error':type(error).__name__},separators=(',',':')))
 raise SystemExit(1)
'''


class DiagnosticError(Exception):
    pass


def identity(environ=os.environ):
    if (environ.get('GITHUB_REPOSITORY') != 'alexj11324/Mikka'
            or not re.fullmatch(r'[a-f0-9]{40}', environ.get('GITHUB_SHA', ''))
            or not re.fullmatch(r'[1-9][0-9]*', environ.get('GITHUB_RUN_ID', ''))
            or not re.fullmatch(r'[1-9][0-9]*', environ.get('GITHUB_RUN_ATTEMPT', ''))):
        raise DiagnosticError('workflow_identity_invalid')
    return {'application': APPLICATION, 'sourceCommit': environ['GITHUB_SHA'],
            'runId': environ['GITHUB_RUN_ID'], 'runAttempt': environ['GITHUB_RUN_ATTEMPT']}


def safe_error(error):
    code = error.args[0] if isinstance(error, DiagnosticError) and error.args else None
    return {'type': type(error).__name__, **({'code': code} if isinstance(code, str) and re.fullmatch(r'[a-z_]{1,80}', code) else {})}


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def validate_observation(observation):
    if (not isinstance(observation, dict) or set(observation) != {'version','files','x509','rootPemInBundle','mikkaPresent'}
            or observation['version'] != 1 or observation['mikkaPresent'] is not False
            or not isinstance(observation['files'], list)
            or [row.get('path') for row in observation['files'] if isinstance(row, dict)] != PATHS):
        raise DiagnosticError('observation_scope_invalid')
    for row in observation['files']:
        if set(row) - {'path','kind','mode','uid','gid','size','stable','sha256','target','targetSha256','tooLarge'}:
            raise DiagnosticError('observation_fields_invalid')
        if row.get('kind') not in {'file','link','missing','other'}:
            raise DiagnosticError('observation_kind_invalid')
        for name in ('sha256','targetSha256'):
            if name in row and not re.fullmatch(r'[a-f0-9]{64}', row[name]):
                raise DiagnosticError('observation_digest_invalid')
        for name in ('mode','uid','gid','size'):
            if name in row and (type(row[name]) is not int or not 0 <= row[name] <= 2**53):
                raise DiagnosticError('observation_metadata_invalid')
        if row.get('kind') == 'file' and (row.get('stable') is not True or row.get('tooLarge') is True):
            raise DiagnosticError('observation_file_unstable')
    proof = observation['x509']
    if proof is not None:
        if (not isinstance(proof, dict) or set(proof) - {'singleCertificatePem','parses','ca','subjectEqualsIssuer','selfSignatureVerified','containsPrivateKey','derSha256','parseExitCode','verifyExitCode','subjectSha256','issuerSha256'}):
            raise DiagnosticError('observation_x509_invalid')
        for name in ('derSha256','subjectSha256','issuerSha256'):
            if name in proof and not re.fullmatch(r'[a-f0-9]{64}', proof[name]):
                raise DiagnosticError('observation_digest_invalid')
        for name in ('singleCertificatePem','parses','ca','subjectEqualsIssuer','selfSignatureVerified','containsPrivateKey'):
            if type(proof.get(name)) is not bool:
                raise DiagnosticError('observation_x509_invalid')
        if proof['containsPrivateKey']:
            raise DiagnosticError('observation_private_key_detected')
    if observation['rootPemInBundle'] is not None and type(observation['rootPemInBundle']) is not bool:
        raise DiagnosticError('observation_x509_invalid')
    return observation


def comparison(observation):
    root = observation['files'][0]
    proof = observation['x509'] or {}
    digest = root.get('sha256')
    reproduced = (root.get('kind') == 'file' and root.get('mode') == 0o777
                  and root.get('uid') == 0 and root.get('gid') == 0
                  and root.get('stable') is True and digest not in (None, FAILED_BEFORE_SHA)
                  and all(proof.get(key) is True for key in ('singleCertificatePem','parses','ca','selfSignatureVerified'))
                  and observation['rootPemInBundle'] is True)
    return {'matchesFailedBeforeSha': digest == FAILED_BEFORE_SHA,
            'matchesFailedAfterSha': digest == FAILED_AFTER_SHA,
            'reproducesFailedFileShapeWithoutMikka': reproduced}


def clean_id(Sandbox, NotFoundException, sandbox_id, key):
    receipt = {'sandboxId': sandbox_id, 'kill': 'not_attempted', 'exactIdAbsent': False}
    try:
        receipt['kill'] = 'killed' if Sandbox.kill(sandbox_id, api_key=key, request_timeout=30) else 'already_absent'
    except Exception as error:
        receipt['kill'] = 'failed'
        receipt['killError'] = safe_error(error)
    try:
        Sandbox.get_info(sandbox_id, api_key=key, request_timeout=30)
        receipt['readback'] = 'still_present'
    except NotFoundException:
        receipt['readback'] = 'not_found'
        receipt['exactIdAbsent'] = True
    except Exception as error:
        receipt['readback'] = 'failed'
        receipt['readbackError'] = safe_error(error)
    return receipt


def public_identity(info, sandbox_id):
    def identifier(value):
        return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9._+-]{1,160}', value) else None
    if info.sandbox_id != sandbox_id or identifier(info.template_id) is None:
        raise DiagnosticError('sandbox_identity_mismatch')
    # SDK 2.62 may omit build/base IDs. Explicit null never claims a pinned base.
    return {'templateId':info.template_id,'envdVersion':identifier(getattr(info,'envd_version',None)),
            'buildId':identifier(getattr(info,'build_id',None)),
            'baseTemplateId':identifier(getattr(info,'base_template_id',None)),
            'templateVersion':identifier(getattr(info,'template_version',None))}


def observe(Sandbox, NotFoundException, key, own, path):
    report = {'version': 1, 'purpose': 'official_claude_certificate_control', 'identity': own,
              'sdkVersion': SDK_VERSION, 'failedSource': FAILED_SOURCE, 'failedRunId': FAILED_RUN,
              'failedBeforeSha256': FAILED_BEFORE_SHA, 'failedAfterSha256': FAILED_AFTER_SHA,
              'templateRequested': 'claude', 'maxInstances': MAX_INSTANCES, 'instanceTimeoutSeconds': 180,
              'noMikkaInstallation': True, 'noTaskOrProviderCredentials': True, 'noTemplateBuild': True,
              'observations': [], 'status': 'running', 'cleanupComplete': True}
    save(path, report)
    try:
        for ordinal in range(1, MAX_INSTANCES + 1):
            row = {'ordinal': ordinal, 'status': 'creating'}
            report['cleanupComplete'] = False
            report['observations'].append(row); save(path, report)
            sandbox = Sandbox.create('claude', api_key=key, timeout=180, request_timeout=45,
                                     metadata={**own, 'observation': str(ordinal)})
            row.update(sandboxId=sandbox.sandbox_id, status='created')
            report['cleanupComplete'] = False; save(path, report)
            try:
                info = Sandbox.get_info(sandbox.sandbox_id, api_key=key, request_timeout=30)
                if any((info.metadata or {}).get(k) != v for k, v in {**own, 'observation': str(ordinal)}.items()):
                    raise DiagnosticError('sandbox_identity_mismatch')
                row.update(public_identity(info,sandbox.sandbox_id))
                result = sandbox.commands.run("python3 -B - <<'MIKKA_CA_READ_ONLY'\n" + REMOTE_PROGRAM + "\nMIKKA_CA_READ_ONLY", user='root', timeout=30, request_timeout=40)
                if result.exit_code != 0 or len(result.stdout.encode()) > 16384:
                    raise DiagnosticError('observation_command_failed')
                row['observation'] = validate_observation(json.loads(result.stdout))
                row['comparison'] = comparison(row['observation'])
                row['status'] = 'observed'
            finally:
                row['cleanup'] = clean_id(Sandbox, NotFoundException, sandbox.sandbox_id, key)
                report['cleanupComplete'] = all(item.get('cleanup', {}).get('exactIdAbsent') is True for item in report['observations'] if item.get('sandboxId'))
                save(path, report)
            if not report['cleanupComplete']:
                raise DiagnosticError('cleanup_incomplete')
            if row['comparison']['reproducesFailedFileShapeWithoutMikka']:
                break
        report['status'] = 'observed_failure_shape' if any(row.get('comparison', {}).get('reproducesFailedFileShapeWithoutMikka') for row in report['observations']) else 'observed_without_reproduction'
        report['conclusionLimit'] = 'This observes a live official alias and reports its resolved identity. The failed derived image base/build is unknown; this cannot completely attribute that historical incident, pass candidate conservation, or change its policy.'
    except Exception as error:
        report['status'] = 'failed'; report['error'] = safe_error(error)
        raise
    finally:
        save(path, report)
    return report


def cleanup_owned(Sandbox, SandboxQuery, SandboxState, NotFoundException, key, own, path):
    receipt = {'version':1, 'identity':own, 'sandboxes':[], 'remaining':[], 'errors':[]}
    try:
        paginator = Sandbox.list(query=SandboxQuery(metadata=own, state=[SandboxState.RUNNING,SandboxState.PAUSED]), api_key=key, request_timeout=30)
        found=[]
        while paginator.has_next:
            found.extend(paginator.next_items())
        if len(found)>MAX_INSTANCES:
            raise DiagnosticError('cleanup_resource_bound_exceeded')
        for row in found:
            if any((row.metadata or {}).get(k)!=v for k,v in own.items()) or (row.metadata or {}).get('observation') not in {'1','2'}:
                raise DiagnosticError('cleanup_scope_invalid')
        for row in found:
            receipt['sandboxes'].append(clean_id(Sandbox,NotFoundException,row.sandbox_id,key))
        receipt['remaining']=[row['sandboxId'] for row in receipt['sandboxes'] if row['exactIdAbsent'] is not True]
    except Exception as error:
        receipt['errors'].append(safe_error(error))
    finally:
        save(path,receipt)
    if receipt['errors'] or receipt['remaining']:
        raise DiagnosticError('cleanup_incomplete')
    return receipt


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--cleanup-only',action='store_true')
    args=parser.parse_args()
    if importlib.metadata.version('e2b') != SDK_VERSION:
        raise DiagnosticError('sdk_version_mismatch')
    own=identity()
    key=os.environ['E2B_API_KEY']
    from e2b import Sandbox, SandboxQuery, SandboxState
    from e2b.exceptions import NotFoundException
    if args.cleanup_only:
        receipt=cleanup_owned(Sandbox,SandboxQuery,SandboxState,NotFoundException,key,own,args.output)
        print(json.dumps({'event':'issue1503_ca_cleanup','remaining':len(receipt['remaining']),'errors':len(receipt['errors'])}))
    else:
        report=observe(Sandbox,NotFoundException,key,own,args.output)
        print(json.dumps({'event':'issue1503_ca_control','status':report['status'],'instances':len(report['observations']),'cleanupComplete':report['cleanupComplete']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'event':'issue1503_ca_control_failed',**safe_error(error)}))
        raise SystemExit(1)
