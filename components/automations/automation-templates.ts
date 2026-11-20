import type { AutomationDraft } from './automation-draft'

/**
 * 从模板开始 (decision 2026-11-15-2100): a few common automations the editor opens filled in. The person still picks the
 * repository, team or channel and saves; nothing runs until then. Titles and requests are the person's language.
 */
export const AUTOMATION_TEMPLATES = ['standup', 'prReview', 'ciFix', 'linearTriage', 'slackQuestion', 'weeklyDeps'] as const
export type AutomationTemplate = typeof AUTOMATION_TEMPLATES[number]
export const isAutomationTemplate = (value: string): value is AutomationTemplate => (AUTOMATION_TEMPLATES as readonly string[]).includes(value)

/** The integration a template listens to, as its card's tag (Capy's [Slack] [Linear] [Sentry]). */
export type TemplateIntegration = 'schedule' | 'github' | 'linear' | 'slack' | 'sentry'

/**
 * Cards Capy has and this build cannot create yet: the contract has no Sentry trigger, so a card for it is drawn and
 * marked 即将推出 instead of being hidden (2026-11-19, no-backend-no-skip).
 */
export const COMING_SOON_TEMPLATES = ['sentryInvestigation'] as const
export type ComingSoonTemplate = typeof COMING_SOON_TEMPLATES[number]

export type AutomationTemplateCard = {
  /** A template the editor opens, or one of COMING_SOON_TEMPLATES. */
  key: AutomationTemplate | ComingSoonTemplate
  integration: TemplateIntegration
}

/**
 * 模板: the cards the list draws, in the order they read. Every template the editor opens is here, beside the cards
 * whose integration is still missing, so the grid shows what the product does today and what it is about to do.
 */
export const AUTOMATION_TEMPLATE_CARDS: readonly AutomationTemplateCard[] = [
  { key: 'standup', integration: 'schedule' },
  { key: 'prReview', integration: 'github' },
  { key: 'ciFix', integration: 'github' },
  { key: 'linearTriage', integration: 'linear' },
  { key: 'slackQuestion', integration: 'slack' },
  { key: 'sentryInvestigation', integration: 'sentry' },
  { key: 'weeklyDeps', integration: 'schedule' },
]

export function templateDraft(template: AutomationTemplate, base: AutomationDraft, text: { title: string; prompt: string }): AutomationDraft {
  const draft = { ...base, title: text.title, prompt: text.prompt }
  const trigger = { scheduleOn: false as const }
  switch (template) {
    case 'standup': return { ...draft, scheduleOn: true, scheduleKind: 'cron', cron: '0 9 * * 1-5' }
    case 'weeklyDeps': return { ...draft, scheduleOn: true, scheduleKind: 'cron', cron: '0 10 * * 1' }
    case 'prReview': return { ...draft, ...trigger, github: [{ event: 'pull_request_opened', repositories: [], branches: '', labels: '', runWhen: '' }] }
    case 'ciFix': return { ...draft, ...trigger, github: [{ event: 'checks_failed', repositories: [], branches: '', labels: '', runWhen: '' }] }
    case 'linearTriage': return { ...draft, ...trigger, linear: [{ event: 'issue_created', teams: [], labels: '', runWhen: '' }] }
    case 'slackQuestion': return { ...draft, ...trigger, slack: [{ event: 'mention', channels: [], authors: '', reactions: '', runWhen: '' }] }
  }
}
