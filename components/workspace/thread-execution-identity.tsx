'use client'

import { useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Cloud, Copy, KeyRound, Laptop, Plug, Server, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { InlineLoadError } from '@/components/load-error'
import { HarnessLabel, ModelLabel, ProviderMark } from '@/components/labels/entity-labels'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { EMPTY_LABELS, rolesByPerson } from '@/lib/execution-identity-label-view'
import { currentThreadExecutionEvidence, readThreadExecutionEvidence, type ThreadExecutionEvidence } from '@/lib/thread-execution-identity-view'
import { DECISION_REASONS, type DecisionReason } from '@/lib/factory/agent-profile-decision'
import { ProfileAgentMark, ProfileMark } from '@/components/labels/profile-mark'
import { DEFAULT_PROFILE_MARK, resolveProfileMark } from '@/lib/factory/agent-profile-mark'

export function ThreadExecutionIdentity({ runId }: { runId: string }) {
  // A different actual run closes the previous dialog and starts with no data.
  return <ExecutionIdentityDialog key={runId} runId={runId} />
}

function ExecutionIdentityDialog({ runId }: { runId: string }) {
  const t = useTranslations('IssueThreads.executionIdentity')
  const common = useTranslations('Common')
  const [open, setOpen] = useState(false)
  const { data, error, mutate } = useSWR(open ? ['thread-execution-evidence', runId] : null,
    () => readThreadExecutionEvidence(runId), { keepPreviousData: false, revalidateOnFocus: false, shouldRetryOnError: false })
  const current = currentThreadExecutionEvidence(data, runId)
  return <Dialog open={open} onOpenChange={setOpen}>
    <Tooltip><TooltipTrigger render={<DialogTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={t('title')} />} />}><ShieldCheck data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('title')}</TooltipContent></Tooltip>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl" closeLabel={common('close')} aria-describedby={undefined}>
      <DialogTitle className="pr-8">{t('title')}</DialogTitle>
      <div className="min-h-0 overflow-y-auto">
        {error ? <InlineLoadError message={t('unavailable')} retryLabel={common('retry')} onRetry={() => { void mutate() }} />
          : current ? <ThreadExecutionIdentityContent key={current.id} evidence={current} />
          : <div role="status" aria-label={t('loading')} className="flex flex-col gap-3 py-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-32 w-full" /></div>}
      </div>
    </DialogContent>
  </Dialog>
}

function ValueRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid min-w-0 gap-1 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
    <dt className="text-muted-foreground">{label}</dt><dd className="flex min-w-0 flex-col gap-1.5 wrap-break-word">{children}</dd>
  </div>
}
function Line({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">{children}</span>
}
function Quiet({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}
function Person({ name, image }: { name: string; image: string | null }) {
  return <Avatar className="size-5"><AvatarImage src={image ?? undefined} alt="" /><AvatarFallback className="text-xs">{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>
}
const KIND_ICON = { cloud: Cloud, laptop: Laptop, server: Server } as const
const API_KEY_PROVIDERS: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', deepseek: 'DeepSeek', kimi: 'Kimi' }

/**
 * Frozen host metadata in words a person reads: people by name, machines and
 * accounts by what they are, the cost as one sentence (Alex, 2026-11-06). Raw
 * references only go into 「复制诊断信息」. No current-setting fallback or credential value.
 */
export function ThreadExecutionIdentityContent({ evidence }: { evidence: ThreadExecutionEvidence }) {
  const t = useTranslations('IssueThreads.executionIdentity')
  const identity = evidence.executionIdentity
  const labels = evidence.labels ?? EMPTY_LABELS
  const profileT = useTranslations('Settings.agentProfiles')
  const profile = evidence.agentProfile
  const routing = evidence.modelRouting
  const personName = (id: string) => labels.people[id]?.you ? t('you') : labels.people[id]?.name || t('unknownPerson')
  // 「你的」/「Bob 的」; English capitalizes it at the start of a phrase only.
  const owner = (id: string, inline = false) => labels.people[id]?.you ? t(inline ? 'yourOwnerInline' : 'yourOwner') : t('personOwner', { name: labels.people[id]?.name || t('unknownPerson') })
  const deviceName = (id: string) => labels.devices[id]?.kind === 'cloud' ? t('cloudComputer') : labels.devices[id]?.name ?? t('unknownDevice')
  const keyProvider = (provider: string, name: string | null) => name || API_KEY_PROVIDERS[provider] || provider
  async function copyDiagnostics() {
    const text = JSON.stringify({ run: evidence.id, harness: evidence.harness, model: evidence.model, credentialType: evidence.credentialType,
      subscriptionRoute: evidence.subscriptionRoute, executionIdentity: evidence.executionIdentity, modelRouting: evidence.modelRouting ?? null,
      skillPrompt: evidence.skillPrompt ?? null,
      agentProfile: profile ? { profileId: profile.profileId, version: profile.version, source: profile.source } : null }, null, 2)
    try { await navigator.clipboard.writeText(text); toast.success(t('diagnosticsCopied')) }
    catch { toast.error(t('diagnosticsCopyFailed')) }
  }
  const device = identity?.resourceBindings.find(item => item.kind === 'device')
  const cloud = identity && (identity.billingAccount.runtime.kind === 'e2b' || identity.resourceBindings.some(item => item.kind === 'e2b'))
  const where = cloud ? { Icon: Cloud, name: t('cloudComputer') } : device ? { Icon: KIND_ICON[labels.devices[device.id]?.kind ?? 'laptop'], name: deviceName(device.id) } : null
  function resource(binding: NonNullable<typeof identity>['resourceBindings'][number]) {
    const shared = binding.access === 'workspace_share' ? <Quiet>· {t('shared')}</Quiet> : null
    if (binding.kind === 'device') {
      const Icon = KIND_ICON[labels.devices[binding.id]?.kind ?? 'laptop']
      return <Line><Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{deviceName(binding.id)}{shared}</Line>
    }
    if (binding.kind === 'subscription') {
      const sub = labels.subscriptions[binding.id]
      return <Line><ProviderMark provider={sub?.provider === 'codex' ? 'openai' : 'claude'} />{t('subscription', { owner: owner(binding.ownerId), provider: sub?.provider === 'codex' ? 'ChatGPT' : 'Claude' })}{sub?.account && <Quiet>· {sub.account}</Quiet>}{shared}</Line>
    }
    if (binding.kind === 'api_key') {
      const key = labels.apiKeys[binding.id]
      return <Line><KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{t('apiKey', { owner: owner(binding.ownerId), provider: key ? keyProvider(key.provider, key.name) : t('unknown') })}{key?.last4 && <Quiet>····{key.last4}</Quiet>}{shared}</Line>
    }
    if (binding.kind === 'e2b') return <Line><Cloud aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{t('e2bKey', { owner: owner(binding.ownerId) })}{labels.e2b && labels.people[binding.ownerId]?.you && <Quiet>····{labels.e2b.last4}</Quiet>}{shared}</Line>
    return <Line><Plug aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{labels.mcp[binding.id]?.name ?? t('unknown')}{shared}</Line>
  }
  function cost() {
    if (!identity) return null
    const { model, runtime } = identity.billingAccount
    const modelPart = model.kind === 'subscription'
      ? t('costModelSubscription', { owner: owner(model.ownerId), provider: labels.subscriptions[model.resourceId]?.provider === 'codex' ? 'ChatGPT' : 'Claude' })
      : model.kind === 'api_key' ? t('costModelApiKey', { owner: owner(model.ownerId), provider: labels.apiKeys[model.resourceId] ? keyProvider(labels.apiKeys[model.resourceId].provider, labels.apiKeys[model.resourceId].name) : t('unknown') })
      : t('costModelLogin')
    const runtimePart = runtime.kind === 'e2b' ? t('costRuntimeE2b', { owner: owner(runtime.ownerId, true) })
      : t('costRuntimeDevice', { owner: owner(runtime.ownerId, true), device: deviceName(runtime.resourceId) })
    const mikka = model.amount === 'metered' || runtime.amount === 'metered' ? t('costMikkaMetered') : t('costMikkaFree')
    return t('costSentence', { model: modelPart, runtime: runtimePart, mikka })
  }
  return <div className="flex flex-col gap-6 text-sm" data-execution-evidence-run={evidence.id}>
    <dl className="flex flex-col gap-3">
      <ValueRow label={t('harness')}>{evidence.harness ? <HarnessLabel harness={evidence.harness} /> : t('unknown')}</ValueRow>
      <ValueRow label={t('model')}>{evidence.model ? <Line><span title={evidence.model}><ModelLabel model={evidence.model} /></span>{routing && <Quiet>· {t(`routingReasons.${routing.reason}`)}</Quiet>}</Line> : t('unknown')}</ValueRow>
      {where && <ValueRow label={t('runsOn')}><Line><where.Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{where.name}</Line></ValueRow>}
      {identity && <ValueRow label={t('workspace')}>{labels.workspace?.name ?? t('notRecorded')}</ValueRow>}
    </dl>
    {routing && <section className="flex flex-col gap-1" data-model-routing={routing.reason}>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground">
        <span>{t('modelRouting')}</span>
        {routing.version === 2 && routing.required !== 'unknown' && <><span>{t(`routingTier.${routing.required}`)}</span><span aria-hidden="true">→</span></>}
        {routing.version === 1 && routing.difficulty !== 'unknown' && <><span>{t(`routingDifficulty.${routing.difficulty}`)}</span><span aria-hidden="true">→</span></>}
        <span className="min-w-0 wrap-break-word text-foreground" title={routing.model}><ModelLabel model={routing.model} /></span>
        {routing.effort && <><span aria-hidden="true">·</span><span>{t(`routingEffort.${routing.effort}`)}</span></>}
      </p>
      {routing.previousModel && <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground">{t('previousModel')}<span className="text-foreground" title={routing.previousModel}><ModelLabel model={routing.previousModel} /></span></p>}
    </section>}
    {profile && <dl className="flex flex-col gap-3"><ValueRow label={profileT('frozenProfile')}><Line>
      {/* Who did the work: the Profile's mark first, the Agent that ran it smaller beside the name. */}
      <ProfileMark {...(profile.profileId === 'default' ? DEFAULT_PROFILE_MARK : resolveProfileMark({ name: profile.name }, profile))} />
      {profile.source === 'default' && profile.profileId === 'default' ? profileT('defaultName') : profile.name}
      {evidence.harness && <ProfileAgentMark harness={evidence.harness} />}
      <Quiet>· {profileT('version', { version: profile.version })} · {profileT(`selectionSources.${profile.source}`)}</Quiet>
      {/* A run frozen before reasons were codes holds an English sentence: the source already says how it was chosen. */}
      {profile.source === 'decision' && (DECISION_REASONS as readonly string[]).includes(profile.reason) && <Quiet>· {profileT(`selectionReasons.${profile.reason as DecisionReason}`)}</Quiet>}
    </Line></ValueRow>
      {/* Configured is not used: only the daemon's own load receipts say loaded. */}
      <ValueRow label={profileT('skills')}>
        {evidence.configuredSkills?.length ? <div className="flex flex-col gap-1">
          {evidence.configuredSkills.map(skill => {
            const loaded = new Set((evidence.loadedSkills ?? []).map(item => item.id)).has((skill.id.includes(':') ? skill.id : `official:${skill.id}`).toLowerCase())
            return <Line key={skill.id}>
              <span className="min-w-0 truncate" title={skill.name}>{skill.name}</span>
              <Quiet>· {profileT(`skillSources.${skill.source}`)}</Quiet>
              <Quiet>· {profileT(loaded ? 'skillLoaded' : 'skillNotLoaded')}</Quiet>
            </Line>
          })}
        </div> : <Quiet>{profileT('skillsNone')}</Quiet>}
      </ValueRow>
    </dl>}
    {!identity ? <p className="text-muted-foreground">{t('snapshotMissing')}</p> : <>
      <dl className="flex flex-col gap-3">
        {rolesByPerson(identity).map(row => <ValueRow key={row.personId} label={row.roles.length === 1 ? t(`roles.${row.roles[0]}`) : t('rolesTogether', { first: t(`roles.${row.roles[0]}`), last: t(`roles.${row.roles.at(-1)!}`) })}>
          <Line><Person name={labels.people[row.personId]?.name || personName(row.personId)} image={labels.people[row.personId]?.image ?? null} />{personName(row.personId)}
            {row.roles.length > 2 && <Quiet>· {row.roles.map(role => t(`roles.${role}`)).join(t('roleSeparator'))}</Quiet>}</Line>
        </ValueRow>)}
      </dl>
        <dl className="flex flex-col gap-3">
        {identity.resourceBindings.length > 0 && <ValueRow label={t('resources')}>{identity.resourceBindings.map((binding, index) => <span key={`${binding.kind}:${binding.id}:${index}`}>{resource(binding)}</span>)}</ValueRow>}
        <ValueRow label={t('billing')}><span>{cost()}</span></ValueRow>
      </dl>
    </>}
    {evidence.skillPrompt && <dl className="flex flex-col gap-3"><ValueRow label={t('skills')}>
      <Line>
        <span>{t('skillsInlined')}</span>
        <Quiet>· {evidence.skillPrompt.inlined.length === 0 ? t('unknown') : evidence.skillPrompt.inlined.join(t('roleSeparator'))}</Quiet>
      </Line>
      {/* A body the prompt could not hold is a real difference in what ran; name every skill it left out. */}
      {evidence.skillPrompt.deferred.length > 0 && <Line>
        <span>{t('skillsDeferred')}</span>
        <Quiet>· {evidence.skillPrompt.deferred.join(t('roleSeparator'))}</Quiet>
      </Line>}
      <Quiet>{t('skillsBudget', { used: evidence.skillPrompt.usedChars, budget: evidence.skillPrompt.budgetChars })}</Quiet>
    </ValueRow></dl>}
    <div><Button variant="ghost" size="sm" onClick={() => { void copyDiagnostics() }}><Copy data-icon="inline-start" />{t('copyDiagnostics')}</Button></div>
  </div>
}
