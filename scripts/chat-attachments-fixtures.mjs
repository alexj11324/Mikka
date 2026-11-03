import { zipSync, strToU8 } from 'fflate'
import { utils, write } from '@e965/xlsx'
import sharp from 'sharp'

export async function binaryAttachmentFixtures() {
  const docx = zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Actual Word content</w:t></w:r></w:p></w:body></w:document>',
    ),
  })
  const book = utils.book_new()
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([
      ['Project', 'Revenue'],
      ['Mikka', 1250],
    ]),
    'Q4',
  )
  const xlsx = write(book, { type: 'buffer', bookType: 'xlsx' })
  const stream = 'BT /F1 18 Tf 50 700 Td (Project PDF content) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } })
    .png()
    .toBuffer()
  return [
    ['说明.docx', docx, 'Actual Word content'],
    ['预算.xlsx', xlsx, 'Q4'],
    ['参考.pdf', Buffer.from(pdf), 'Project PDF content'],
    ['截图.png', png, null],
    ['记录.rtf', Buffer.from('{\\rtf1\\ansi Actual RTF content}'), 'Actual RTF content'],
  ]
}
