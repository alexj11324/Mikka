// Fixed e7 source contracts. Bodies, IDs and cursors are validated in RAM;
// receipts contain only closed labels, booleans and bounded numeric counts.
export class ProfileFailure extends Error {
  constructor(code) { super(code); this.name = 'ProfileFailure'; this.code = code }
}
export const check = (condition, code) => { if (!condition) throw new ProfileFailure(code) }
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
export const version = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const list = (value, max = 400) => Array.isArray(value) && value.length <= max

// desktop.bootstrap is the tenth shared operation and runs before these reads.
export const COMMON_RPC_READS = Object.freeze([
  ['bots', 'bots.pollBots'], ['summaries', 'coordinator.pollBotChatSummaries'],
  ['chat_first', 'coordinator.syncCoordinatorChat'], ['chat_cursor', 'coordinator.syncCoordinatorChat'],
  ['issues_first', 'issues.syncIssueList'], ['issues_cursor', 'issues.syncIssueList'],
  ['projects', 'projects.listProjects'],
  ['thread_first', 'task-runs.syncThreadList'], ['thread_cursor', 'task-runs.syncThreadList'],
  ['teams', 'teams.listTeams'], ['project_teams', 'team-relations.listProjectTeams'],
  ['model_menu', 'execution-settings.getBotModelMenu'],
].map(row => Object.freeze(row)))
export const GET_READS = Object.freeze([
  'switcher', 'agent_sessions', 'computer_first', 'computer_cursor', 'preferences',
  'enrollment', 'conversations', 'pending_actions', 'live_ticket',
])
export const REQUEST_PLAN = Object.freeze([
  'web_sign_in', 'web_get_session', 'web_bootstrap', 'web_session', 'web_workspace',
  ...COMMON_RPC_READS.map(([id]) => `web_${id}`), ...GET_READS.map(id => `web_${id}`),
  'native_sign_in', 'native_get_session', 'pkce_begin', 'system_browser_config', 'system_browser_session',
  'pkce_return', 'pkce_exchange', 'native_bootstrap', 'native_session', 'native_workspace',
  ...COMMON_RPC_READS.map(([id]) => `native_${id}`), ...GET_READS.map(id => `native_${id}`),
  'native_task_runs_first', 'native_task_runs_second', 'native_read_batch',
])

const GET_ROUTES = Object.freeze({
  workspace: '/mikka/api/workspace', switcher: '/mikka/api/workspace/switcher',
  agent_sessions: '/mikka/api/agent/sessions', computer_first: '/mikka/api/computer/events',
  computer_cursor: '/mikka/api/computer/events', preferences: '/mikka/api/settings/preferences',
  enrollment: '/mikka/api/devices/enrollment', conversations: '/mikka/api/conversations',
  pending_actions: '/mikka/api/pending-actions', live_ticket: '/mikka/api/live/ticket',
})
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
  && BigInt(value) <= 9223372036854775807n

export function getRequest(name, fixture, homeWorkspaceId, computerCursor) {
  const route = GET_ROUTES[name]
  check(route, 'REST_READ_UNKNOWN')
  let parameters = ''
  if (name === 'computer_first' || name === 'computer_cursor') {
    const after = name === 'computer_first' ? '0' : computerCursor
    check(uuid(fixture.workspace) && decimal(after), 'COMPUTER_CURSOR_UNAVAILABLE')
    parameters = new URLSearchParams({ workspace: fixture.workspace, after }).toString()
  } else if (name === 'conversations') {
    check(uuid(fixture.workspace), 'REST_SCOPE_UNAVAILABLE')
    parameters = new URLSearchParams({ workspaceId: fixture.workspace }).toString()
  } else if (name === 'live_ticket') {
    check(uuid(homeWorkspaceId), 'REST_SCOPE_UNAVAILABLE')
    parameters = new URLSearchParams({ workspace: homeWorkspaceId }).toString()
  }
  return { route, path: route + (parameters ? `?${parameters}` : '') }
}

