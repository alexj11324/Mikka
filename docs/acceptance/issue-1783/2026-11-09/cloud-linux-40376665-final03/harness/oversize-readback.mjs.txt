import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const [repo, output] = process.argv.slice(2)
assert.ok(repo && output)
await mkdir(output, { recursive: true })
const run = promisify(execFile)
const execute = (bin, args, options = {}) => run(bin, args, { timeout: 120_000, maxBuffer: 2_000_000, ...options })
const helperSource=join(repo,'packages/daemon/src/agents/capture-video.mjs')
const { processCaptureVideo, captureVideoBinaries, CAPTURE_TOOLCHAIN } = await import(pathToFileURL(helperSource).href)
const binaries=await captureVideoBinaries(),ffmpeg=binaries.ffmpeg,ffprobe=binaries.ffprobe
for(const name of ['ffmpeg','ffprobe']) {
  assert.ok(binaries[name].startsWith('/opt/mikka/runtime/capture-tools/'),'Exercise the real pinned product runtime')
  assert.equal(createHash('sha256').update(await readFile(binaries[name])).digest('hex'),CAPTURE_TOOLCHAIN.assets[name].sha256)
}
const source = join(output, 'oversized-source.mp4'), processed = join(output, 'processed.mp4')
console.log('Synthetic FFmpeg fixture; the terminal recording captures this actual execution.')
console.log('$ ffmpeg: generate a real 20-second red / idle gray / blue MP4')
await execute(ffmpeg, ['-y','-v','error','-f','lavfi','-i','color=c=red:s=160x120:r=10:d=2',
  '-f','lavfi','-i','color=c=gray:s=160x120:r=10:d=16','-f','lavfi','-i','color=c=blue:s=160x120:r=10:d=2',
  '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',source])
const handle = await open(source, 'r+')
const before = (await handle.stat()).size, atomSize = 100_000_001
const header = Buffer.alloc(8); header.writeUInt32BE(atomSize); header.write('free', 4)
await handle.write(header, 0, 8, before); await handle.truncate(before + atomSize); await handle.close()
const probe = async file => JSON.parse((await execute(ffprobe, ['-v','error','-select_streams','v:0',
  '-show_entries','format=duration,size:stream=codec_name,width,height,nb_frames','-of','json',file])).stdout)
const sourceProbe = await probe(source)
console.log('Source ffprobe:', JSON.stringify(sourceProbe))
assert.ok(Number(sourceProbe.format.size) > 100_000_000)
assert.equal(Number(sourceProbe.format.duration), 20)
console.log('$ ffmpeg -i oversized-source.mp4 -f null -   [full input decode]')
await execute(ffmpeg, ['-v','error','-i',source,'-f','null','-'])
const steps = [{ atMs:1500, durationMs:1000, label:'First action', source:'action' },
  { atMs:19500, durationMs:1000, label:'Final action', source:'action' }]
console.log('$ processCaptureVideo: real bounded processing from the pinned repository revision')
const previousPath=process.env.PATH
let result
try {
  process.env.PATH=join(output,'absent-tools')
  result=await processCaptureVideo(source, processed, { steps })
} finally { process.env.PATH=previousPath }
const outputProbe = await probe(processed)
console.log('Output ffprobe:', JSON.stringify(outputProbe))
console.log('$ ffmpeg -i processed.mp4 -f null -   [full output decode]')
await execute(ffmpeg, ['-v','error','-i',processed,'-f','null','-'])
assert.ok(result.size < 100_000_000); assert.equal(result.processing.trimmedMs, 14_500)
assert.ok(Math.abs(result.durationMs - 5500) < 150)
assert.deepEqual(result.steps.map(step => step.atMs), [1500,5000])
const pixel = async last => [...(await execute(ffmpeg, ['-v','error',...(last?['-sseof','-0.2']:[]),'-i',processed,
  '-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'], {encoding:'buffer'})).stdout]
const first = await pixel(false), last = await pixel(true)
assert.ok(first[0]>180 && first[2]<60); assert.ok(last[2]>180 && last[0]<60)
for (const [name, args] of [['first-action.png', []], ['final-action.png', ['-sseof','-0.2']]])
  await execute(ffmpeg,['-y','-v','error',...args,'-i',processed,'-frames:v','1',join(output,name)])
const describe = async file => ({ size:(await stat(file)).size, sha256:createHash('sha256').update(await readFile(file)).digest('hex') })
console.log('$ copied standalone computer helper with PATH unavailable; real pinned ffmpeg/ffprobe')
const copiedDirectory=join(output,'copied-helper'),copiedOutput=join(output,'copied-helper.mp4')
await mkdir(copiedDirectory)
await copyFile(helperSource,join(copiedDirectory,'capture-video.mjs'))
await writeFile(join(copiedDirectory,'steps.json'),JSON.stringify({steps})+'\n')
const copied=JSON.parse((await execute(process.execPath,[join(copiedDirectory,'capture-video.mjs'),source,copiedOutput,join(copiedDirectory,'steps.json')],
  {env:{...process.env,PATH:join(output,'absent-tools')}})).stdout)
await execute(ffmpeg,['-v','error','-i',copiedOutput,'-f','null','-'])
const copiedDescription=await describe(copiedOutput),directDescription=await describe(processed)
assert.equal(copiedDescription.sha256,directDescription.sha256)
assert.deepEqual(copied.steps,result.steps)
const receipt = { kind:'synthetic-real-ffmpeg-regression', source:await describe(source), output:await describe(processed),
  sourceProbe, outputProbe, processing:result, fullInputDecode:true, fullOutputDecode:true, firstPixel:first, lastPixel:last,
  productToolchain:{id:CAPTURE_TOOLCHAIN.id,version:CAPTURE_TOOLCHAIN.version,binaries,systemPathAvailable:false},
  copiedHelper:{...copiedDescription,processing:copied,probe:await probe(copiedOutput),fullOutputDecode:true,sameBytesAsDaemon:true,systemPathAvailable:false} }
await writeFile(join(output,'readback.json'), JSON.stringify(receipt,null,2)+'\n')
console.log('READBACK PASS:', JSON.stringify({ inputBytes:receipt.source.size, outputBytes:receipt.output.size,
  durationMs:result.durationMs, trimmedMs:result.processing.trimmedMs, offsets:result.steps.map(step=>step.atMs), first, last,
  productToolchain:CAPTURE_TOOLCHAIN.id,copiedHelperSameSha:copiedDescription.sha256,systemPathAvailable:false }))
