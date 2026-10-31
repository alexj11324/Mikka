# UI consistency audit (2026-10-31)

Hand-built controls where a shadcn (`components/ui/`), beUI
(`components/motion/`, `components/agents/`) or ReUI (`components/reui/`)
primitive exists, and the same control styled differently in different places.
Rules cited: R-30 (neutral greys), R-31 (secondary controls are `--control`
grey, no stroke), R-33 (radii: 6 tag, 8 button/input, 12 card, 14 list card,
16 dialog, 999 pill).

Reference sizes in this repo: Button `xs` h-6, `sm` h-7, `default` h-8,
`lg` h-9; Toggle `sm` h-7. `--radius` is 10px, so `rounded-md` = 8px,
`rounded-lg` = 10px, `rounded-sm` = 6px.

Out of scope here (owned by other branches): the settings members table
(`fix/members-table-gutter`), the kanban card (`fix/board-card-columns`),
scrollbars (`fix/coordinator-openui-scrollbar`), OpenUI charts
(`feat/openui-charts`).

## 看板 toolbar (`components/workspace/board-page.tsx`)

All three pieces Alex flagged are shadcn primitives, but each call site
overrides size and colour, so no two share a height, radius or grey:

| Piece | Primitive | Height | Radius | Grey |
| --- | --- | --- | --- | --- |
| 全部 / 工作区 / 个人 | shadcn `ToggleGroup`, wrapper overridden to `rounded-lg bg-muted p-0.5`, items `h-7 rounded-md` | 32px (28 + 2×2 padding) | 10px outside, 8px inside | `--muted` track, white pressed item |
| 筛选 | shadcn `Button variant="outline" size="sm"` | 28px | 8px | `--control` |
| 「负责人 \| 我 \| ×」 | shadcn `ButtonGroup` + two `ButtonGroupText` overridden to `h-6` + `Button size="icon-xs"` | 24px | 10px / 8px | `--control` ×3 with the 2px ButtonGroup gap, so it reads as three blocks |
| Board / list view switch | shadcn `ToggleGroup` default variant | 28px | 8px | transparent, `--muted` when pressed |

Fix (this PR): a `segment` variant on the shadcn `ToggleGroup` (track
`--control`, pressed item raised), used by both segmented controls; 筛选
stays `Button outline sm`; the filter chip is one `--control` container
holding the field, the value and a remove button. Every control on the bar is
28px high with an 8px outer radius on the `--control` grey.

## Counts

Business code is 219 `.tsx` files under `components/` and `app/`, not
counting `ui/`, `reui/`, `motion/`, `agents/` and `blocks/`.

- Raw `<button>`: 0 in production code (4 in one test file). Nearly every
  control is a library primitive.
- Library primitives restyled per call site are the problem. For example,
  `Button` used as a row, chip or toggle with its height and radius rewritten
  in `className`.
- Segmented controls: 5 looks. outline `ToggleGroup` (7 settings sites, board
  view switch); default `Tabs` (`bg-muted` h-8 track); `line` Tabs (plugins);
  the board scope switch (custom `bg-muted p-0.5` track); context-panel pill
  tabs (`rounded-full`, `bg-muted` active). Plus about 4 selectors built from
  `Button`s whose variant flips.
- Selected/active fill on controls: 4 different backgrounds (`bg-background` +
  shadow, `bg-muted`, `bg-sidebar-primary/10` or `-soft`, `secondary`
  Button).
- Secondary buttons: two greys. Settings section actions use opaque
  `bg-secondary` through `settingsSectionAction`
  (`components/settings/primitives.tsx:101`); everywhere else `outline` uses
  `--control` (R-31). 41 `variant="secondary"` call sites in settings and
  plugins.
- Chips: at least 5 looks (artifact, quote, note, PR output, suggestion
  verb), with 4 fills and 3 ways of setting the height.
- Status tags: 3 systems (shadcn `Badge tone`, ReUI `BadgeButton` +
  `statusTones`, ReUI `Badge` `*-light`); R-34 allows only the StatusBadge set.
- Error text: about 50 hand-written `<p role="alert">` with mixed size and
  padding.
