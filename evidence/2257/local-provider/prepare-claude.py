import base64,hashlib,json,sys,tarfile,shutil
from pathlib import Path
from urllib.request import Request,urlopen
source,targets=map(Path,sys.argv[1:3])
p=json.loads((source/'packages/daemon/harness/pins.json').read_text())['harnesses']['claude_code']
assert p['version']=='2.1.309'
item=p['platforms']['linux-x64']
assert item['tarball']=='@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.309.tgz'
def download(url,to):
 with urlopen(Request(url,headers={'User-Agent':'Mikka isolated public component qualification'}),timeout=120) as r,to.open('wb') as out: shutil.copyfileobj(r,out,1024*1024)
archive=targets/'official-cli.tar.gz'
download('https://registry.npmjs.org/'+item['tarball'],archive)
assert item['integrity']=='sha512-'+base64.b64encode(hashlib.file_digest(archive.open('rb'),'sha512').digest()).decode()
dest=targets/'claude'
with tarfile.open(archive,'r:gz') as tar:
 entry=tar.getmember(item['entry']);assert entry.isfile()
 with tar.extractfile(entry) as src,dest.open('wb') as out: shutil.copyfileobj(src,out,1024*1024)
dest.chmod(0o700)
(targets/'claude.sha256').write_text(hashlib.file_digest(dest.open('rb'),'sha256').hexdigest())
weight=targets/'model.gguf'
download('https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/d255afaffd3441b95abca9b5cc4c819b93f66936/SmolLM2-135M-Instruct-Q4_K_M.gguf',weight)
assert hashlib.file_digest(weight.open('rb'),'sha256').hexdigest()=='2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d'
