'use client'

import { Fragment } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { getLinkPreview } from '@/app/actions/link-preview'
import { splitCitations, type CitationSource, type IssueSource, type RunSource } from '@/lib/coordinator/citations'
import { cn } from 'cn'
import { Badge } from '@/components/reui/badge'
import { InlineCitation, InlineCitationBody, InlineCitationContent, InlineCitationDescription, InlineCitationFavicon, InlineCitationFooter, InlineCitationImage, InlineCitationLabel, InlineCitationMeta, InlineCitationSource, InlineCitationTitle, InlineCitationTrigger } from '@/components/ui/inline-citation'
import { Claude } from '@/components/ui/svgs/claude'
import { Mikka } from '@/components/ui/svgs/mikka'
import { OpenAI } from '@/components/ui/svgs/openai'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, issueIdentifier } from '@/components/workspace/issue-properties'

const RUN_BADGES: Record<string, 'info-light' | 'success-light' | 'destructive-light' | 'warning-light' | 'secondary'> = {
  queued: 'secondary', preparing: 'info-light', running: 'info-light', waiting_input: 'warning-light', finishing: 'info-light',
  succeeded: 'success-light', stopped: 'secondary', failed: 'destructive-light', cancelled: 'secondary',
}

/** Reply text with its cited issues, runs and web pages shown as source chips. A citation it cannot show stays as written. */
export function CitedText({ text, sources, onOpenIssue }: { text: string; sources: Record<string, CitationSource>; onOpenIssue: (id: string) => void }) {
  return splitCitations(text).map((part, index) => {
    if (part.type === 'text') return <Fragment key={index}>{part.text}</Fragment>
    if (part.type === 'link') return <LinkCitation key={index} url={part.url} label={part.label} />
    const source = sources[part.id]
    if (!source || (part.kind && part.kind !== source.kind)) return <Fragment key={index}>{part.raw}</Fragment>
    return source.kind === 'issue'
      ? <IssueCitation key={index} issue={source} onOpen={onOpenIssue} />
      : <RunCitation key={index} run={source} onOpen={onOpenIssue} />
  })
}

function IssueCitation({ issue, onOpen }: { issue: IssueSource; onOpen: (id: string) => void }) {
  const t = useTranslations('Coordinator.citation')
  const tIssue = useTranslations('Issue')
  const status = ISSUE_STATUSES.find(item => item.value === issue.status) ?? ISSUE_STATUSES[1]
  const priority = ISSUE_PRIORITIES.find(item => item.value === issue.priority)
  const tone = status.value === 'doing' ? 'text-warning-foreground' : status.value === 'review' ? 'text-success-foreground' : status.value === 'done' ? 'text-info-foreground' : 'text-muted-foreground'
  const identifier = issue.number ? issueIdentifier(issue.number) : null
  return <InlineCitation>
    <InlineCitationTrigger aria-label={t('openIssue', { title: issue.title })} onClick={() => onOpen(issue.id)}>
      <Mikka />
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
      <HarnessIcon />
      <InlineCitationLabel>{t('runOf', { agent: run.agentName })}</InlineCitationLabel>
    </InlineCitationTrigger>
    <InlineCitationContent>
      <InlineCitationBody>
        <InlineCitationSource><HarnessIcon />{harness} · {run.agentName}</InlineCitationSource>
        <InlineCitationTitle>{issue ? `${issue.number ? `${issueIdentifier(issue.number)} ` : ''}${issue.title}` : t('noIssue')}</InlineCitationTitle>
        <InlineCitationMeta>
          <Badge variant={RUN_BADGES[run.status] ?? 'secondary'} size="sm">{status}</Badge>
          <span>{format.dateTime(new Date(run.finishedAt ?? run.createdAt), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        </InlineCitationMeta>
      </InlineCitationBody>
    </InlineCitationContent>
  </InlineCitation>
}

/** `owner/repo#28` for a GitHub pull request or issue, else null. */
function githubLabel(url: URL): string | null {
  if (url.hostname !== 'github.com') return null
  const [owner, repo, kind, number] = url.pathname.split('/').filter(Boolean)
  return owner && repo && (kind === 'pull' || kind === 'issues') && /^\d+$/.test(number ?? '') ? `${repo}#${number}` : null
}

function LinkCitation({ url, label }: { url: string; label: string | null }) {
  const { data: preview } = useSWR(['link-preview', url], () => getLinkPreview(url), { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false })
  let parsed: URL
  try { parsed = new URL(url) } catch { return <>{url}</> }
  const host = parsed.hostname.replace(/^www\./, '')
  const name = label ?? githubLabel(parsed) ?? preview?.siteName ?? host
  const address = `${host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  return <InlineCitation>
    <InlineCitationTrigger render={<a href={url} target="_blank" rel="noopener noreferrer" />}>
      <InlineCitationFavicon src={preview?.icon} />
      <InlineCitationLabel>{name}</InlineCitationLabel>
    </InlineCitationTrigger>
    <InlineCitationContent>
      {preview?.image && <InlineCitationImage src={preview.image} />}
      <InlineCitationBody>
        <InlineCitationTitle>{preview?.title ?? label ?? address}</InlineCitationTitle>
        {preview?.description && <InlineCitationDescription>{preview.description}</InlineCitationDescription>}
      </InlineCitationBody>
      <InlineCitationFooter><InlineCitationFavicon src={preview?.icon} /><span className="min-w-0 truncate">{address}</span></InlineCitationFooter>
    </InlineCitationContent>
  </InlineCitation>
}