- Tables: 1 hand-built grid (`artifact-library.tsx`); the rest use
  `components/ui/table.tsx`.
- Grey list surfaces: six alphas of `--muted` (/15 to /60) for the same
  surface; radii `rounded-lg`/`xl`/`2xl` = 10/14/18px, which miss R-33's 8/12/16.

## Findings

Most severe first. "Hand-written" means no primitive; otherwise the primitive
named is used but restyled at the call site.

| Where (file:line) | What it is | Hand-written or which library | What it should use | Severity |
|---|---|---|---|---|
| `components/workspace/board-page.tsx:186-197` | 看板 toolbar: scope switch, 筛选, filter chip | shadcn `ToggleGroup`, `Button`, `ButtonGroup`, each resized: 32 / 28 / 24px, two greys | `ToggleGroup variant="segment"`, `Button outline sm`, one-container chip (this PR) | high |
| `components/settings/primitives.tsx:101` (+ `workspace-settings:122,143`, `security-settings:96,108`, `secrets-settings:77,135`, `saved-logins:56`, `access-tokens:63`, `subscription-settings:137,167`, `connected-apps:268,269,276,346`) | Secondary buttons in settings | shadcn `Button variant="secondary"` (opaque `bg-secondary`), next to `outline` Cancel/retry in the same rows (`linear-settings:142` vs `:150`) | `variant="outline"` (`--control`, R-31); change `settingsSectionAction` | high |
| `components/workspace/issue-pull-request-link.tsx:56`, `issue-property-menu.tsx:48`, `project-property-controls.tsx:37`, `components/nav/global-search.tsx:157`, `issue-threads.tsx:28-30` | Status/tone badge | 3 systems: shadcn `Badge tone` resized to h-6; ReUI `BadgeButton size="xl"`; ReUI `Badge *-light` | One StatusBadge: `Badge tone`, one height, 6px (R-33, R-34) | high |
| `components/plugins/connected-apps.tsx:259,261,339-341`; `settings/linear-settings.tsx:142,150`; `security-settings.tsx:107`; `secrets-settings.tsx:133`; `audit-log-settings.tsx:81` | Status and kind tags | shadcn `Badge secondary` (pill) beside `Badge tone` (6px); `Badge outline` adds a stroke | `Badge tone=…` everywhere (as `billing/balance-section.tsx:95`) | high |
| `components/nav/context-panel.tsx:114-134`, `workspace/project-detail.tsx:59`, `workspace/issue-workspace.tsx:402`, `workspace/issue-editor.tsx:194-196` | Segmented control / view switch | shadcn `Tabs` restyled to `rounded-full` pills; default `TabsList`; outline `ToggleGroup`; three `Button`s flipping `secondary`/`ghost` | One segment look: `ToggleGroup variant="segment"` for filters/views, `Tabs` for page sections | high |
| `components/workspace/issue-metadata-controls.tsx:112-121`, `project-property-controls.tsx:37,57` | Property / label chips | outline `Button xs` + `rounded-full` (24px) vs outline `Button sm` + `h-7 rounded-full` (28px) | One chip size; tags at 6px (R-33) | high |
| `components/nav/thread-list.tsx:56-59`, `nav/context-panel.tsx:65` | Two-line thread / PR rows | ghost `Button` rewritten to `h-auto flex-col rounded-lg px-2 py-1.5`, class string copied in both files | shadcn `Item size="sm"` + `ItemContent`/`ItemTitle`/`ItemDescription` | high |
| `components/coordinator/new-task-dialog.tsx:127,133,136` | Device picker and context pills | `SelectTrigger` re-sized; hand-written `<span rounded-full border>` at h-7 and h-6 | `SelectTrigger size="sm"` as is; `Badge` at one height, no stroke (R-31) | high |
| `components/artifacts/artifact-viewer.tsx:132` | 回到最新 button on grey banner | `Button secondary` forced to `bg-background` | `variant="outline"` (R-31 forbids white secondary buttons) | high |
| `components/settings/activity-settings.tsx:79` | Each activity event as its own card | Hand-written `rounded-xl border bg-card` div | `SettingsSection` rows with `divide-y` (as `audit-log-settings.tsx:76`) | high |
| `components/artifacts/artifact-card.tsx:41-47`, `artifact-quote.tsx:17`, `browser/browser-notes.tsx:65`, `coordinator/thread-card.tsx:15,42-46`, `suggestions/mobile-card.tsx:31` | Chip family (artifact, quote, note, PR output, verb) | `Button secondary` h-7; div h-7 `bg-muted`; div with no fill; `Badge` with almost every class overridden; hand-written span | One chip: `Badge` (tone/size) with one height and the `--control` grey | med |
| `components/browser/browser-toggle.tsx:14`, `browser/browser-pane.tsx:27,255`, `artifacts/artifact-viewer.tsx:117,120` | Pressed icon buttons | ghost `Button` + `aria-pressed` with three looks: `bg-muted`, `bg-sidebar-primary-soft`, none | shadcn `Toggle`, one pressed colour | med |
| `components/workspace/board-page.tsx:230,234` | Card properties / hidden columns chips in 显示 | outline `Toggle` resized, pressed `bg-sidebar-primary/10` | `Toggle variant="outline" size="sm"` as is | med |
| `components/workspace/agent-decision.tsx:154`, `issue-description-history.tsx:89`, `components/teams/project-team-control.tsx:24` | Option pickers | `Button`s whose variant flips `default`/`secondary`/`ghost` with `aria-pressed` | `ToggleGroup` (single) | med |
| `components/workspace/issue-threads.tsx:43,60-61` | Thread list in a grey card | `ul bg-muted/50 p-1 rounded-xl`, ghost `Button` rows `px-3 py-2.5` with `bg-background shadow-xs` selected | `Item` with a selected state; same padding as thread-list rows | med |
| `components/nav/context-panel.tsx:43`, `issue-threads.tsx:43`, `issue-relations.tsx:73`, `issue-editor.tsx:188,204`, `issue-search.tsx:41`, `issue-list.tsx:37` | Grey grouped-list surfaces | Hand-written `bg-muted/60…/15`, `rounded-2xl`/`xl`/`lg` | One token and one radius (14 for list cards) | med |
| `components/workspace/issue-activity.tsx:37`, `issue-editor.tsx:166,206,207`, `project-milestones.tsx:19`, `project-issue-picker.tsx:38`, `issue-description-history.tsx:74` | Bordered cards | Hand-written `rounded-xl border`, `rounded-lg border p-4`, `rounded-md border p-3` | shadcn `Card` / ReUI `Frame`, radius 12 | med |
| `components/settings/primitives.tsx:11,60`, `usage-settings.tsx:85,94` | Settings card surface | Hand-written `rounded-2xl border bg-card` (18px) | `Card`, 12px (R-33) | med |
| `components/coordinator/thread-card.tsx:55`, `pending-actions.tsx:66`, `approved-write-actions.tsx:41`, `artifacts/artifact-card.tsx:31` | In-chat cards | Hand-written; `rounded-xl` vs `rounded-[14px]`, `bg-muted` vs `bg-muted/60` | One card class (`Item variant="muted"`) | med |
| `components/coordinator/new-task-dialog.tsx:151,152` vs `chat-composer.tsx:92-100`, `browser/browser-pane.tsx:285` | Attach and send buttons in two composers | attach: `outline` vs `secondary`; send: `bg-sidebar-primary` override vs `default` | One attach variant; a Button variant for the blue send | med |
| `components/coordinator/coordinator-chat.tsx:209`, `suggestions/mobile-card.tsx:50`, `workspace/issue-thread-panel.tsx:29,126-138` | Person's message bubble | `Bubble` with the colour overridden twice; thread panel hand-writes its own `BUBBLE` const | A `Bubble` variant (e.g. `brand`) used by all three | med |
| `components/plugins/connected-apps.tsx:253-254,334`; `plugins/plugins-skills-view.tsx:102,138-186` | App and skill lists on one page | Hand-written rows + stripped ghost `Button`; skills use ReUI `Frame`, plugins use `SettingsSection` | One list primitive (`Item` or `SettingRow`) for both tabs | med |
| `components/artifacts/artifact-library.tsx:26,61,68` | Artifact list | Hand-built grid table, ghost `Button` rows `h-13 rounded-none` | shadcn `Table` or `ItemGroup` | med |
| `components/workspace/issue-list.tsx:37,44` vs `project-workspace.tsx:47-50` | Issue list vs project list | Hand-written header + `Button` rows vs `Table` | One row primitive for both lists | med |
| Retry buttons: `settings/primitives.tsx:21`, `subscription-settings.tsx:177`, `suggestions/suggestion-feed.tsx:82`, `artifacts/artifact-library.tsx:57`, `plugins/plugins-skills-view.tsx:131`, `artifacts/artifact-viewer.tsx:135` | Retry after a load error | `Button` in 4 variants × 3 sizes | `Alert` + `AlertAction`, outline sm | med |
| ~50 sites, e.g. `settings/access-tokens-settings.tsx:60,66`, `account-settings.tsx:100`, `coordinator/coordinator-chat.tsx:231-235`, `plugins/connected-apps.tsx:222,405` | Inline error text | Hand-written `<p role="alert">`, `text-xs`/`text-sm`, mixed padding | `FieldError` in forms, `Alert variant="destructive"` elsewhere | med |
| `components/nav/context-panel.tsx:123-125` vs `app-shell.tsx:56-57`; `workspace/issue-detail-header.tsx:35` vs `:62-65` | Header-bar icon buttons | `icon-xs` (24px) and `icon-sm` (28px) in same-height bars | `icon-sm` everywhere in header bars | med |
| `components/workspace/task-detail.tsx:241`, `project-text-editor.tsx:111`, `project-form.tsx:70` | Large title editor | `Textarea`, hand-written `contentEditable` span, `Input` — each restyled | One title field | med |
| `components/workspace/issue-workspace.tsx:402`, `settings/settings-sidebar.tsx:62` | Search fields | Hand-placed icon beside `Input`/`SidebarInput` | `InputGroup` + `InputGroupAddon` (as `plugins-skills-view.tsx:108`) | low |
| `components/coordinator/chat-composer.tsx:89` | Composer shell | `InputGroup` at `rounded-3xl`, switching to `rounded-2xl` when quoting | One radius | low |
| Settings rows: `usage-settings.tsx:68` (sm) vs `activity-settings:59`, `audit-log-settings:64`, `locale-setting:15`, `notifications-settings:53`, `settings-view:115`, `computer-policy-settings:45` (default) | Row controls | shadcn `ToggleGroup`/`Button`, h-7 and h-8 mixed | One size (sm) in the settings control column | low |
| `components/nav/conversation-pill.tsx:7` | Floating chat title pill | Hand-written `<p>` h-9 `rounded-full ring-1` | Shared pill surface; h-9 matches no other pill | low |
| `components/nav/global-search.tsx:143,152,164` | Result icon tile | Hand-written `size-7 rounded-full bg-muted` | ReUI `IconTile` | low |
| `components/workspace/issue-property-menu.tsx:55`, `nav/bot-list.tsx:92,98` | Status dot | Inline `<span>`, size-2 and size-2.5 | `components/nav/status-dot.tsx` | low |
| `components/app-shell.tsx:74` | Sign-out spinner | Hand-written border spinner | shadcn `Spinner` | low |
| `components/nav/new-bot-dialog.tsx:51,76`, `workspace/project-form.tsx:65-77` | Dialog / input / CTA overrides | `DialogContent rounded-2xl`, `Input h-11 rounded-xl`, `Button rounded-full bg-project-action`, `Badge outline` breadcrumb | Library defaults; dialog radius 16 set once in `dialog.tsx` | low |
| `components/nav/icon-rail.tsx:51-52` | Rail item | ghost `Button` overridden + inner span `rounded-sm` (6px) | Rail radius 9 (R-33) | low |

Overlap with other branches, not fixed here: `issue-pull-request-link.tsx:55`
(`BoardBadge`) renders inside the kanban card; `billing/balance-section.tsx`
and `usage-settings.tsx:97-108` share the members table's `pl-5/pr-5` gutters.
