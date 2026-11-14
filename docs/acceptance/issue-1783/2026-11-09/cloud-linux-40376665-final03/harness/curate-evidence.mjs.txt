import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const [directory, destination] = process.argv.slice(2)
assert.ok(directory && destination)
const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'))
const proof = JSON.parse(await readFile(join(directory, 'activity-readback/proof.json'), 'utf8'))
assert.equal(receipt.codeCommit, '40376665ac416ce2228c08b60d7ea8cee97a3de6')
assert.equal(receipt.codeTree, '297bb45ee8e60d4e6a29735e5e8e1fceae9d3741')
assert.equal(receipt.exitCode, 0); assert.equal(receipt.stages.length, 4)
assert.equal(proof.exitCode, 0); assert.equal(proof.captures.length, 6)
assert.equal(proof.documents.length, 4)
assert.ok(proof.checks.length >= 15)
assert.ok(Object.values(proof.cleanup).every(value => value === 'completed'))
assert.equal(proof.secretAudit.result, 'passed')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const secrets = new Set()
for (const [name, value] of Object.entries(process.env)) {
  if (!value || !/(?:SECRET|PASSWORD|TOKEN|API_KEY|DATABASE_URL)$/.test(name)) continue
  if (value.length >= 12) secrets.add(value)
  if (name.endsWith('DATABASE_URL')) {
    try { const password = decodeURIComponent(new URL(value).password); if (password.length >= 12) secrets.add(password) } catch {}
  }
}
let textFiles = 0
async function scan(path) {
  for (const name of await readdir(path)) {
    const file = join(path, name)
    if ((await stat(file)).isDirectory()) { await scan(file); continue }
    if (!/\.(?:json|mjs|md|txt|html)$/.test(name)) continue
    const text = await readFile(file, 'utf8'); textFiles++
    for (const secret of secrets) assert.ok(!text.includes(secret), 'Known private fixture material must not be exported')
    assert.ok(!/\b(?:orv_|mkw_|mka_|mkr_|mkp_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}/.test(text), 'Credential pattern must not be exported')
    assert.ok(!/postgres(?:ql)?:\/\/[^\s\/@:]+:[^\s@]+@/i.test(text), 'Database credential URL must not be exported')
  }
}
await scan(directory)
for (const capture of proof.captures) {
  const bytes = await readFile(join(directory, capture.file))
  assert.equal(hash(bytes), capture.sha256); assert.equal(hash(bytes), capture.get.sha256)
  assert.equal(bytes.length, capture.get.size); assert.equal(capture.get.status, 200)
  assert.equal(capture.get.decodeExitCode, 0)
  assert.equal(capture.get.archiveSource, 'authenticated-activity-get')
  if (capture.contentType === 'video/mp4') assert.equal(capture.get.rangeStatus, 206)
}
for (const document of proof.documents) {
  const bytes = await readFile(join(directory, 'activity-readback', document.file))
  assert.equal(hash(bytes), document.sha256); assert.equal(document.status, 200)
}
const selected = [...receipt.stages.flatMap(stage => [stage.id+'.mp4', ...['start','running','result'].map(mark=>stage.id+'-'+mark+'.png')]),
  ...proof.documents.map(document=>'activity-readback/'+document.file), 'activity-readback/proof.json', 'activity-readback/activity.json', 'receipt.json']
await mkdir(destination)
const files = {}
for (const relative of selected) {
  assert.ok(!relative.split('/').includes('..'))
  const source = join(directory, relative), target = join(destination, relative)
  await mkdir(join(target, '..'), {recursive:true})
  await cp(source, target)
  const bytes = await readFile(target)
  files[relative] = {size:bytes.length, sha256:hash(bytes)}
}
const result = {codeCommit:receipt.codeCommit, codeTree:receipt.codeTree, generatedAt:new Date().toISOString(),
  boundary:'Curated exact GET media plus four-stage terminal keyframes and independent registration witness. No environment descriptors, auth state, raw server logs, raw video or oversize source.',
  textPrivacyCheck:{textFiles, knownPrivateValuesChecked:secrets.size, result:'passed'},
  visualReview:'Pending direct frame review; isolated Xvfb shows only scrubbed command output already covered by the text privacy check.', files}
await writeFile(join(destination, 'curated-manifest.json'),JSON.stringify(result,null,2)+'\n')
await writeFile(join(directory, 'curation-precheck.json'),JSON.stringify({...result,files:undefined},null,2)+'\n')
console.log(JSON.stringify({destination,files:selected.length,textFiles,manifestSha256:hash(await readFile(join(destination,'curated-manifest.json')))}))
