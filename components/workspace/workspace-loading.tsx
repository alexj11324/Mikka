import { useTranslations } from '@/lib/intl/i18n-client'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The frame every page's placeholder wears: the bar across its top, then whatever the page draws
 * under it. A page that loads as a blank grey column reads as the window going away for a moment;
 * the same page with its own frame standing reads as its content arriving. So each placeholder
 * below is the page it stands in for, body and all, and only the body is grey.
 *
 * Nothing here animates (R-37): the skeleton's own pulse and the shared skeleton → content reveal
 * (`useRevealLoaded`, keyed on `data-loading-placeholder`) are the whole of the motion.
 */
function LoadingPage({ label, bar = true, children }: { label: string; bar?: boolean; children: ReactNode }) {
  return <div role="status" aria-label={label} aria-busy="true" data-loading-placeholder="" className="flex min-h-0 flex-1 flex-col">
    <span className="sr-only">{label}</span>
    <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col">
      {bar && <div className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
        <Skeleton className="h-4 w-32" />
        <div className="flex items-center gap-1"><Skeleton className="size-7 rounded-md" /><Skeleton className="size-7 rounded-md" /></div>
      </div>}
      {children}
    </div>
  </div>
}

/** A list page's toolbar: its title and count on the left, its filters and its action on the right. */
function LoadingToolbar({ title }: { title?: string }) {
  return <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
    <div className="flex flex-wrap items-center gap-2">
      {title ? <h1 className="text-xl font-semibold">{title}</h1> : <Skeleton className="h-6 w-32" />}
      <Skeleton className="h-5 w-8 rounded-full" />
      <Skeleton className="h-7 w-24 rounded-md" />
    </div>
    <div className="flex items-center gap-2">
      <Skeleton className="h-7 w-40 rounded-md" />
      <Skeleton className="h-7 w-16 rounded-md" />
      <Skeleton className="h-7 w-24 rounded-md" />
    </div>
  </div>
}

/**
 * 看板 and the task list: the toolbar, then the columns the board draws — or, in its list view, the
 * rows. `title` is the page's own name, which the workspace knows while the first page of tasks reads.
 */
export function BoardPageLoading({ title, view = 'board' }: { title?: string; view?: 'board' | 'list' }) {
  const t = useTranslations('Workspace')
  return <LoadingPage label={t('loading')} bar={false}>
    <LoadingToolbar title={title} />
    {view === 'board'
      ? <div className="flex min-h-0 flex-1 gap-3 px-4 pb-4 sm:px-6">{Array.from({ length: 4 }, (_, column) => <div key={column} className="flex w-64 shrink-0 flex-col gap-2">
        <Skeleton className="h-5 w-24" />
        {Array.from({ length: 3 - column % 2 }, (_, card) => <Skeleton key={card} className="h-24 w-full rounded-xl" />)}
      </div>)}</div>
      : <div className="flex flex-col gap-1 px-4 pb-4 sm:px-6">{Array.from({ length: 8 }, (_, row) => <Skeleton key={row} className="h-12 w-full rounded-lg" />)}</div>}
  </LoadingPage>
}

/** 项目: its title row, its filter row, then the table under them. */
export function ProjectsPageLoading() {
  const t = useTranslations('Workspace')
  return <LoadingPage label={t('loading')} bar={false}>
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><Skeleton className="h-6 w-32" /><Skeleton className="h-7 w-24 rounded-md" /></div>
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
      <Skeleton className="h-4 w-24" />
      <div className="flex flex-wrap items-center gap-2"><Skeleton className="h-7 w-20 rounded-md" /><Skeleton className="h-7 w-40 rounded-md" /><Skeleton className="h-7 w-24 rounded-md" /></div>
    </div>
    <div className="flex flex-col gap-1 px-3 pb-4">{Array.from({ length: 6 }, (_, row) => <Skeleton key={row} className="h-12 w-full" />)}</div>
  </LoadingPage>
}

/** 项目详情: the row naming the project with its actions, its tabs, then the open tab's body. */
export function ProjectDetailLoading() {
  const t = useTranslations('Workspace')
  return <LoadingPage label={t('loading')} bar={false}>
    <div className="flex items-center justify-between gap-2 px-4 py-2">
      <div className="flex items-center gap-2"><Skeleton className="size-7 rounded-md" /><Skeleton className="size-4" /><Skeleton className="h-4 w-40" /></div>
      <div className="flex flex-wrap justify-end gap-2"><Skeleton className="h-7 w-20 rounded-md" /><Skeleton className="h-7 w-16 rounded-md" /></div>
    </div>
    <div className="flex items-center justify-between gap-3 px-4 py-3"><Skeleton className="h-8 w-64 rounded-lg" /><Skeleton className="size-7 rounded-md" /></div>
    <div className="flex flex-col gap-4 px-4 py-4"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-32 w-full rounded-xl" /></div>
  </LoadingPage>
}

