from pathlib import Path
import shutil,sys
base=Path(sys.argv[1])/'product/.cache/e-codex-actual'
driver=base/'full-daemon.mts'
text=driver.read_text()
old="  await (await import('./browser.mts')).browserEntry(scope,dir,origin,record)"
assert text.count(old)==1
driver.write_text(text.replace(old,"  tokenId="+old.strip().replace('origin,record)','origin,record,revokeDevice)')))
browser=base/'browser.mts'
text=browser.read_text().replace('origin:string, record:any)', 'origin:string, record:any, recoverDevice:any)')
old='  }finally{listener?.close();'
assert text.count(old)==1
browser.write_text(text.replace(old,"    return await (await import('./verify.mts')).verifyCleanup(scope,origin,result,record,recoverDevice)\n"+old))
shutil.copyfile(Path(__file__).with_name('verify.mts'),base/'verify.mts')