// No caller can change an enrollment read into a write, choose a different
// workspace/cursor, or add an arbitrary route. PKCE and RPC are separately fixed.
export function assertNativeTarget(path, method, fixture, homeWorkspaceId, computerCursor) {
  const url = new URL(path, 'http://localhost:3000')
  check(url.origin === 'http://localhost:3000' && !url.username && !url.password && !url.hash, 'NATIVE_HTTP_TARGET_INVALID')
  const ownPath = url.pathname + url.search
  if (method === 'POST') {
    check(!url.search && ['/mikka/api/desktop/begin', '/mikka/api/desktop/exchange', '/mikka/api/desktop/rpc'].includes(url.pathname), 'NATIVE_HTTP_TARGET_INVALID')
  } else {
    check(method === 'GET', 'NATIVE_HTTP_TARGET_INVALID')
    const possible = Object.keys(GET_ROUTES).filter(name => name !== 'computer_cursor' || decimal(computerCursor))
      .filter(name => name !== 'live_ticket' || uuid(homeWorkspaceId))
    check(possible.some(name => getRequest(name, fixture, homeWorkspaceId, computerCursor).path === ownPath), 'NATIVE_HTTP_TARGET_INVALID')
  }
  return url
}

export function businessRead(result, action, held, fixture, ownerId, homeWorkspaceId) {
  check(object(result) && !result.error, 'BUSINESS_READ_REJECTED')
  const value = ['task-runs.syncThreadList', 'issues.syncIssueList'].includes(action) ? result.snapshot
    : action === 'coordinator.syncCoordinatorChat' ? result.chat : result
  check(uuid(homeWorkspaceId) && value?.live?.ownerId === ownerId && value.live.workspaceId === homeWorkspaceId, 'READ_SCOPE_MISMATCH')
  if (action === 'task-runs.pollTaskRuns') {
    check(list(value.items) && value.items.some(item => item.runId === fixture.run && item.issueId === fixture.issue), 'FIXTURE_TASK_NOT_RETURNED')
    return { receipt: { fixtureTaskFound: true, itemCount: value.items.length, sameLeasedOwner: true, samePersonalHome: true } }
  }
  check(version(value.version), 'READ_VERSION_INVALID')
  if (action === 'issues.syncIssueList') check(value.live.selectedWorkspaceId === fixture.workspace, 'ISSUE_SELECTED_SCOPE_MISMATCH')
  if (held) {
    check(value.unchanged === true && value.version === held.version, 'READ_CURSOR_NOT_UNCHANGED')
    if (action === 'coordinator.syncCoordinatorChat') check(value.botId === fixture.coordinator && value.cursor === held.cursor, 'CHAT_CURSOR_MISMATCH')
    return { held, receipt: { unchanged: true, originalReturnedCursorUsed: true, sameLeasedOwner: true, samePersonalHome: true } }
  }
  check(list(value.items), 'READ_ITEMS_INVALID')
  if (action === 'task-runs.syncThreadList' || action === 'issues.syncIssueList') {
    const issues = action === 'issues.syncIssueList'
    check(list(value.positions, issues ? 100 : 200)
      && value.positions.every(row => uuid(row.id) && version(row.version))
      && new Set(value.positions.map(row => row.id)).size === value.positions.length, 'LIST_POSITIONS_INVALID')
    check(value.items.some(item => item.id === (issues ? fixture.issue : fixture.run)), 'FIXTURE_LIST_ITEM_NOT_RETURNED')
    return { held: { version: value.version, args: [value.version, value.positions] },
      receipt: { fixtureListItemFound: true, itemCount: value.items.length, positionCount: value.positions.length,
        sameLeasedOwner: true, samePersonalHome: true, ...(issues ? { sameSelectedWorkspace: true } : {}) } }
  }
  check(action === 'coordinator.syncCoordinatorChat' && value.botId === fixture.coordinator
    && Number.isSafeInteger(value.cursor) && value.cursor >= 0 && value.working === false && value.error === null, 'CHAT_STATE_INVALID')
  const continuation = value.continuation
  check(continuation && Number.isSafeInteger(continuation.after) && continuation.after >= 0
    && continuation.cursor === value.cursor && continuation.after <= value.cursor && version(continuation.prefix), 'CHAT_CONTINUATION_MISSING')
  check(value.items.length >= 2, 'FIXTURE_CHAT_NOT_RETURNED')
  const sourceIds = Object.keys(value.sources ?? {}), artifactIds = Object.keys(value.artifacts ?? {})
  check(sourceIds.length <= 400 && artifactIds.length <= 400 && [...sourceIds, ...artifactIds].every(uuid), 'CHAT_METADATA_KEYS_INVALID')
  return { held: { version: value.version, cursor: value.cursor,
    args: [null, value.version, { after: continuation.after, cursor: continuation.cursor, prefix: continuation.prefix, sourceIds, artifactIds }] },
    receipt: { fixtureChatFound: true, itemCount: value.items.length, continuationPresent: true,
      defaultWorkspaceCoordinator: true, sameLeasedOwner: true, samePersonalHome: true } }
}

