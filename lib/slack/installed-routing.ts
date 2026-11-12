import { selectableSlackChannel, slackTeamId, slackUserId } from './install-provider'

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
export function signedCoordinates(app: string, input: unknown) {
  const p = record(input)
  if (p.api_app_id !== app || p.is_enterprise_install === true) return null
  const team = p.team_id ?? record(p.team).id
  if (!slackTeamId(team)) return null
  // An external Slack Connect/Enterprise sender must never be admitted under a local installation's identity.
  const e = record(p.event),
    u = record(p.user)
  if ((e.user_team && e.user_team !== team) || (u.team_id && u.team_id !== team) || p.is_ext_shared_channel === true)
    return null
  if (
    Array.isArray(p.authorizations) &&
    p.authorizations.some((a) => record(a).is_bot === true && record(a).team_id !== team)
  )
    return null
  let channel: unknown, sender: unknown, eventId: string | undefined
  if (p.type === 'event_callback') {
    if (
      !['app_mention', 'message'].includes(String(e.type)) ||
      e.bot_id ||
      e.subtype ||
      typeof e.text !== 'string' ||
      typeof p.event_id !== 'string' ||
      !/^Ev[A-Za-z0-9]+$/.test(p.event_id)
    )
      return null
    channel = e.channel
    sender = e.user
    eventId = p.event_id
  } else if (p.type === 'block_actions' || p.type === 'view_submission') {
    sender = u.id
    channel = record(p.channel).id ?? record(p.container).channel_id
    if (!channel && p.type === 'view_submission') {
      try {
        channel = record(JSON.parse(String(record(p.view).private_metadata))).channelId
      } catch {
        return null
      }
    }
  } else return null
  if (
    !slackUserId(sender) ||
    typeof channel !== 'string' ||
    !(selectableSlackChannel(channel) || /^D[A-Z0-9]{1,40}$/.test(channel))
  )
    return null
  const authorizations = Array.isArray(p.authorizations)
    ? p.authorizations.map(record).filter((a) => a.is_bot === true)
    : []
  return { team, sender, channel, eventId, botUsers: authorizations.map((a) => a.user_id) }
}

export function signedRevocation(app: string, input: unknown) {
  const p = record(input),
    event = record(p.event),
    team = p.team_id
  if (
    p.api_app_id !== app ||
    p.type !== 'event_callback' ||
    !slackTeamId(team) ||
    typeof p.event_time !== 'number' ||
    !Number.isSafeInteger(p.event_time) ||
    p.event_time <= 0
  )
    return null
  if (event.type === 'user_change') {
    const user = record(event.user)
    return user.deleted === true && user.team_id === team && slackUserId(user.id)
      ? { team, member: user.id, eventAt: p.event_time }
      : null
  }
  if (event.type === 'app_uninstalled') return { team, bots: null, eventAt: p.event_time }
  const bots = record(event.tokens).bot
  return event.type === 'tokens_revoked' && Array.isArray(bots) && bots.every(slackUserId)
    ? { team, bots: bots as string[], eventAt: p.event_time }
    : null
}
