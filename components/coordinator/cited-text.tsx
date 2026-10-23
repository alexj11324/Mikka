'use client'

import { Fragment, useState } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { getLinkPreview } from '@/app/actions/link-preview'
import { splitCitations, type CitationPart, type CitationSource, type IssueSource, type RunSource } from '@/lib/coordinator/citations'
import type { LinkPreview } from '@/lib/link-preview-parse'
import { cn } from 'cn'
import { Badge } from '@/components/reui/badge'
import { InlineCitation, InlineCitationBody, InlineCitationContent, InlineCitationDescription, InlineCitationFavicon, InlineCitationFooter, InlineCitationImage, InlineCitationLabel, InlineCitationMeta, InlineCitationSource, InlineCitationTitle, InlineCitationTrigger } from '@/components/ui/inline-citation'
import { SourceAvatar, SourcesList, SourcesSummary, type StreamingSource } from '@/components/ui/streaming-text'
import { Claude } from '@/components/ui/svgs/claude'
import { Mikka } from '@/components/ui/svgs/mikka'
import { OpenAI } from '@/components/ui/svgs/openai'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, issueIdentifier } from '@/components/workspace/issue-properties'

const RUN_BADGES: Record<string, 'info-light' | 'success-light' | 'destructive-light' | 'warning-light' | 'secondary'> = {
  queued: 'secondary', preparing: 'info-light', running: 'info-light', waiting_input: 'warning-light', finishing: 'info-light',
  succeeded: 'success-light', stopped: 'secondary', failed: 'destructive-light', cancelled: 'secondary',
}

type Previews = Record<string, LinkPreview | null>

/**
 * A Coordinator reply: its cited issues, runs and web pages as source chips
 * in the text, then an "N sources" toggle that lists them all. A citation it
 * cannot show stays as written.
 */
export function CitedText({ text, sources, onOpenIssue }: { text: string; sources: Record<string, CitationSource>; onOpenIssue: (id: string) => void }) {
  const t = useTranslations('Coordinator.citation')
  const [open, setOpen] = useState(false)
  const parts = splitCitations(text)
  const urls = [...new Set(parts.flatMap(part => part.type === 'link' ? [part.url] : []))]
  const { data: previews = {} } = useSWR<Previews>(urls.length ? ['link-previews', ...urls] : null, async () => {
    const results = await Promise.all(urls.map(url => getLinkPreview(url).catch(() => null)))
    return Object.fromEntries(urls.map((url, index) => [url, results[index]]))
  }, { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false })
  const resolve = (part: Extract<CitationPart, { type: 'citation' }>) => {
    const source = sources[part.id]
    return source && (!part.kind || part.kind === source.kind) ? source : null
  }
  const listed = new Map<string, StreamingSource>()
  for (const part of parts) {
    if (part.type === 'link') listed.set(part.url, linkSource(part.url, part.label, previews[part.url]))
    else if (part.type === 'citation') {
      const source = resolve(part)
      if (source?.kind === 'issue') listed.set(source.id, { name: source.title, domain: issueIdentifier(source, 'Mikka'), icon: <Mikka />, onSelect: () => onOpenIssue(source.id) })
      if (source?.kind === 'run') {
        const issue = source.issue
        listed.set(source.id, { name: t('runOf', { agent: source.agentName }), domain: source.harness === 'claude_code' ? 'Claude Code' : 'Codex', icon: source.harness === 'claude_code' ? <Claude /> : <OpenAI />, onSelect: issue ? () => onOpenIssue(issue.id) : undefined })
      }
    }
  }
  return <>
    {parts.map((part, index) => {
      if (part.type === 'text') return <Fragment key={index}>{part.text}</Fragment>
      if (part.type === 'link') return <LinkCitation key={index} url={part.url} label={part.label} preview={previews[part.url]} />
      const source = resolve(part)
      if (!source) return <Fragment key={index}>{part.raw}</Fragment>
      return source.kind === 'issue'
        ? <IssueCitation key={index} issue={source} onOpen={onOpenIssue} />
        : <RunCitation key={index} run={source} onOpen={onOpenIssue} />
    })}
    {listed.size > 0 && <div className="mt-2 flex flex-col whitespace-normal">
      <SourcesSummary sources={[...listed.values()]} label={t('sources', { count: listed.size })} open={open} onOpenChange={setOpen} className="-ml-1 self-start" />
      <SourcesList sources={[...listed.values()]} open={open} />
    </div>}
  </>
}

