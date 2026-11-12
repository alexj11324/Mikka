'use client'

import { createContext, useContext, useState, type ComponentProps, type ReactNode } from 'react'
import useSWR from 'swr'
import { Globe } from 'lucide-react'
import { GitHubIcon } from '@/components/icons/brand-icons'
import { useFormatter, useTranslations } from 'next-intl'
import { getLinkPreview } from '@/app/actions/link-preview'
import { CITATION_HREF, splitCitations, type CitationKind, type CitationSource, type IssueSource, type RunSource, runTitle } from '@/lib/coordinator/citations'
import type { LinkPreview } from '@/lib/link-preview-parse'
import { InlineCitation, InlineCitationBody, InlineCitationContent, InlineCitationDescription, InlineCitationFavicon, InlineCitationFooter, InlineCitationImage, InlineCitationLabel, InlineCitationMeta, InlineCitationSource, InlineCitationTitle, InlineCitationTrigger } from '@/components/ui/inline-citation'
import { SourceAvatar, SourcesList, SourcesSummary, sourceTileClassName, type StreamingSource } from '@/components/ui/streaming-text'
import { Claude } from '@/components/ui/svgs/claude'
import { Mikka } from '@/components/ui/svgs/mikka'
import { OpenAI } from '@/components/ui/svgs/openai'
import { useTaskCards } from '@/hooks/use-task-cards'
import { TaskPresentationsContext } from '@/hooks/use-task-collection'
import { ISSUE_PRIORITIES } from '@/components/workspace/issue-properties'
import { TaskStateIcon, useTaskStateLabel } from '@/components/workspace/task-state-icon'
import { ThreadStatus } from '@/components/workspace/thread-status-icon'
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
   * Tasks whose thread the same reply cites. No longer read when rendering (decision 2026-11-10): the task is always
   * its own compact chip (state icon and code) and the thread its title, so neither repeats the other.
   */
  covered?: ReadonlySet<string>
  /** Legacy reply metadata; references use the same compact task chip / thread link even beside a dispatch card. */
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
  if (citations && href?.startsWith(CITATION_HREF)) {
    const [kind, id] = href.slice(CITATION_HREF.length).split('/') as [CitationKind | 'any', string]
    const source = citations.sources[id]
    if (!source && citations.pending) return <PendingCitation />
    if (!source || (kind !== 'any' && kind !== source.kind)) return <>{children}</>
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

/**
 * A task mentioned in a reply shows its code or title and its authorized state.
 * Older citations outside the workspace list share the mounted cards' batch.
 */
export function IssueCitation({ issue, onOpen }: { issue: IssueSource; onOpen: (id: string) => void }) {
  const t = useTranslations('Coordinator.citation')
  const tIssue = useTranslations('Issue')
  const stateLabel = useTaskStateLabel()
  const resident = useContext(TaskPresentationsContext)[issue.id]
  const cards = useTaskCards(resident ? [] : [issue.id])
  const presentation = resident ?? cards[issue.id]
  const priority = ISSUE_PRIORITIES.find(item => item.value === issue.priority)
  const identifier = issue.identifier
  const icon = presentation && <TaskStateIcon state={presentation.state} />
  return <InlineCitation>
    <InlineCitationTrigger variant="object" aria-label={t('openIssue', { title: issue.title })} data-focus-id={issue.id} data-task-chip={presentation?.state ?? ''} onClick={() => onOpen(issue.id)}>
      {identifier
        // A code never breaks: the icon and the code are one unit.
        ? <InlineCitationLabel><span data-slot="chip-head" className="whitespace-nowrap"><span data-slot="chip-icon" className="me-1 inline-flex align-[-0.125em]">{icon}</span>{identifier}</span></InlineCitationLabel>
        : <ChipHead icon={icon} title={issue.title} />}
    </InlineCitationTrigger>
    <InlineCitationContent>
      <InlineCitationBody>
        <InlineCitationSource><Mikka />{identifier ? `Mikka · ${identifier}` : 'Mikka'}</InlineCitationSource>
        <InlineCitationTitle>{issue.title}</InlineCitationTitle>
        <InlineCitationMeta>
          {presentation && <span data-task-state-label={presentation.state}>{icon}{stateLabel(presentation.state, presentation.reason)}</span>}
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

/**
 * The look of a thread named in a sentence (decision 2026-11-10): its title in the link colour, with no box, icon,
 * accent or state badge. Still the object chip's inline `span` button, so a long title wraps and the focus ring shows.
 */
const runLinkClassName = 'mx-0 rounded-sm bg-transparent px-0 text-object-chip-foreground underline-offset-4 hover:bg-transparent hover:underline data-popup-open:bg-transparent data-popup-open:underline'

/**
 * A thread mentioned in a reply: its title alone, as a link (its task's title without the code, since the task has
 * its own chip; else what it was asked). It opens the thread's conversation, never the task. The Agent, its coding
 * agent's mark, its state and time are in the hover card.
 */
export function RunCitation({ run }: { run: RunSource }) {
  const t = useTranslations('Coordinator.citation')
  const format = useFormatter()
  const HarnessIcon = run.harness === 'claude_code' ? Claude : OpenAI
  const harness = run.harness === 'claude_code' ? 'Claude Code' : 'Codex'
  const issue = run.issue
  const title = runTitle(run)
  return <InlineCitation>
    <InlineCitationTrigger
      variant="object"
      className={runLinkClassName}
      data-thread-link=""
      aria-label={t('openThread', { name: title })}
      onClick={() => openThread(run.id)}
    >
      <InlineCitationLabel>{title}</InlineCitationLabel>
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
