import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import {
  CHAT_FILE_MAX_TEXT,
  chatFileReference,
  splitChatFiles,
  supportedChatFile,
  withChatFiles,
} from '@mikka/protocol/chat-attachments'
import { boundedChatFileBytes, extractChatFile } from './extract'

const id = '10000000-0000-4000-8000-000000000001'
const file = { id, name: '中文需求说明 [最终版].md' }
test('file references preserve original names, whitespace, repeated sends and attachment-only messages', () => {
  for (const text of ['', 'hello ', '\n# Title\n\n中文\n']) {
    assert.deepEqual(splitChatFiles(withChatFiles(text, [file])), { text, files: [file] })
  }
  assert.equal(splitChatFiles('plain text ').text, 'plain text ')
  assert.equal(splitChatFiles(`${chatFileReference(file)}\n${chatFileReference(file)}`).files.length, 1)
  assert.equal(splitChatFiles('[mikka-file:not-an-id:name]').files.length, 0)
  assert.equal(splitChatFiles(`[mikka-file:${id}:%E0]`).files.length, 0)
})
test('Markdown and source formats preserve their original contents, including fences and Chinese', async () => {
  const content = '# 需求\n\n```ts\nconst value = 1\n```\n'
  for (const name of [
    'readme.md',
    'readme.markdown',
    'page.mdx',
    'file.cpp',
    'app.swift',
    'Dockerfile',
    '.env',
    'table.csv',
  ]) {
    assert.equal(supportedChatFile(name), true)
    assert.equal((await extractChatFile(name, '', strToU8(content))).text, content)
  }
  await assert.rejects(extractChatFile('bad.txt', '', new Uint8Array([255, 0, 254])), { code: 'unreadable' })
  await assert.rejects(extractChatFile('binary.txt', '', new Uint8Array([65, 0, 66])), { code: 'unreadable' })
  await assert.rejects(extractChatFile('long.md', '', strToU8('x'.repeat(CHAT_FILE_MAX_TEXT + 1))), {
    code: 'tooLong',
  })
})

const xml = (value: string) => strToU8(value)
const docx = () =>
  zipSync({
    '[Content_Types].xml': xml(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': xml(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Project document</w:t></w:r></w:p><w:p><w:r><w:t>第二段内容</w:t></w:r></w:p></w:body></w:document>',
    ),
  })
test('real DOCX bytes yield ordered document text', async () => {
  const result = await extractChatFile('project.docx', '', docx())
  assert.match(result.text!, /Project document[\s\S]*第二段内容/)
})
test('Excel XLSX and legacy XLS retain worksheet names, headers and values', async () => {
  const xlsx = await import('@e965/xlsx')
  const book = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(
    book,
    xlsx.utils.aoa_to_sheet([
      ['Project', 'Revenue'],
      ['Mikka', 1250],
    ]),
    'Q4',
  )
  for (const ext of ['xlsx', 'xls'] as const) {
    const data = xlsx.write(book, { type: 'buffer', bookType: ext === 'xls' ? 'biff8' : 'xlsx' })
    const result = await extractChatFile(`revenue.${ext}`, '', data)
    assert.match(result.text!, /Q4/)
    assert.match(result.text!, /Revenue/)
    assert.match(result.text!, /Mikka/)
    assert.match(result.text!, /1250/)
  }
})
test('RTF is decoded as document text', async () => {
  const result = await extractChatFile(
    'notes.rtf',
    '',
    xml('{\\rtf1\\ansi A real document\\par Second paragraph}'),
  )
  assert.match(result.text!, /A real document/)
  assert.match(result.text!, /Second paragraph/)
})
test('PowerPoint slides, OpenDocument and EPUB retain readable document content', async () => {
  const pptx = zipSync({
    '[Content_Types].xml': xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    ),
    'ppt/presentation.xml': xml(
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
    ),
    'ppt/_rels/presentation.xml.rels': xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    ),
    ...Object.fromEntries(
      [1, 2].map((n) => [
        `ppt/slides/slide${n}.xml`,
        xml(
          `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Slide ${n} content</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
        ),
      ]),
    ),
  })
  assert.match(
    (await extractChatFile('slides.pptx', '', pptx)).text!,
    /Slide 1 content[\s\S]*Slide 2 content/,
  )
  for (const [ext, media, body] of [
    ['odt', 'text', '<office:text><text:p>OpenDocument content</text:p></office:text>'],
    [
      'odp',
      'presentation',
      '<office:presentation><draw:page draw:name="Slide 1"><draw:frame><draw:text-box><text:p>OpenDocument content</text:p></draw:text-box></draw:frame></draw:page></office:presentation>',
    ],
    [
      'ods',
      'spreadsheet',
      '<office:spreadsheet><table:table table:name="Q4"><table:table-row><table:table-cell office:value-type="string"><text:p>OpenDocument content</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>',
    ],
  ]) {
    const bytes = zipSync({
      mimetype: xml(`application/vnd.oasis.opendocument.${media}`),
      'content.xml': xml(
        `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body>${body}</office:body></office:document-content>`,
      ),
    })
    assert.match((await extractChatFile(`document.${ext}`, '', bytes)).text!, /OpenDocument content/)
  }
  const epub = zipSync({
    mimetype: xml('application/epub+zip'),
    'META-INF/container.xml': xml(
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': xml(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    ),
    'OEBPS/chapter.xhtml': xml(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Book</title></head><body><h1>Book content</h1><p>A real chapter.</p></body></html>',
    ),
  })
  assert.match((await extractChatFile('book.epub', '', epub)).text!, /Book content[\s\S]*A real chapter/)
})
test('PDF extracts real page text and valid audio bytes are distinguished from corrupt uploads', async () => {
  const stream = 'BT /F1 18 Tf 50 700 Td (Project PDF content) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n',
    offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  assert.match((await extractChatFile('paper.pdf', '', xml(pdf))).text!, /Project PDF content/)
  const wav = Buffer.alloc(16044)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(16000, 40)
  assert.equal((await extractChatFile('meeting.wav', 'audio/wav', wav)).mediaType, 'audio/wav')
})
test('actual PNG pixels are accepted and invalid image/audio/document bytes are rejected', async () => {
  const sharp = (await import('sharp')).default
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } })
    .png()
    .toBuffer()
  assert.equal((await extractChatFile('screenshot.png', 'image/png', png)).mediaType, 'image/png')
  for (const name of ['fake.png', 'fake.mp3', 'fake.pdf', 'fake.docx'])
    await assert.rejects(extractChatFile(name, '', strToU8('not that format')), { code: 'unreadable' })
  await assert.rejects(extractChatFile('program.exe', '', strToU8('binary')), { code: 'unsupported' })
})

test('remote object bytes are bounded while streaming, even without a trustworthy Content-Length', async () => {
  let cancelled = false,
    produced = 0
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced++
      controller.enqueue(new Uint8Array(1024))
    },
    cancel() {
      cancelled = true
    },
  })
  await assert.rejects(boundedChatFileBytes(oversized, 10), { code: 'tooLarge' })
  assert.equal(cancelled, true)
  assert.ok(produced < 4, 'the oversized object is cancelled before being buffered')
  await assert.rejects(boundedChatFileBytes(new Blob(['short']).stream(), 10), { code: 'unreadable' })
  assert.deepEqual(
    Buffer.from(await boundedChatFileBytes(new Blob(['exact']).stream(), 5)),
    Buffer.from('exact'),
  )
})
