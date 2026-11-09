import subprocess,pathlib,os,json,time,datetime,hashlib,signal
root=pathlib.Path("/vercel/mikka-1505-factory-id-semantics")
out=pathlib.Path("/vercel/ops-1505/ci-pg1-fixture-repair")
source=root/"lib/factory/run-end-paths.db.test.ts"
assert hashlib.sha256(source.read_bytes()).hexdigest()=="19f3cb3c3e34a4d2d142fbb1c1d7e3dc1820093816eab5a41c2220df78626545"
env=dict(os.environ);env.update({"E2E_DATABASE_URL":"postgresql://mikka_1505_pg1@127.0.0.1:55485/mikka_1505_pg1_e2e","REQUIRE_DB":"1","MIKKA_EDITION":"cloud"})
cmd=["node","--experimental-test-module-mocks","--import","./tests/support/server-only.mjs","--import","tsx","--test","lib/factory/run-end-paths.db.test.ts"]
start=time.monotonic();receipt={"command":cmd,"startedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"sourceSha256":hashlib.sha256(source.read_bytes()).hexdigest(),"postgres":"17.11","requiredDb":True,"databaseHost":"127.0.0.1","databasePort":55485,"productionRequests":0,"timeout":False}
with (out/"pg17-test.log").open("wb") as f:
 p=subprocess.Popen(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
 receipt["nodePid"]=p.pid
 try:code=p.wait(timeout=210)
 except subprocess.TimeoutExpired:
  receipt["timeout"]=True;os.killpg(p.pid,signal.SIGTERM)
  try:code=p.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);code=p.wait()
receipt.update({"finishedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"seconds":time.monotonic()-start,"exitCode":code})
log=(out/"pg17-test.log").read_bytes()
receipt.update({"logBytes":len(log),"logSha256":hashlib.sha256(log).hexdigest(),"sourceUnchanged":hashlib.sha256(source.read_bytes()).hexdigest()==receipt["sourceSha256"]})
(out/"pg17-test.json").write_text(json.dumps(receipt,indent=2)+"\n")
print(json.dumps(receipt))