/**
 * A task's page: the bar that names where it was opened from and then the task, the title with its
 * properties under it, then the description. The column is the task page's own (centred, 680px wide).
 */
export function TaskPageLoading() {
  const t = useTranslations('Workspace')
  return <LoadingPage label={t('loadingEditor')}>
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-6">
      <Skeleton className="h-7 w-2/3" />
      <div className="flex flex-wrap gap-2">{Array.from({ length: 4 }, (_, chip) => <Skeleton key={chip} className="h-6 w-20 rounded-full" />)}</div>
      <Skeleton className="mt-2 h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="mt-2 h-28 w-full rounded-xl" />
    </div>
  </LoadingPage>
}

/** 自动化: its centred column — the title and 新建, the search row, then its list. */
export function AutomationsPageLoading() {
  const t = useTranslations('Workspace')
  return <LoadingPage label={t('loading')} bar={false}>
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="flex items-center justify-between gap-3"><Skeleton className="h-6 w-24" /><Skeleton className="h-7 w-24 rounded-md" /></div>
      <div className="flex flex-wrap items-center gap-2"><Skeleton className="h-7 w-full max-w-64 rounded-md" /><Skeleton className="h-7 w-40 rounded-md" /></div>
      {Array.from({ length: 3 }, (_, row) => <Skeleton key={row} className="h-16 w-full rounded-xl" />)}
    </div>
  </LoadingPage>
}

/** 设置: a section's page — its title, then the card of rows under it. The section list is the frame's, already standing. */
export function SettingsPageLoading() {
  const t = useTranslations('Workspace')
  return <LoadingPage label={t('loading')} bar={false}>
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6">
      <Skeleton className="h-6 w-32" />
      <div className="flex flex-col gap-4 overflow-hidden rounded-xl border bg-card p-5">
        {Array.from({ length: 4 }, (_, row) => <div key={row} className="flex items-center justify-between gap-3"><Skeleton className="h-4 w-40" /><Skeleton className="h-6 w-12" /></div>)}
      </div>
    </div>
  </LoadingPage>
}

/**
 * A conversation: the bubbles at the end of it, and the composer waiting under them. A bot's chat, a
 * group chat and a thread all open the same way, so one placeholder stands for each of them.
 */
export function ConversationPageLoading() {
  const t = useTranslations('Workspace')
  return <LoadingPage label={t('loading')} bar={false}>
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end gap-4 px-5 pb-4">
      <Skeleton className="h-16 w-3/5 rounded-2xl" />
      <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
      <Skeleton className="h-24 w-4/5 rounded-2xl" />
    </div>
    <div className="mx-auto w-full max-w-3xl px-5 pb-5"><Skeleton className="h-24 w-full rounded-2xl" /></div>
  </LoadingPage>
}

/**
 * A page's content while it loads, for the pages with no shape of their own to stand in (UI audit
 * states-04). Everything above replaces this one; it stays for the ones that are only a title and a body.
 */
export function WorkspaceContentLoading() {
  const t = useTranslations('Workspace')
  return <LoadingPage label={t('loading')}>
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-20 w-2/3" />
      <Skeleton className="h-32 w-full" />
    </div>
  </LoadingPage>
}

/** The first paint: the same window frame as the app (window bar, rail, one card) so nothing jumps when it arrives. */
export function WorkspaceLoading() {
  return <div className="flex h-screen flex-col overflow-hidden bg-shell-chrome supports-[height:100dvh]:h-dvh text-foreground in-data-desktop-translucent:bg-transparent">
    {/* bg-muted is the light chrome ground itself: the chrome's placeholders take a step of the text colour instead. */}
    <div aria-hidden="true" className="hidden h-11 shrink-0 grid-cols-[1fr_minmax(0,26rem)_1fr] items-center gap-3 pr-2 pl-3 md:grid"><span /><Skeleton className="h-7 w-full rounded-full bg-foreground/[0.07]" /><span /></div>
    <div className="flex min-h-0 flex-1 md:pr-2 md:pb-2">
      <div aria-hidden="true" className="hidden w-17 shrink-0 flex-col items-center gap-1 pt-1 md:flex">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="size-9 rounded-lg bg-foreground/[0.07]" />)}</div>
      <div className="flex min-w-0 flex-1 overflow-hidden bg-background in-data-desktop-translucent:bg-transparent md:rounded-xl md:shadow-xs md:ring-1 md:ring-border">
        {/* split-pane-exempt: the loading placeholder of the bot list, gone before anyone could drag it */}
        <aside aria-hidden="true" className="hidden w-64 shrink-0 flex-col gap-3 border-r p-3 md:flex">
          <Skeleton className="h-8 w-24" />
          {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-12 w-full rounded-xl" />)}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col bg-background"><WorkspaceContentLoading /></main>
      </div>
    </div>
  </div>
}
