'use client'

import { createContext, useContext, useState, type ComponentProps, type ReactNode } from 'react'
import useSWR from 'swr'
import { Globe } from 'lucide-react'
import { GitHubIcon } from '@/components/icons/brand-icons'
import { useFormatter, useTranslations } from 'next-intl'
import { getLinkPreview } from '@/app/actions/link-preview'
import { CITATION_HREF, splitCitations, type CitationKind, type CitationSource, type IssueSource, type RunSource, runThreadName } from '@/lib/coordinator/citations'
import type { LinkPreview } from '@/lib/link-preview-parse'
import { cn } from 'cn'
import { InlineCitation, InlineCitationBody, InlineCitationContent, InlineCitationDescription, InlineCitationFavicon, InlineCitationFooter, InlineCitationImage, InlineCitationLabel, InlineCitationMeta, InlineCitationSource, InlineCitationTitle, InlineCitationTrigger } from '@/components/ui/inline-citation'
import { SourceAvatar, SourcesList, SourcesSummary, sourceTileClassName, type StreamingSource } from '@/components/ui/streaming-text'
import { Claude } from '@/components/ui/svgs/claude'
import { Mikka } from '@/components/ui/svgs/mikka'
import { OpenAI } from '@/components/ui/svgs/openai'
import { statusIconTints } from '@/lib/status-appearance'
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from '@/components/workspace/issue-properties'
import { ThreadStatus, ThreadStatusIcon, threadGroupOfRun } from '@/components/workspace/thread-status-icon'
import { openThread } from '@/components/workspace/workspace-navigation'

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
  /** A reply still arriving, or its cited issues and runs still being looked up: a chip not known yet holds its place. */
  pending?: boolean
  /**
   * Tasks whose thread the same reply cites: a task and its thread are one piece of work (R-81), so only the thread
   * is a chip and the task is its number in the sentence, or 「这个任务」 without one (R-15).
   */
  covered?: ReadonlySet<string>
  /** Threads whose card sits under this same reply: the card is the object, so the words name it without a second chip (R-66). */
  carded?: ReadonlySet<string>
}

/** The tasks in `text` whose thread `text` also cites, for AgentCitations.covered. */
export function coveredIssues(text: string, sources: Record<string, CitationSource>): ReadonlySet<string> {
  const covered = new Set<string>()
  for (const part of splitCitations(text)) {
    if (part.type !== 'citation') continue
    const source = sources[part.id]
    if (source?.kind === 'run' && source.issue) covered.add(source.issue.id)
  }
  return covered
}

export const AgentCitationsContext = createContext<AgentCitations | null>(null)

export function useAgentCitations() {
  return useContext(AgentCitationsContext)
}

/**
 * A chip's icon and title. The icon and the title's first character are held together, so a chip that wraps with the
 * sentence never leaves its icon alone at a line's end (R-15); the rest of the title wraps like words.
 */
function ChipHead({ icon, title }: { icon: ReactNode; title: string }) {
  const [first = '', ...rest] = Array.from(title)
  return <InlineCitationLabel>
    {/* The icon sits in an inline box: a reset that makes `svg` a block cannot drop it onto its own line. */}
    <span data-slot="chip-head" className="whitespace-nowrap"><span data-slot="chip-icon" className="me-1 inline-flex align-[-0.125em]">{icon}</span>{first}</span>{rest.join('')}
  </InlineCitationLabel>
}

/** One empty value, so a chat with no web links keeps the same citations across renders. */
const NO_PREVIEWS: LinkPreviews = {}

/** Link previews for every web page cited in `texts`, fetched once. */
export function useLinkPreviews(texts: readonly string[]): LinkPreviews {
  const urls = [...new Set(texts.flatMap(text => splitCitations(text).flatMap(part => part.type === 'link' ? [part.url] : [])))].sort()
  const { data = NO_PREVIEWS } = useSWR<LinkPreviews>(urls.length ? ['link-previews', ...urls] : null, async () => {
    const results = await Promise.all(urls.map(url => getLinkPreview(url).catch(() => null)))
    return Object.fromEntries(urls.map((url, index) => [url, results[index]]))
  }, { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false })
  return data
}

