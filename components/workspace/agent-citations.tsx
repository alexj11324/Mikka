'use client'

import { createContext, useContext, useState, type ComponentProps } from 'react'
import useSWR from 'swr'
import { Globe } from 'lucide-react'
import { GitHubIcon } from '@/components/icons/brand-icons'
import { useFormatter, useTranslations } from 'next-intl'
import { getLinkPreview } from '@/app/actions/link-preview'
import { CITATION_HREF, splitCitations, type CitationKind, type CitationSource, type IssueSource, type RunSource } from '@/lib/coordinator/citations'
import type { LinkPreview } from '@/lib/link-preview-parse'
import { cn } from 'cn'
import { HarnessMark } from '@/components/labels/entity-labels'
import { Badge } from '@/components/reui/badge'
import { InlineCitation, InlineCitationBody, InlineCitationContent, InlineCitationDescription, InlineCitationFavicon, InlineCitationFooter, InlineCitationImage, InlineCitationLabel, InlineCitationMeta, InlineCitationSource, InlineCitationTitle, InlineCitationTrigger } from '@/components/ui/inline-citation'
import { SourceAvatar, SourcesList, SourcesSummary, sourceTileClassName, type StreamingSource } from '@/components/ui/streaming-text'
import { Claude } from '@/components/ui/svgs/claude'
import { Mikka } from '@/components/ui/svgs/mikka'
import { OpenAI } from '@/components/ui/svgs/openai'
import { statusIconTints } from '@/lib/status-appearance'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, issueIdentifier } from '@/components/workspace/issue-properties'

export const RUN_BADGES: Record<string, 'info-light' | 'success-light' | 'destructive-light' | 'warning-light' | 'secondary'> = {
  queued: 'secondary', preparing: 'success-light', running: 'success-light', waiting_input: 'warning-light', finishing: 'success-light',
  succeeded: 'info-light', stopped: 'secondary', failed: 'destructive-light', cancelled: 'secondary',
}

export type LinkPreviews = Record<string, LinkPreview | null>

/**
 * What a conversation's replies cite: the issues and runs looked up for the
 * person, and link previews for web pages. Inside it, Markdown shows citations
 * and web links as source chips; outside it, as plain text and links.
 */
export interface AgentCitations {
  sources: Record<string, CitationSource>
  previews: LinkPreviews
  onOpenIssue: (id: string) => void
}

export const AgentCitationsContext = createContext<AgentCitations | null>(null)

export function useAgentCitations() {
  return useContext(AgentCitationsContext)
}

/** Link previews for every web page cited in `texts`, fetched once. */
export function useLinkPreviews(texts: readonly string[]): LinkPreviews {
  const urls = [...new Set(texts.flatMap(text => splitCitations(text).flatMap(part => part.type === 'link' ? [part.url] : [])))].sort()
  const { data = {} } = useSWR<LinkPreviews>(urls.length ? ['link-previews', ...urls] : null, async () => {
    const results = await Promise.all(urls.map(url => getLinkPreview(url).catch(() => null)))
    return Object.fromEntries(urls.map((url, index) => [url, results[index]]))
  }, { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false })
  return data
}

