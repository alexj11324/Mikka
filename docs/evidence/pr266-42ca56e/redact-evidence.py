import pathlib,json,re,hashlib,datetime,shutil
src=pathlib.Path('/workspace/208-approved-actions-evidence'); dst=pathlib.Path('/workspace/mikka-266-evidence/docs/evidence/pr266-42ca56e');dst.mkdir(parents=True,exist_ok=True)
records=[]
def digest(b):return hashlib.sha256(b).hexdigest()
def redact(s):
 lines=[]
 for line in s.splitlines(keepends=True):
  if re.search(r'(?i)(authorization:|cookie:|bearer\s|access_token|session_token|\bparams:|\bparameters:)',line):
   lines.append('[REDACTED authentication or SQL parameter line]\n');continue
  line=re.sub(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b',lambda m:'fixture-id-'+digest(m[0].encode())[:12],line,flags=re.I)
  line=re.sub(r'\b[A-Za-z0-9]{32}\b',lambda m:'fixture-owner-'+digest(m[0].encode())[:12],line)
  line=re.sub(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',lambda m:'synthetic-redacted@example.invalid' if m[0].endswith('@example.invalid') else '[REDACTED email]',line)
  lines.append(line)
 return ''.join(lines)
logs=['browser-run1.log','browser-run2.log','browser-run3.log','browser-run4.log','browser-run5.log','browser-run6.log','browser-expiry-run1.log','browser-expiry-run2.log','runtime.log','provider.ndjson','session-retention-check.log','session-retention-retest.log','pg-http-tests.log','adapter-tests.log']
results=['browser-six-results.json','browser-email-results.json','browser-results.json','expired-session-results-before-retention-review.json','expired-session-results.json','ci-status.json','video-manifest.json']
scripts=['start.mjs','record-all.cjs','record.cjs','record-expiry.cjs','control-route.ts','sdk-double.ts','overlay-config.patch']
for name in logs+results+scripts:
 raw=(src/name).read_bytes(); folder='logs' if name in logs else 'results' if name in results else 'harness';target=dst/folder/name;target.parent.mkdir(exist_ok=True)
 published=redact(raw.decode()).encode() if name in logs else raw
 target.write_bytes(published)
 records.append({'path':str(target.relative_to(dst)),'sourceBytes':len(raw),'sourceSHA256':digest(raw),'publishedBytes':len(published),'publishedSHA256':digest(published),'redacted':raw!=published,'sourceMtimeUTC':datetime.datetime.fromtimestamp((src/name).stat().st_mtime,datetime.timezone.utc).isoformat()})
manifest={'candidateSHA':'42ca56ebee733c9f5ed67bec0d48170e7506814e','baseSHA':'12368c4051c2b051828f681f46b7ff1148372f96','captureDateUTC':'2026-10-25','publicationPurpose':'Previously executed acceptance evidence; no rerun','files':records,'redaction':'Authentication/SQL parameter lines removed; generated UUID/32-character identifiers deterministically pseudonymized; email strings redacted. No private mapping is published. Unmodified originals remain private. Script fixture literals are intentionally synthetic, not credentials.'}
(dst/'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n')
shutil.copy2('/workspace/prepare-266-evidence.py',dst/'redact-evidence.py')
print('Prepared',len(records),'text files;',sum(x['redacted'] for x in records),'redacted logs')
