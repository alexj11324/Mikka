from pathlib import Path
import subprocess,os,sys,json,hashlib,datetime,time
base=Path(__file__).resolve().parent
checkout=Path("/workspace/scratch/812e3b7d6d45/issue1512-integration-checkout")
label=sys.argv[1]; argv=json.loads(sys.argv[2])
assert all(c.isalnum() or c in "-_" for c in label)
log=base/(label+".original.log");receipt=base/(label+".safe.json")
assert not log.exists() and not receipt.exists(),"do not overwrite checks"
env={k:v for k,v in os.environ.items() if k in ["PATH","HOME","USER","LOGNAME","LANG","LC_ALL","TMPDIR","SHELL"]}
env.update({"PATH":str(base/"runtime-bin")+os.pathsep+env.get("PATH",""),"NODE_OPTIONS":"--max-old-space-size=4096","NEXT_TELEMETRY_DISABLED":"1"})
source_tree=json.loads((base/"integration-test-fix-source.safe.json").read_text())["sourceTree"]
source_index_entries=subprocess.check_output(["git","--no-optional-locks","ls-files","--stage","-z"],cwd=checkout)
subprocess.run(["git","--no-optional-locks","diff-files","--quiet"],cwd=checkout,check=True)
start=datetime.datetime.now(datetime.timezone.utc).isoformat();t=time.monotonic()
with log.open("wb") as out:
    result=subprocess.run(argv,cwd=checkout,env=env,stdout=out,stderr=subprocess.STDOUT)
raw=log.read_bytes()
record={"schema":1,"label":label,"argv":argv,"cwd":str(checkout),"sourceTree":source_tree,"sourceTreeUnchanged":source_index_entries==subprocess.check_output(["git","--no-optional-locks","ls-files","--stage","-z"],cwd=checkout),"trackedWorktreeUnchanged":subprocess.run(["git","--no-optional-locks","diff-files","--quiet"],cwd=checkout).returncode==0,"start":start,"end":datetime.datetime.now(datetime.timezone.utc).isoformat(),"durationSeconds":round(time.monotonic()-t,3),"exitCode":result.returncode,"log":{"path":str(log),"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()},"environment":{"pinnedPnpm":"10.34.3","nodeOptions":env["NODE_OPTIONS"],"databaseOrCredentialEnvironmentForwarded":False,"sourceSecurityOrSandboxOverrides":False},"published":False,"productionAccepted":False}
receipt.write_text(json.dumps(record,indent=2)+"\n")
print(json.dumps(record,indent=2));sys.exit(result.returncode)
