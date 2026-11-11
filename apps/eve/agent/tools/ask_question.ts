import {defineDynamic} from 'eve/tools'
import {askQuestion} from 'eve/tools/ask_question'
import {executionForSession} from '../../../../lib/eve/runtime'

/** Native Eve interactions pause and resume the owning turn. Scheduled reads
 * run without a person present and may not open a question. */
export default defineDynamic(async ctx => {
  const {scheduledRead}=await executionForSession(ctx)
  return scheduledRead ? null : askQuestion
})
