import { defineHook } from 'eve/hooks'
import { stampSlackSession } from '../../../../lib/slack/channel-scope'

export default defineHook({
  events: {
    'session.started'(_event, ctx) {
      stampSlackSession(ctx.session.auth.current)
    },
    'turn.started'(_event, ctx) {
      stampSlackSession(ctx.session.auth.current)
    },
  },
})
