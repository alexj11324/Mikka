export const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const home = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const ownerReads = []
export const revisionReads = []
export const workspacePool = { async query(sql, values) {
  if (!sql.includes('mikka_workspaces') || values[0] !== owner) throw new Error('unexpected owner read')
  ownerReads.push({ ownerId: values[0] })
  return { rows: [{ ownerId: owner, workspaceId: home }] }
} }
export const pool = { async query(sql, values) {
  if (!sql.startsWith('SELECT r.kind')) throw new Error('unexpected revision statement')
  const rows = values[0].map((kind, index) => ({ kind, id: values[1][index], revision: '7' }))
  revisionReads.push({ kinds: [...values[0]], ids: [...values[1]], rowCount: rows.length })
  return { rows }
} }
