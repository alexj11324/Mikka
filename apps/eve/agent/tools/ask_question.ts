import {defineWorkflowTool} from 'eve/tools'
import {askQuestion} from 'eve/tools/ask_question'
import {scopeFromAuth} from '../../../../lib/eve/scope'

/** Native Eve interactions pause and resume the owning turn. Scheduled reads
 * run without a person present and may not open a question. */
export default defineWorkflowTool({
  ...askQuestion,
  async approval(ctx) {
    const scope=scopeFromAuth(ctx.session.auth.current)
    const {pool}=await import('../../../../lib/db')
    const source=(await pool.query<{source_event_id:string}>('SELECT source_event_id FROM eve_turn_sources WHERE session_id=$1 AND turn_id=$2',[ctx.session.id,ctx.session.turn.id])).rows[0]
    const scheduled=source ? await (await import('../../../../lib/eve/scheduled-read')).loadScheduledRead(scope,source.source_event_id) : null
    return scheduled ? 'denied' : 'not-applicable'
  },
})
