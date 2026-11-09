#!/usr/bin/env python3
"""Relevant offline checks only; never imports or calls helper business functions."""
import ast
import argparse
import json
import re
import subprocess
from pathlib import Path
import yaml

ROOT=Path(__file__).resolve().parent
BASE=ROOT.parent
# Execute Python definitions without writing __pycache__ or invoking __main__.
namespace={'__name__':'offline_adapter_definition'}
exec(compile((ROOT/'materialize-trusted-carrier.py').read_text(),str(ROOT/'materialize-trusted-carrier.py'),'exec'),namespace)
identity=namespace['identity']
parser=argparse.ArgumentParser()
parser.add_argument('--out',type=Path,default=ROOT/'validation')
out=parser.parse_args().out.resolve()
out.relative_to(ROOT)
out.mkdir(exist_ok=False)
summary={'version':1,'scope':'branch/ordered-parent adaptation, conservation and syntax only','checks':[]}
def check(name,condition):
    if not condition:raise AssertionError(name)
    summary['checks'].append({'name':name,'passed':True})
def get_yaml(path):return yaml.load(path.read_text(),Loader=yaml.BaseLoader)
def heredocs(document):
    result=[]
    for job in document['jobs'].values():
        for step in job['steps']:
            for m in re.finditer(r"<<'([A-Z_]+)'\n(.*?)\n\1(?:\n|$)",step.get('run',''),re.S):
                result.append((m.group(1),m.group(2)))
    return result
def one_between(text,start,end):
    assert text.count(start)==1 and text.count(end)==1
    return text.split(start,1)[1].split(end,1)[0]

documents={}
for name,wf in [('prepare',namespace['PREPARE_WF']),('cleanup',namespace['CLEANUP_WF'])]:
    oldpath=BASE/('diagnostic-'+name+'-preparation-1505')/wf
    newpath=ROOT/name/wf
    old,new=oldpath.read_text(),newpath.read_text()
    check(name+' exact allowed adaptation',new==namespace['adapt_'+name](old))
    od,nd=get_yaml(oldpath),get_yaml(newpath)
    documents[name]={'original':od,'candidate':nd}
    check(name+' only inert template extension',newpath.suffix=='.in')
    check(name+' trusted carrier selected',nd['on']['push']['branches']==[namespace['BRANCH']])
    check(name+' workflow queue unchanged',od['concurrency']==nd['concurrency'])
    oldjob,nextjob=od['jobs'][name],nd['jobs'][name]
    check(name+' job disabled',nextjob['if']=='false')
    check(name+' job queue and timeout unchanged',oldjob['concurrency']==nextjob['concurrency'] and oldjob['timeout-minutes']==nextjob['timeout-minutes']=='10')
    oidc=lambda job:[step for step in job['steps'] if 'Infisical/' in step.get('uses','')]
    check(name+' complete OIDC blocks unchanged',oidc(oldjob)==oidc(nextjob))
    check(name+' permissions unchanged',od['permissions']==nd['permissions'] and oldjob.get('permissions')==nextjob.get('permissions'))
    check(name+' carrier binding remains unfilled',json.loads((ROOT/name/'carrier.unfilled.json').read_text())=={'closedCarrierCommit':None})
    for index,(marker,code) in enumerate(heredocs(nd),1):
        target=out/(name+'-'+str(index)+'-'+marker.lower()+'.mjs')
        assert not target.exists()
        target.write_text(code+'\n')
        run=subprocess.run(['node','--input-type=module','--check'],input=code,text=True,capture_output=True)
        summary['checks'].append({'name':'syntax '+str(target.relative_to(ROOT)),'passed':run.returncode==0,
            'command':['node','--input-type=module','--check'],'exitCode':run.returncode,
            'stdout':run.stdout,'stderr':run.stderr,'sourceSha256':identity(code.encode())['sha256']})
        assert run.returncode==0

copies={'prepare':['pins.unfilled.json','scripts/ops/issue1505-diagnostic-window.mjs.in','scripts/ops/issue1505-diagnostic-window-original-42366750743.json'],
        'cleanup':['bindings.unfilled.json','scripts/ops/issue1505-diagnostic-cleanup-r7.mjs']}
