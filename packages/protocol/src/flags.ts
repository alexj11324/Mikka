// Feature flags (ADR 0033, docs/analytics.md). A flag hides UI that is not
// finished or not yet for everyone. Without a PostHog key every flag is off,
// except the ones a build forces on (`MIKKA_FLAGS`), so local development can
// still see the screens.

/**
 * Every flag the apps may ask for. The name is the PostHog flag key:
 * `ui-<area>` for screens and sections, `feat-<name>` for behavior. Add a flag
 * here, create the same key in PostHog, then gate the code with it.
 */
export const FEATURE_FLAGS = [
  // Desktop system notifications and the Dock badge (ADR 0056). The same key
  // is created in PostHog (ADR 0033).
  "feat-system-notifications",
  // The read-only check before In Review (ADR 0046). The server reads it from
  // its own MIKKA_FLAGS; the key is here so the same one can be created in
  // PostHog (ADR 0033).
  "feat-readonly-check",
  // Hides the acceptance criteria editor until it has shipped to everyone
  // (ADR 0042, ADR 0044). The key is here so the same one can be created in
  // PostHog before the editor lands.
  "ui-acceptance",
  // Select several issues and change them at once (ORV-61). Off until the bar
  // has shipped to everyone.
  "ui-bulk-actions",
  // The command palette's Views entry (ORV-162). Saved views have no table
  // yet, so the palette keeps the command in the tree and hides it here.
  "ui-command-views",
  "ui-cycles",
  // General documents: the team and project Documents tabs and the settings
  // page (ORV-165, ADR ORV-18). Hidden until it has shipped to everyone.
  "ui-documents",
  // Hides the issue share menu until external sharing has shipped to everyone
  // (ADR ORV-70). The share route itself is not behind a flag: a link that has
  // already been handed out has to keep working.
  "ui-issue-share",
  // Every way into the planner (ADR ORV-205): asking an issue's agent for a
  // spec (`ask-for-spec.tsx`), and the approve buttons on the spec and split
  // cards (`run-chat.tsx` builds those callbacks, and passes none while this
  // is off). The cards themselves still render, so a spec written while the
  // flag was on stays readable.
  "feat-planner",
  "ui-mobile-chat",
  "ui-presence",
  "ui-project-extras",
  // The push approval on a device's repositories (ORV-51, ADR 0048).
  "ui-repo-push",
  "ui-review",
  "ui-schedule",
  // Hides a person's own agent preferences until they have shipped to
  // everyone (ADR 0060).
  "ui-settings-agent-personalization",
  // API keys and webhooks (ADR 0050). Hidden until it has shipped to everyone;
  // the page itself is kept, only its entry is gated.
  "ui-settings-api",
  // Settings › Code & reviews (ORV-172, ADR ORV-172). Behind a flag while the
  // page moves off Circle's sample rows onto the workspace's review rules.
  "ui-settings-code-and-reviews",
  // Settings › Connected accounts (ORV-26). Behind a flag while the page
  // moves off Circle's sample rows onto the server's account list.
  "ui-settings-connected-accounts",
  // The settings page that exports the workspace's data (ORV-181).
  "ui-settings-import-export",
  // Settings › Integrations (ORV-30, ADR ORV-30). Hidden until the GitHub App
  // install flow has shipped to everyone; the page itself is kept.
  "ui-settings-integrations",
  // Settings › Initiatives (ORV-19). The page reads and writes the workspace's
  // initiatives; hidden until the tables have shipped to everyone.
  "ui-settings-initiatives",
  "ui-settings-issue-labels",
  // Settings › Issue templates (ORV-175, ADR 0062). Behind a flag until the
  // page replaces Circle's sample rows with the workspace's templates.
  "ui-settings-issue-templates",
  // The team's own workflow statuses (ADR ORV-10), until it ships to everyone.
  "ui-settings-workflow",
  // Hides the members and invitations page until it has shipped to everyone
  // (ORV-12). The key is here so the same one can be created in PostHog.
  "ui-settings-members",
  // Per-kind inbox preferences (ADR 0021). Hidden until it has shipped to
  // everyone; the page itself is kept, only its entry is gated.
  "ui-settings-notifications",
  "ui-settings-teams",
  "ui-skills",
  "ui-team-projects",
  "ui-usage",
  // Unfinished Circle controls (ADR ORV-264). Off until the feature exists.
  // A control whose area already has a flag reuses that one instead.
  "ui-agent-assistant",
  "ui-asks",
  "ui-attachments",
  "ui-coding-tools",
  "ui-customer-requests",
  "ui-default-view",
  "ui-favorites",
  "ui-initiatives",
  "ui-project-subscribe",
  "ui-reactions",
  "ui-releases",
  "ui-saved-views",
  "ui-settings-email",
  "ui-settings-emojis",
  "ui-settings-leave",
  "ui-settings-passkeys",
  "ui-settings-personal-api-keys",
  "ui-settings-project-labels",
  "ui-settings-project-statuses",
  "ui-settings-project-templates",
  "ui-settings-sessions",
  "ui-settings-signing-keys",
  "ui-settings-slas",
  "ui-shared-display",
  "ui-slack-channels",
  "ui-triage",
] as const
export type FeatureFlag = (typeof FEATURE_FLAGS)[number]

export function isFeatureFlag(name: unknown): name is FeatureFlag {
  return (FEATURE_FLAGS as readonly unknown[]).includes(name)
}

/**
 * Parses the build-time `MIKKA_FLAGS` list (comma separated flag names, or
 * `all`) into the flags forced on. Unknown names are ignored.
 */
export function parseForcedFlags(value: string | undefined): FeatureFlag[] {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.includes("all")) return [...FEATURE_FLAGS]
  return names.filter(isFeatureFlag)
}
