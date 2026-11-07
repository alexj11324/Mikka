// Test-only closed labels. Never retain an arbitrary route, SQL, argument or ID.
module.exports = Object.freeze([
  '/api/auth/[...all]', '/api/desktop/begin', '/api/desktop/return',
  '/api/desktop/exchange', '/api/desktop/rpc', '/api/rpc',
  '/api/workspace', '/api/workspace/switcher', '/api/live/ticket',
  '/actions/coordinator/chat', '/actions/coordinator/poll', '/actions/coordinator/summaries',
  '/actions/threads/poll', '/actions/task-runs/read', '/actions/issues/poll',
  '/actions/projects/list', 'unattributed',
])