for name,paths in copies.items():
    for path in paths:
        data=(ROOT/name/path).read_bytes()
        check(name+' unchanged '+path,data==(BASE/('diagnostic-'+name+'-preparation-1505')/path).read_bytes())
        if '.mjs' in path:
            run=subprocess.run(['node','--input-type=module','--check'],input=data,capture_output=True)
            check(name+' helper syntax only',run.returncode==0)
pins=json.loads((ROOT/'prepare/pins.unfilled.json').read_text())
check('original 13 pins remain exactly null',len(pins)==13 and all(v is None for v in pins.values()))
check('cleanup original 12 dynamic pins remain null',all(v is None for k,v in json.loads((ROOT/'cleanup/bindings.unfilled.json').read_text()).items() if k!='version'))
prepare_new=(ROOT/'prepare'/namespace['PREPARE_WF']).read_text()
cleanup_new=(ROOT/'cleanup'/namespace['CLEANUP_WF']).read_text()
check('exactly one prepareWindow invocation',prepare_new.count('await helper.prepareWindow(')==1)
check('exactly one imported removeOwnedWindow invocation',cleanup_new.count('await removeOwnedWindow(')==1)
check('no active workflow supplied',not list(ROOT.rglob('*.yml')))

payload={'prepare':{},'cleanup':{}}
for which in ('original','candidate'):
    pcode=heredocs(documents['prepare'][which])[0][1]
    payload['prepare'][which]={
        'branch':re.search(r"export const branch='([^']+)'",pcode).group(1),
        'go':re.search(r"export const go='([^']+)'",pcode).group(1),
        'pinValidation':'function pinValidation(){'+one_between(pcode,'export function pinValidation(){','export function windowGuard'),
        'parents':'const parents='+one_between(pcode,'const parents=','const raw='),
    }
    ccode=heredocs(documents['cleanup'][which])[0][1]
    prefix=ccode.split('function bind(){',1)[0]
    prefix='\n'.join(line for line in prefix.splitlines() if not line.startswith('import ') and not line.startswith('const git='))
    payload['cleanup'][which]={
        'branch':re.search(r"const EXPECTED_BRANCH='([^']+)'",ccode).group(1),
        'go':re.search(r"const EXPECTED_GO='([^']+)'",ccode).group(1),
        'workflowPath':re.search(r"const WORKFLOW_PATH='([^']+)'",ccode).group(1),
        'helperPath':re.search(r"const HELPER_PATH='([^']+)'",ccode).group(1),
        'prefix':prefix,'bind':'function bind(){'+one_between(ccode,'function bind(){','function clockGuard'),
    }
payload['cleanupHelperBlob']='e9f07af8ec87eb83b3eb46c046731390ba97c1d9'
inputpath=out/'guard-fragments.json'
inputpath.write_text(json.dumps(payload,indent=2)+'\n')
run=subprocess.run(['node',str(ROOT/'carrier-guard-check.mjs'),str(inputpath)],text=True,capture_output=True)
(out/'guard-check.stdout.json').write_text(run.stdout)
(out/'guard-check.stderr.txt').write_text(run.stderr)
summary['guardCommand']=['node',str(ROOT/'carrier-guard-check.mjs'),str(inputpath)]
summary['guardExitCode']=run.returncode
assert run.returncode==0,run.stderr
summary['guardResults']=json.loads(run.stdout)
before=json.loads((ROOT/'provenance/source-inventory.before.json').read_text())
after=namespace['inventory'](BASE)
check('all 20 frozen source files remain unchanged',before==after)
for path in ('materialize-trusted-carrier.py','validate.py'):
    ast.parse((ROOT/path).read_text())
    check('Python syntax '+path,True)
summary.update({'status':'passed','networkCalls':0,'gitMutations':0,'helperBusinessCalls':0,
    'frozenSourcesUnchanged':True,'actualCloudTrustValidated':False,'allBindingsUnfilled':True})
(out/'result.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'status':'passed','staticAndSyntaxChecks':len(summary['checks']),
    'guardChecks':summary['guardResults']['checks'],'frozenSourcesUnchanged':True}))