function IssueCitation({ issue, onOpen }: { issue: IssueSource; onOpen: (id: string) => void }) {
  const t = useTranslations('Coordinator.citation')
  const tIssue = useTranslations('Issue')
  const status = ISSUE_STATUSES.find(item => item.value === issue.status) ?? ISSUE_STATUSES[1]
  const priority = ISSUE_PRIORITIES.find(item => item.value === issue.priority)
  const tone = status.value === 'doing' ? 'text-warning-foreground' : status.value === 'review' ? 'text-success-foreground' : status.value === 'done' ? 'text-info-foreground' : 'text-muted-foreground'
  const identifier = issue.identifier
  return <InlineCitation>
    <InlineCitationTrigger aria-label={t('openIssue', { title: issue.title })} onClick={() => onOpen(issue.id)}>
      <SourceAvatar source={{ name: issue.title, domain: 'Mikka', icon: <Mikka /> }} />
      <InlineCitationLabel>{identifier ?? issue.title}</InlineCitationLabel>
    </InlineCitationTrigger>
    <InlineCitationContent>
      <InlineCitationBody>
        <InlineCitationSource><Mikka />{identifier ? `Mikka · ${identifier}` : 'Mikka'}</InlineCitationSource>
        <InlineCitationTitle>{issue.title}</InlineCitationTitle>
        <InlineCitationMeta>
          <span><status.icon className={cn(tone)} />{tIssue(`status.${status.value}`)}</span>
          {priority && <span><priority.icon {...priority.iconProps} />{tIssue(`priority.${priority.value}`)}</span>}
        </InlineCitationMeta>
      </InlineCitationBody>
    </InlineCitationContent>
  </InlineCitation>
}

function RunCitation({ run, onOpen }: { run: RunSource; onOpen: (id: string) => void }) {
  const t = useTranslations('Coordinator.citation')
  const format = useFormatter()
  const HarnessIcon = run.harness === 'claude_code' ? Claude : OpenAI
  const harness = run.harness === 'claude_code' ? 'Claude Code' : 'Codex'
  const issue = run.issue
  const status = t.has(`runStatus.${run.status}` as never) ? t(`runStatus.${run.status}` as never) : run.status
  return <InlineCitation>
    <InlineCitationTrigger
      aria-label={issue ? t('openRunIssue', { agent: run.agentName, title: issue.title }) : t('runOf', { agent: run.agentName })}
      onClick={issue ? () => onOpen(issue.id) : undefined}
    >
      <SourceAvatar source={{ name: harness, domain: harness, icon: <HarnessIcon /> }} />
      <InlineCitationLabel>{t('runOf', { agent: run.agentName })}</InlineCitationLabel>
    </InlineCitationTrigger>
    <InlineCitationContent>
      <InlineCitationBody>
        <InlineCitationSource><HarnessIcon />{harness} · {run.agentName}</InlineCitationSource>
        <InlineCitationTitle>{issue ? `${issue.identifier ? `${issue.identifier} ` : ''}${issue.title}` : t('noIssue')}</InlineCitationTitle>
        <InlineCitationMeta>
          <Badge variant={RUN_BADGES[run.status] ?? 'secondary'} size="sm">{status}</Badge>
          <span>{format.dateTime(new Date(run.finishedAt ?? run.createdAt), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        </InlineCitationMeta>
      </InlineCitationBody>
    </InlineCitationContent>
  </InlineCitation>
}

/** `repo#28` for a GitHub pull request or issue, else null. */
function githubLabel(url: URL): string | null {
  if (url.hostname !== 'github.com') return null
  const [owner, repo, kind, number] = url.pathname.split('/').filter(Boolean)
  return owner && repo && (kind === 'pull' || kind === 'issues') && /^\d+$/.test(number ?? '') ? `${repo}#${number}` : null
}

function describeLink(url: string, label: string | null, preview: LinkPreview | null | undefined) {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  const host = parsed.hostname.replace(/^www\./, '')
  return {
    host,
    name: label ?? githubLabel(parsed) ?? preview?.siteName ?? host,
    address: `${host}${parsed.pathname === '/' ? '' : parsed.pathname}`,
  }
}

function linkSource(url: string, label: string | null, preview: LinkPreview | null | undefined): StreamingSource {
  const link = describeLink(url, label, preview)
  return { name: preview?.title ?? link?.name ?? url, domain: link?.host ?? url, href: url, image: preview?.icon }
}

function LinkCitation({ url, label, preview }: { url: string; label: string | null; preview: LinkPreview | null | undefined }) {
  const link = describeLink(url, label, preview)
  if (!link) return <>{url}</>
  return <InlineCitation>
    <InlineCitationTrigger render={<a href={url} target="_blank" rel="noopener noreferrer" />}>
      <SourceAvatar source={{ name: link.name, domain: link.host, image: preview?.icon }} />
      <InlineCitationLabel>{link.name}</InlineCitationLabel>
    </InlineCitationTrigger>
    <InlineCitationContent>
      {preview?.image && <InlineCitationImage src={preview.image} />}
      <InlineCitationBody>
        <InlineCitationTitle>{preview?.title ?? label ?? link.address}</InlineCitationTitle>
        {preview?.description && <InlineCitationDescription>{preview.description}</InlineCitationDescription>}
      </InlineCitationBody>
      <InlineCitationFooter><InlineCitationFavicon src={preview?.icon} /><span className="min-w-0 truncate">{link.address}</span></InlineCitationFooter>
    </InlineCitationContent>
  </InlineCitation>
}
