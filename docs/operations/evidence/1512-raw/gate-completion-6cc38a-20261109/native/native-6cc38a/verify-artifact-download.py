import os, json, pathlib, urllib.request, urllib.parse, hashlib, zipfile, stat, gzip, base64, time
root=pathlib.Path("/vercel/sandbox/native-6cc")
root.mkdir(mode=0o700,parents=True,exist_ok=True)
targets={"lifecycle.json","smoke.json","parity.json","native-crypto.json","mac-acceptance-package.json"}
specs=json.loads(os.environ["ARTIFACTS_JSON"])
if not 1 <= len(specs) <= 2: raise RuntimeError("unexpected_artifact_count")
def allowed(url):
    u=urllib.parse.urlsplit(url); h=(u.hostname or "").lower()
    return u.scheme=="https" and (h=="chatgpt.com" or any(h.endswith(x) for x in (".blob.core.windows.net",".amazonaws.com",".oaiusercontent.com")))
def git_blob(data):
    return hashlib.sha1(("blob "+str(len(data))+"\0").encode()+data).hexdigest()
archives=[]; files=[]; selected={}; started=time.time()
for spec in specs:
    url=spec["url"]
    if not allowed(url): raise RuntimeError("download_hostname_not_allowed")
    dest=root/(str(spec["id"])+".original.zip")
    h=hashlib.sha256(); count=0
    with urllib.request.urlopen(url,timeout=90) as response:
        if not allowed(response.geturl()): raise RuntimeError("redirect_hostname_not_allowed")
        with dest.open("xb") as output:
            while True:
                block=response.read(1024*1024)
                if not block: break
                output.write(block); h.update(block); count+=len(block)
    digest=h.hexdigest()
    if spec.get("expectedSize") is not None and count!=spec["expectedSize"]: raise RuntimeError("artifact_size_mismatch")
    expected=spec.get("expectedDigest")
    if expected and digest!=expected.removeprefix("sha256:"): raise RuntimeError("artifact_digest_mismatch")
    archive={"artifactId":spec["id"],"name":spec["name"],"kind":spec["kind"],"bytes":count,"sha256":digest,
             "apiSize":spec.get("expectedSize"),"apiDigest":expected,"zipFile":dest.name,"zipTestPassed":False}
    with zipfile.ZipFile(dest) as z:
        if z.testzip() is not None: raise RuntimeError("zip_crc_mismatch")
        archive["zipTestPassed"]=True
        names=set()
        for info in z.infolist():
            path=pathlib.PurePosixPath(info.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in info.filename or ":" in path.parts[0]: raise RuntimeError("unsafe_archive_path")
            if info.filename in names: raise RuntimeError("duplicate_archive_path")
            names.add(info.filename)
            mode=info.external_attr>>16
            if stat.S_ISLNK(mode): raise RuntimeError("archive_symlink_not_allowed")
            if info.is_dir(): continue
            data=z.read(info)
            if len(data)!=info.file_size: raise RuntimeError("zip_entry_size_mismatch")
            record={"artifactId":spec["id"],"path":info.filename,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest(),
                    "gitBlob":git_blob(data),"compressedBytes":info.compress_size,"crc32":format(info.CRC,"08x")}
            files.append(record)
            if path.name in targets:
                if path.name in selected: raise RuntimeError("duplicate_selected_original")
                json.loads(data.decode("utf-8-sig"))
                (root/path.name).write_bytes(data)
                selected[path.name]={**record,"contentBase64":base64.b64encode(data).decode("ascii")}
    archive["fileCount"]=sum(x["artifactId"]==spec["id"] for x in files)
    archives.append(archive)
missing=sorted(targets-set(selected))
manifest={"schemaVersion":1,"source":"downloaded_GitHub_Actions_artifacts","archives":archives,"files":files,
          "fileCount":len(files),"entryBytes":sum(x["bytes"] for x in files),"missingSelectedOriginals":missing}
manifest_bytes=(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n").encode()
(root/"original-files-manifest.safe.json").write_bytes(manifest_bytes)
bundle={"manifest":manifest,"selectedOriginals":selected}
raw=(json.dumps(bundle,ensure_ascii=False,separators=(",",":"))+"\n").encode()
compressed=gzip.compress(raw,compresslevel=9,mtime=0)
(root/"originals.bundle.json.gz").write_bytes(compressed)
n=json.loads(base64.b64decode(selected["lifecycle.json"]["contentBase64"]).decode("utf-8-sig")) if "lifecycle.json" in selected else {}
q=n.get("queryCounts",{})
out={"archives":archives,"selected":[{k:v for k,v in s.items() if k!="contentBase64"} for s in selected.values()],
     "bundle":{"path":str(root/"originals.bundle.json.gz"),"gzipBytes":len(compressed),"gzipSha256":hashlib.sha256(compressed).hexdigest(),
               "jsonBytes":len(raw),"jsonSha256":hashlib.sha256(raw).hexdigest(),"chunkBytes":1455,"chunks":(len(compressed)+1454)//1455},
     "files":len(files),"missingSelectedOriginals":missing,"revision":n.get("revision"),"result":n.get("result"),"login":q.get("login"),"startup":q.get("startup"),
     "elapsedSeconds":round(time.time()-started,3)}
(root/"recovery-summary.safe.json").write_text(json.dumps(out,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"revision":out["revision"],"result":out["result"],"windows":{k:{"queries":(v.get("total") or {}).get("queryCalls"),"pair":v.get("pair"),"segments":[x.get("queryCalls") for x in (v.get("segments") or [])]} for k,v in q.get("windows",{}).items()},"missingSelectedOriginals":missing,"bundle":out["bundle"],
"archives":[{"id":a["artifactId"],"bytes":a["bytes"],"sha256":a["sha256"],"fileCount":a["fileCount"]} for a in archives]},ensure_ascii=False,separators=(",",":")))