/** Markdown `a`: a citation or web link as a source chip when the conversation provides citations. */
export function CitationAnchor({ href, children, className: _className, ...props }: ComponentProps<'a'>) {
  const citations = useAgentCitations()
  const t = useTranslations('Coordinator.citation')
  if (citations && href?.startsWith(CITATION_HREF)) {
    const [kind, id] = href.slice(CITATION_HREF.length).split('/') as [CitationKind | 'any', string]
    const source = citations.sources[id]
    if (!source && citations.pending) return <PendingCitation />
    if (!source || (kind !== 'any' && kind !== source.kind)) return <>{children}</>
    // The thread chip already carries the task's title: the task is its number, or 「这个任务」 when it has none, so the
    // sentence still reads (「这个任务的线程 …」, never 「的线程 …」).
    if (source.kind === 'issue' && citations.covered?.has(id)) return <span data-citation-covered="">{source.identifier ?? t('thisTask')}</span>
    if (source.kind === 'run' && citations.carded?.has(id)) return <span data-citation-carded="">{runThreadName(source)}</span>
    return <CitationChip id={id} kind={source.kind} />
  }
  if (citations && href && /^https?:\/\//i.test(href)) return <WebCitation url={href} label={typeof children === 'string' && children !== href ? children : null} />
  return <a {...props} href={href} className="text-primary underline underline-offset-4" target="_blank" rel="noopener noreferrer">{children}</a>
}

/**
 * The "N sources" toggle under a reply, listing the web pages it cites. Tasks and threads are not listed: they are
 * already chips in the words, and the thread has its card (R-15). Nothing when it cites no page.
 */
export function CitationSources({ text }: { text: string }) {
  const t = useTranslations('Coordinator.citation')
  const citations = useAgentCitations()
  const [open, setOpen] = useState(false)
  if (!citations) return null
  const listed = new Map<string, StreamingSource>()
  for (const part of splitCitations(text)) if (part.type === 'link') listed.set(part.url, linkSource(part.url, part.label, citations.previews[part.url]))
  if (!listed.size) return null
  return <div className="flex flex-col">
    <SourcesSummary sources={[...listed.values()]} label={t('sources', { count: listed.size })} open={open} onOpenChange={setOpen} className="self-start" />
    <SourcesList sources={[...listed.values()]} open={open} />
  </div>
}

/** The place of a task or thread chip whose task or thread is still being looked up; never its id or marker. */
export function PendingCitation() {
  return <span aria-hidden="true" data-citation-pending="" className="mx-0.5 inline-block h-5 w-16 translate-y-[-1px] animate-pulse rounded-[5px] bg-object-chip align-middle motion-reduce:animate-none" />
}

/** A task mentioned in a reply: a boxed chip with its status icon and title; the number is in the hover card. */
export function IssueCitation({ issue, onOpen }: { issue: IssueSource; onOpen: (id: string) => void }) {
  const t = useTranslations('Coordinator.citation')
  const tIssue = useTranslations('Issue')
  const status = ISSUE_STATUSES.find(item => item.value === issue.status) ?? ISSUE_STATUSES[1]
  const priority = ISSUE_PRIORITIES.find(item => item.value === issue.priority)
  const identifier = issue.identifier
  return <InlineCitation>
    <InlineCitationTrigger variant="object" aria-label={t('openIssue', { title: issue.title })} data-focus-id={issue.id} onClick={() => onOpen(issue.id)}>
      <ChipHead icon={<status.icon aria-hidden="true" className={cn('size-3.5 shrink-0', statusIconTints[status.tone])} />} title={issue.title} />
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
  if (!source && citations?.pending) return <PendingCitation />
  if (!citations || source?.kind !== kind) return <>{id}</>
  return source.kind === 'issue'
    ? <IssueCitation issue={source} onOpen={citations.onOpenIssue} />
    : <RunCitation run={source} />
}

/** A cited web page as a chip with its link preview; a plain link outside a conversation that cites. */
export function WebCitation({ url, label }: { url: string; label: string | null }) {
  const citations = useAgentCitations()
  if (!citations) return <a href={url} className="text-primary underline underline-offset-4" target="_blank" rel="noopener noreferrer">{label ?? url}</a>
  return <LinkCitation url={url} label={label} preview={citations.previews[url]} />
}

/** A thread mentioned in a reply: a boxed chip with its status icon and name; it opens the thread's conversation, never the task. */
export function RunCitation({ run }: { run: RunSource }) {
  const t = useTranslations('Coordinator.citation')
  const format = useFormatter()
  const HarnessIcon = run.harness === 'claude_code' ? Claude : OpenAI
  const harness = run.harness === 'claude_code' ? 'Claude Code' : 'Codex'
  // A thread is a bubble in the chip's accent, its state a dot on it, as on the thread card and the Threads list; the coding agent's mark is in the hover card (R-78).
  const issue = run.issue
  const name = runThreadName(run)
  const group = threadGroupOfRun(run.status, run.outcome)
  const attention = group === 'waiting' || group === 'blocked'
  return <InlineCitation>
    <InlineCitationTrigger
      variant="object"
      aria-label={issue ? t('openThread', { name }) : t('runOf', { bot: run.agentName })}
      onClick={issue ? () => openThread(run.id) : undefined}
    >
      <ChipHead icon={<ThreadStatusIcon status={run.status} outcome={run.outcome} small accent dot={attention} />} title={name} />
      {/* Waiting for you or blocked: the dot, its colour and its word together (R-87); other states are in the hover card. */}
      {/* The same state badge as the thread card and an open thread (R-90), its word on its tint. */}
      {attention && <span data-thread-attention={group} className="ml-1 inline-flex align-[-0.125em] whitespace-nowrap"><ThreadStatus status={run.status} outcome={run.outcome} icon={false} /></span>}
    </InlineCitationTrigger>
    <InlineCitationContent>
      <InlineCitationBody>
        <InlineCitationSource>{run.agentName} · <HarnessIcon />{harness}</InlineCitationSource>
        <InlineCitationTitle>{issue ? `${issue.identifier ? `${issue.identifier} ` : ''}${issue.title}` : t('noIssue')}</InlineCitationTitle>
        <InlineCitationMeta>
          <ThreadStatus status={run.status} outcome={run.outcome} />
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