export function commonRead(value, action, fixture, ownerId, homeWorkspaceId) {
  check(value && !value.error, 'COMMON_READ_REJECTED')
  if (action === 'bots.pollBots') {
    check(value.live?.ownerId === ownerId && value.live.workspaceId === fixture.workspace
      && list(value.items) && [fixture.coordinator, fixture.bot].every(id => value.items.some(item => item.id === id)), 'BOT_LIST_SCOPE_MISMATCH')
    return { sameLeasedOwner: true, sameSelectedWorkspace: true, fixtureBotsFound: true, itemCount: value.items.length }
  }
  if (action === 'coordinator.pollBotChatSummaries') {
    check(value.live?.ownerId === ownerId && value.live.workspaceId === homeWorkspaceId && object(value.items)
      && Object.keys(value.items).length <= 400 && Object.keys(value.items).every(uuid), 'SUMMARY_SCOPE_MISMATCH')
    check(Object.hasOwn(value.items, fixture.coordinator), 'FIXTURE_SUMMARY_NOT_RETURNED')
    return { sameLeasedOwner: true, samePersonalHome: true, fixtureSummaryFound: true, itemCount: Object.keys(value.items).length }
  }
  if (['projects.listProjects', 'teams.listTeams', 'team-relations.listProjectTeams'].includes(action)) {
    check(list(value), 'COMMON_LIST_INVALID')
    if (action === 'teams.listTeams') check(value.some(item => item.id === fixture.team), 'FIXTURE_TEAM_NOT_RETURNED')
    if (action === 'projects.listProjects') check(value.every(item => uuid(item.id)), 'PROJECT_LIST_INVALID')
    if (action === 'team-relations.listProjectTeams') check(value.every(item => uuid(item.projectId) && uuid(item.teamId)), 'PROJECT_TEAMS_INVALID')
    return { shapeValidated: true, itemCount: value.length, ...(action === 'teams.listTeams' ? { fixtureTeamFound: true } : {}) }
  }
  check(action === 'execution-settings.getBotModelMenu' && list(value.groups, 100)
    && value.groups.every(group => group.kind === 'hosted' && list(group.options, 100))
    && value.current?.kind === 'hosted' && typeof value.current.available === 'boolean', 'MODEL_MENU_ISOLATION_MISMATCH')
  return { shapeValidated: true, onlyHostedOptions: true, modelRequestMade: false, groupCount: value.groups.length,
    optionCount: value.groups.reduce((sum, group) => sum + group.options.length, 0) }
}

