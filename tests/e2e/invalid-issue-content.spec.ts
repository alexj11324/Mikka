import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, seedTask, openIssueFromSearch } from './fixtures'

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Invalid-content acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

// A hash of the whole issues row (every column, so updatedAt/version/any write shows), plus the issue's issue_documents rows.
// content::text alone is jsonb-normalised and would hide a rewrite that keeps the same value.
async function snapshot(pool: Pool, issueId: string) {
  const { rows: [issue] } = await pool.query<{ row: string }>('SELECT md5(i::text) AS row FROM issues i WHERE i.id = $1', [issueId])
  const { rows: documents } = await pool.query<{ n: number; rows: string | null }>('SELECT count(*)::int AS n, md5(string_agg(d::text, \'|\' ORDER BY d::text)) AS rows FROM issue_documents d WHERE d."issueId" = $1', [issueId])
  return { row: issue.row, documents: documents[0] }
}

test.use({ expectedConsoleErrors: [], video: process.env.E2E_EVIDENCE_DIR ? 'on' : 'off' })

test('invalid stored content opens read-only with one notice and is byte-for-byte unchanged afterwards', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const consoleWarnings: string[] = []
  page.on('console', message => { if (message.type() === 'warning') consoleWarnings.push(message.text()) })
  await register(page)
  const title = `Invalid body ${randomUUID()}`
  await seedTask(page, title)
  const pool = isolatedPool()
  try {
    const { rows: [{ id }] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE title = $1', [title])
    // Keep the seeded metadata attrs; replace the body with a node the editor schema does not know.
    await pool.query(`UPDATE issues SET content = jsonb_set(content, '{content}', $2::jsonb) WHERE id = $1`, [id, JSON.stringify([{ type: 'paragraph', content: [{ type: 'mystery', text: 'original body that must survive' }] }])])
    const before = await snapshot(pool, id)
    assert(before.documents.n === 0)
    await openIssueFromSearch(page, title)
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title)
    const notice = page.getByRole('alert').filter({ hasText: '这段描述无法显示，已切换为只读。原内容未被改动。' })
    await expect(notice).toHaveCount(1)
    await expect(page.locator('.ProseMirror[contenteditable="false"]').first()).toBeVisible()
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toHaveCount(0)
    // Read-only: no autosave/sync label in the header or editor, and no typing hint.
    const header = page.locator('header').first()
    await expect(header.getByText('已自动保存')).toHaveCount(0)
    await expect(header.getByText('同步失败')).toHaveCount(0)
    await expect(page.getByText('同步失败')).toHaveCount(0)
    await expect(page.locator('.ProseMirror [data-placeholder]')).toHaveCount(0)
    const evidence = process.env.E2E_EVIDENCE_DIR
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      await page.emulateMedia({ colorScheme: 'light' })
      await page.screenshot({ path: `${evidence}/invalid-content-light.png` })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: `${evidence}/invalid-content-dark.png` })
      await page.emulateMedia({ colorScheme: 'light' })
    }
    // Longer than several sync intervals (1.5s) plus a focus revalidation.
    await page.waitForTimeout(5000)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(1500)
    await page.reload()
    await expect(notice).toHaveCount(1)
    const after = await snapshot(pool, id)
    expect(after.row).toBe(before.row)
    expect(after.documents).toEqual({ n: 0, rows: null })
    expect(consoleWarnings.filter(text => text.includes(id)).length).toBeLessThanOrEqual(2)
  } finally { await pool.end() }
})

function assert(value: boolean): asserts value { if (!value) throw new Error('fixture precondition failed') }