/** Markdown `a`: a citation or web link as a source chip when the conversation provides citations. */
export function CitationAnchor({ href, children, className: _className, ...props }: ComponentProps<'a'>) {
  const citations = useAgentCitations()
  if (citations && href?.startsWith(CITATION_HREF)) {
    const [kind, id] = href.slice(CITATION_HREF.length).split('/') as [CitationKind | 'any', string]
    const source = citations.sources[id]
    if (!source || (kind !== 'any' && kind !== source.kind)) return <>{children}</>
    return <CitationChip id={id} kind={source.kind} />
  }
  if (citations && href && /^https?:\/\//i.test(href)) return <WebCitation url={href} label={typeof children === 'string' && children !== href ? children : null} />
  return <a {...props} href={href} className="text-primary underline underline-offset-4" target="_blank" rel="noopener noreferrer">{children}</a>
}

/** The "N sources" toggle under a reply, listing every issue, run and page it cites. */
export function CitationSources({ text }: { text: string }) {
  const t = useTranslations('Coordinator.citation')
  const citations = useAgentCitations()
  const [open, setOpen] = useState(false)
  if (!citations) return null
  const { sources, previews, onOpenIssue } = citations
  const listed = new Map<string, StreamingSource>()
  for (const part of splitCitations(text)) {
    if (part.type === 'link') listed.set(part.url, linkSource(part.url, part.label, previews[part.url]))
    else if (part.type === 'citation') {
      const source = sources[part.id]
      if (!source || (part.kind && part.kind !== source.kind)) continue
      if (source.kind === 'issue') listed.set(source.id, { name: source.title, domain: issueIdentifier(source, 'Mikka'), icon: <Mikka />, onSelect: () => onOpenIssue(source.id) })
      else {
        const issue = source.issue
        listed.set(source.id, { name: source.name, domain: source.agentName, icon: <HarnessMark harness={source.harness} />, onSelect: issue ? () => onOpenIssue(issue.id) : undefined })
      }
    }
  }
  if (!listed.size) return null
  return <div className="flex flex-col">
    <SourcesSummary sources={[...listed.values()]} label={t('sources', { count: listed.size })} open={open} onOpenChange={setOpen} className="-ml-1 self-start" />
    <SourcesList sources={[...listed.values()]} open={open} />
  </div>
}

/** A task mentioned in a reply: a boxed chip with its status icon and title; the number is in the hover card. */
export function IssueCitation({ issue, onOpen }: { issue: IssueSource; onOpen: (id: string) => void }) {
  const t = useTranslations('Coordinator.citation')
  const tIssue = useTranslations('Issue')
  const status = ISSUE_STATUSES.find(item => item.value === issue.status) ?? ISSUE_STATUSES[1]
  const priority = ISSUE_PRIORITIES.find(item => item.value === issue.priority)
  const identifier = issue.identifier
  return <InlineCitation>
    <InlineCitationTrigger variant="object" aria-label={t('openIssue', { title: issue.title })} onClick={() => onOpen(issue.id)}>
      <status.icon aria-hidden="true" className={cn('size-3.5 shrink-0', statusIconTints[status.tone])} />
      <InlineCitationLabel>{issue.title}</InlineCitationLabel>
    </InlineCitationTrigger>
    <InlineCitationContent>
      <InlineCitationBody>
        <InlineCitationSource><Mikka />{identifier ? `Mikka · ${identifier}` : 'Mikka'}</InlineCitationSource>
        <InlineCitationTitle>{issue.title}</InlineCitationTitle>
        <InlineCitationMeta>
          <span><status.icon className={cn(statusIconTints[status.tone])} />{tIssue(`status.${status.value}`)}</span>
          {priority && <span><priority.icon {...priority.iconProps} />{tIssue(`priority.${priority.value}`)}</span>}
        </InlineCitationMeta>
      </InlineCitationBody>
    </InlineCitationContent>
  </InlineCitation>
}

/** A cited issue or run by id, as a chip; the raw id when the conversation cannot show it. */
export function CitationChip({ id, kind }: { id: string; kind: CitationKind }) {
  const citations = useAgentCitations()
  const source = citations?.sources[id]
  if (!citations || source?.kind !== kind) return <>{id}</>
  return source.kind === 'issue'
    ? <IssueCitation issue={source} onOpen={citations.onOpenIssue} />
    : <RunCitation run={source} onOpen={citations.onOpenIssue} />
}

/** A cited web page as a chip with its link preview; a plain link outside a conversation that cites. */
export function WebCitation({ url, label }: { url: string; label: string | null }) {
  const citations = useAgentCitations()
  if (!citations) return <a href={url} className="text-primary underline underline-offset-4" target="_blank" rel="noopener noreferrer">{label ?? url}</a>
  return <LinkCitation url={url} label={label} preview={citations.previews[url]} />
}

export function RunCitation({ run, onOpen }: { run: RunSource; onOpen: (id: string) => void }) {
  const t = useTranslations('Coordinator.citation')
  const format = useFormatter()
  const HarnessIcon = run.harness === 'claude_code' ? Claude : OpenAI
  const harness = run.harness === 'claude_code' ? 'Claude Code' : 'Codex'
  // The coding agent runs the thread, so its mark is the thread's face; the bot only dispatched it (R-78).
  const issue = run.issue
  const status = t.has(`runStatus.${run.status}` as never) ? t(`runStatus.${run.status}` as never) : run.status
  return <InlineCitation>
    <InlineCitationTrigger
      variant="object"
      aria-label={issue ? t('openRunIssue', { agent: run.agentName, title: issue.title }) : t('runOf', { agent: run.agentName })}
      onClick={issue ? () => onOpen(issue.id) : undefined}
    >
      <SourceAvatar source={{ name: run.agentName, domain: run.agentName, icon: <HarnessMark harness={run.harness} /> }} className="size-3.5 rounded-full" />
      <InlineCitationLabel>{run.name}</InlineCitationLabel>
    </InlineCitationTrigger>
    <InlineCitationContent>
      <InlineCitationBody>
        <InlineCitationSource>{run.agentName} · <HarnessIcon />{harness}</InlineCitationSource>
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

/**
 * GitHub's favicon is its black mark, which vanished on the dark page; its mark in the text colour holds in both
 * themes, as GitHub's own light mark does on dark (R-74). Other sites keep their favicon.
 */
function linkIcon(host: string | undefined, preview: LinkPreview | null | undefined) {
  return host === 'github.com' ? { image: undefined, icon: <GitHubIcon /> } : { image: preview?.icon, icon: <Globe /> }
}

function linkSource(url: string, label: string | null, preview: LinkPreview | null | undefined): StreamingSource {
  const link = describeLink(url, label, preview)
  return { name: preview?.title ?? link?.name ?? url, domain: link?.host ?? url, href: url, ...linkIcon(link?.host, preview) }
}

export function LinkCitation({ url, label, preview }: { url: string; label: string | null; preview: LinkPreview | null | undefined }) {
  const link = describeLink(url, label, preview)
  if (!link) return <>{url}</>
  const mark = linkIcon(link.host, preview)
  return <InlineCitation>
    <InlineCitationTrigger render={<a href={url} target="_blank" rel="noopener noreferrer" />}>
      <SourceAvatar source={{ name: link.name, domain: link.host, ...mark }} className={sourceTileClassName} />
      <InlineCitationLabel>{link.name}</InlineCitationLabel>
    </InlineCitationTrigger>
    <InlineCitationContent>
      {preview?.image && <InlineCitationImage src={preview.image} />}
      <InlineCitationBody>
        <InlineCitationTitle>{preview?.title ?? label ?? link.address}</InlineCitationTitle>
        {preview?.description && <InlineCitationDescription>{preview.description}</InlineCitationDescription>}
      </InlineCitationBody>
      <InlineCitationFooter>{mark.image ? <InlineCitationFavicon src={mark.image} /> : mark.icon}<span className="min-w-0 truncate">{link.address}</span></InlineCitationFooter>
    </InlineCitationContent>
  </InlineCitation>
}
