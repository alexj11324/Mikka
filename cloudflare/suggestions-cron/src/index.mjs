import { runSchedule } from './schedule.mjs'

export default {
  fetch: () => new Response(null, { status: 404 }),
  /** @param {{ cron: string; scheduledTime: number }} controller @param {Env} env */
  async scheduled(controller, env) {
    await runSchedule(controller.cron, env, fetch, controller.scheduledTime)
  },
}
