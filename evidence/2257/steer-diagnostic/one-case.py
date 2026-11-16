from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
s=s.replace("['steer','interrupt','queue','sendNow'] as const","['steer'] as const")
s=s.replace("const sendId=await ui.submit(mode==='sendNow'?'queue':mode,follow)","await wait(900); const sendId=await ui.submit(mode==='sendNow'?'queue':mode,follow)")
s=s.replace("return r?.sessionId&&r.status==='stopped'&&r","if(r?.status==='failed')throw Error('captured_failed_run');return r?.sessionId&&r.status==='stopped'&&r",1)
p.write_text(s)