export function restReceipt(value, name, fixture, ownerId, homeWorkspaceId, headers, after) {
  check(value !== null && typeof value === 'object' && !value.error, 'REST_READ_REJECTED')
  if (name === 'workspace') {
    check(value.workspace?.id === fixture.workspace && value.currentUserId === ownerId
      && list(value.members) && list(value.invitations), 'REST_WORKSPACE_MISMATCH')
    check(value.live?.ownerId === ownerId && value.live.workspaceId === fixture.workspace
      && uuid(value.live.homeWorkspaceId) && (!homeWorkspaceId || value.live.homeWorkspaceId === homeWorkspaceId), 'REST_HOME_SCOPE_MISMATCH')
    return { home: value.live.homeWorkspaceId, receipt: { sameLeasedOwner: true, sameWorkspace: true,
      defaultSelectionWithoutOverride: true, verifiedPersonalHomePresent: true, memberCount: value.members.length, invitationCount: value.invitations.length } }
  }
  if (name === 'switcher') {
    check(value.workspace?.id === fixture.workspace && value.live?.ownerId === ownerId
      && value.live.workspaceId === homeWorkspaceId && list(value.accounts, 20), 'SWITCHER_SCOPE_MISMATCH')
    const own = value.accounts.filter(account => account.id === ownerId)
    check(own.length === 1 && list(own[0].choices) && own[0].choices.some(choice => choice.id === fixture.workspace), 'SWITCHER_OWNER_MISSING')
    return { receipt: { sameLeasedOwner: true, sameSelectedWorkspace: true, accountCount: value.accounts.length, choiceCount: own[0].choices.length } }
  }
  if (name === 'agent_sessions') {
    check(list(value.sessions) && list(value.turns) && value.sessionId === null && value.selectedSession === null
      && value.sessions.length === 0 && value.turns.length === 0, 'EMPTY_AGENT_HISTORY_EXPECTED')
    return { receipt: { emptyOwnedHistory: true, sessionCount: 0, turnCount: 0 } }
  }
  if (name === 'computer_first' || name === 'computer_cursor') {
    check(decimal(after) && list(value.events, 100) && decimal(value.cursor) && typeof value.hasMore === 'boolean', 'COMPUTER_PAGE_INVALID')
    let cursor = BigInt(after)
    for (const event of value.events) {
      check(decimal(event?.id) && BigInt(event.id) > cursor && Object.hasOwn(event, 'data'), 'COMPUTER_EVENT_ORDER_INVALID')
      cursor = BigInt(event.id)
    }
    check(BigInt(value.cursor) === cursor && !value.hasMore, 'COMPUTER_PAGE_INCOMPLETE')
    return { cursor: value.cursor, receipt: { shapeValidated: true, eventCount: value.events.length, pageComplete: true,
      originalReturnedCursorUsed: name === 'computer_cursor' } }
  }
  if (name === 'preferences') {
    check(['proactive', 'pushDecide', 'pushReview', 'pushFinished', 'pushBriefing', 'memoryEnabled', 'dailySuggestions']
      .every(key => typeof value[key] === 'boolean') && ['always', 'away'].includes(value.pushWhen)
      && ['enter', 'modEnter'].includes(value.sendKey) && typeof value.personalInstructions === 'string', 'PREFERENCES_INVALID')
    return { receipt: { shapeValidated: true, instructionTextExported: false } }
  }
  if (name === 'enrollment') {
    check(value.ownerId === ownerId && list(value.deviceIds) && value.deviceIds.every(uuid)
      && value.deviceIds.includes(fixture.device), 'ENROLLMENT_SCOPE_MISMATCH')
    return { receipt: { sameLeasedOwner: true, ownedFixtureDeviceFound: true, deviceCount: value.deviceIds.length, enrollmentCreated: false } }
  }
  if (name === 'conversations') {
    check(value.viewerId === ownerId && value.workspaceId === fixture.workspace && list(value.conversations)
      && value.conversations.some(item => item.id === fixture.group), 'GROUP_SCOPE_MISMATCH')
    return { receipt: { sameLeasedOwner: true, sameSelectedWorkspace: true, fixtureGroupFound: true, conversationCount: value.conversations.length } }
  }
  check(name === 'pending_actions' && list(value) && headers?.get('x-mikka-viewer') === encodeURIComponent(ownerId)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(headers?.get('x-mikka-observed-at') ?? ''), 'PENDING_ACTIONS_SCOPE_MISMATCH')
  return { receipt: { sameLeasedOwner: true, pendingCount: value.length, observationHeaderValidated: true, actionExecuted: false } }
}

export function batchCalls(thread, chat) {
  check(thread?.args && chat?.args, 'BATCH_REQUIRES_RETURNED_CURSORS')
  return [
    { action: 'task-runs.pollTaskRuns', args: [] },
    { action: 'task-runs.syncThreadList', args: thread.args },
    { action: 'coordinator.syncCoordinatorChat', args: chat.args },
  ]
}
