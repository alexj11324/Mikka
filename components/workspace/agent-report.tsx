'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { useMemo, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Citations } from '@/components/agents/citations'
import { FileDiff, type FileDiffLine } from '@/components/agents/file-diff'
import { FileTree, FileTreeFile, FileTreeFolder } from '@/components/motion/file-tree'
import { Table, type TableColumn, type TableLabels } from '@/components/motion/table'
import { Timeline } from '@/components/motion/timeline'

type Cell = string | number
const ROW_HEIGHT = 44

/** beUI data table; every column sorts, numbers by value. */
export function AgentTable({ columns = [], rows = [] }: { columns?: string[]; rows?: Cell[][] }) {
  const agentCopy = useAgentCopy()
  const t = useTranslations('BeUi.table')
  const labels: TableLabels = {
    selectAll: t('selectAll'),
    selectRow: row => t('selectRow', { row }),
    columnOptions: column => t('columnOptions', { column }),
    rowOptions: row => t('rowOptions', { row }),
    reorderColumn: column => t('reorderColumn', { column }),
    renameColumn: column => t('renameColumn', { column }),
    resizeColumn: column => t('resizeColumn', { column }),
    editCell: (column, row) => t('editCell', { column, row }),
    emptyCell: t('emptyCell'),
    insertBefore: t('insertBefore'),
    insertAfter: t('insertAfter'),
    deleteColumn: t('deleteColumn'),
    deleteRow: t('deleteRow'),
  }
  const data = useMemo(() => rows.map(row => Object.fromEntries(columns.map((_, index) => [`c${index}`, row?.[index] ?? '']))), [columns, rows])
  const tableColumns = useMemo<TableColumn<Record<string, Cell>>[]>(() => columns.map((header, index) => ({
    key: `c${index}`,
    header,
    sortable: true,
    align: data.length > 0 && data.every(row => typeof row[`c${index}`] === 'number') ? 'right' : 'left',
  })), [columns, data])
  // Fit short tables instead of the default 440px viewport; longer ones scroll inside it.
  return <div className="w-full min-w-0 overflow-x-auto"><Table data={data} columns={tableColumns} rowHeight={ROW_HEIGHT} height={Math.min(440, ROW_HEIGHT * (Math.max(1, data.length) + 1) + 2)} emptyState={agentCopy.noData} labels={labels} /></div>
}

type Folder = { folders: Map<string, Folder>; files: string[] }

function folderNodes(folder: Folder, prefix: string): ReactNode[] {
  return [
    ...[...folder.folders].map(([name, child]) => <FileTreeFolder key={`${prefix}${name}/`} value={`${prefix}${name}/`} name={name}>{folderNodes(child, `${prefix}${name}/`)}</FileTreeFolder>),
    ...folder.files.map(name => <FileTreeFile key={`${prefix}${name}`} value={`${prefix}${name}`} name={name} />),
  ]
}

/** Groups slash-separated paths into beUI FileTree folders, every folder open. */
export function AgentFileTree({ paths = [] }: { paths?: string[] }) {
  const agentCopy = useAgentCopy()
  const { nodes, folders } = useMemo(() => {
    const root: Folder = { folders: new Map(), files: [] }
    const folders: string[] = []
    for (const path of new Set(paths)) {
      const parts = path.split('/').filter(Boolean)
      let folder = root
      parts.slice(0, -1).forEach((part, index) => {
        if (!folder.folders.has(part)) {
          folder.folders.set(part, { folders: new Map(), files: [] })
          folders.push(`${parts.slice(0, index + 1).join('/')}/`)
        }
        folder = folder.folders.get(part)!
      })
      const name = parts.at(-1)
      if (name && !path.endsWith('/')) folder.files.push(name)
    }
    return { nodes: folderNodes(root, ''), folders }
  }, [paths])
  return <FileTree ariaLabel={agentCopy.files} defaultExpandedIds={folders}>{nodes}</FileTree>
}

/** A suggested change as a beUI FileDiff: lines start with "+", "-" or a space. */
export function AgentFileDiff({ file, diff = '', language }: { file?: string; diff?: string; language?: 'bash' | 'diff' | 'json' | 'text' | 'tsx' }) {
  const lines = useMemo(() => {
    let oldLine = 0, newLine = 0
    return diff.replace(/\n$/, '').split('\n').map((line, index): FileDiffLine => {
      if (line.startsWith('+')) return { id: String(index), type: 'added', newLine: ++newLine, content: line.slice(1) }
      if (line.startsWith('-')) return { id: String(index), type: 'removed', oldLine: ++oldLine, content: line.slice(1) }
      return { id: String(index), type: 'context', oldLine: ++oldLine, newLine: ++newLine, content: line.startsWith(' ') ? line.slice(1) : line }
    })
  }, [diff])
  return <FileDiff file={file} lines={lines} language={language} defaultOpen collapseOnComplete={false} />
}

/** beUI Timeline with the description inside each card. */
export function AgentTimeline({ events = [] }: { events?: { date: string; title: string; description?: string; meta?: string }[] }) {
  const agentCopy = useAgentCopy()
  const t = useTranslations('BeUi.timeline')
  const locale = useLocale()
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }), [locale])
  const items = useMemo(() => events.map((event, index) => ({
    id: String(index),
    date: event.date,
    title: event.title,
    media: event.description ? <p className="line-clamp-5 p-3 text-sm leading-6 text-muted-foreground">{event.description}</p> : undefined,
    meta: event.meta,
  })), [events])
  return <Timeline events={items} height={360} itemWidth={280} years={false} aria-label={agentCopy.timeline} keyboardHint={t('keyboardHint')} formatDate={date => dateFormat.format(date)} className="w-full min-w-0" />
}

/** Sources actually read, as beUI Citations. */
export function AgentCitations({ sources = [] }: { sources?: { title: string; url: string }[] }) {
  const agentCopy = useAgentCopy()
  const citations = sources.map((source, index) => {
    let domain: string | undefined
    try { domain = new URL(source.url).hostname.replace(/^www\./, '') } catch { domain = undefined }
    return { id: String(index), title: source.title, url: source.url, domain }
  })
  return <Citations title={agentCopy.sources} citations={citations} defaultOpen />
}
