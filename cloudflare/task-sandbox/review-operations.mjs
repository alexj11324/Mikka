import { machineGrant } from './grant.mjs'
import { aliasInstance, guestControl, previewAlias, previewRequest, previewSuffix, reviewScope } from './review-access.mjs'

const notFound = () => new Response(null, {status:404})
const leaseKey = id => 'review-lease:' + id
const aliasKey = alias => 'review-alias:' + alias
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const safePort = port => Number.isInteger(port) && port >= 1024 && port <= 65535

export async function routeReviewBrowser(request, env) {
  const suffix = previewSuffix(env), url = new URL(request.url)
  const alias = suffix && url.protocol === 'https:' && url.host.endsWith('.'+suffix) ? url.host.slice(0,-(suffix.length+1)) : ''
  const instance = aliasInstance(alias)
  if (!instance) return notFound()
  try {
    const machine = env.TASKS.get(env.TASKS.idFromString(instance))
    return await machine.reviewBrowser(alias, previewRequest(request, 'https://'+alias+'.'+suffix))
  } catch { return notFound() }
}
export async function reviewBrowser(machine, alias, request) {
  const {storage, container} = machine.ctx, run = await storage.get('run'), now = Date.now()
  if (run?.state !== 'running' || !run.reviewBoot || !container?.running || now >= Math.min(run.expiresAt,run.hardDeadline)) return notFound()
  const id = await storage.get(aliasKey(alias)), lease = id && await storage.get(leaseKey(id))
  if (!lease || lease.closed || lease.boot !== run.reviewBoot.bootId || lease.scope.expiresAt <= now || lease.preview?.alias !== alias)
    return notFound()
  return container.getTcpPort(lease.preview.gatewayPort).fetch(request)
}

export async function review(machine, identity, operation, openScoped) {
  const grant = machineGrant(identity)
  await machine.verifyScope(grant)
  if (operation?.action === 'revoke') return machine.exclusive(() => closeReview(machine, grant, operation))
  const scope = reviewScope(operation?.scope), storage = machine.ctx.storage
  if (grant.expiresAt !== scope.expiresAt) throw Error('Invalid task review scope')
  if (operation.action === 'attach') {
    const prior = await storage.get('run')
    if (!prior || prior.stoppedAt || prior.review) await openScoped(grant, scope)
  }
  return machine.exclusive(async () => {
    const run = await storage.get('run'), now = Date.now()
    if (run?.state !== 'running' || !run.reviewBoot || !machine.ctx.container?.running || run.grant.runId !== grant.runId ||
        (run.review?.sourceOperationId ?? run.grant.operationId) !== scope.sourceOperationId ||
        (run.review && run.grant.operationId !== grant.operationId) || now >= Math.min(run.expiresAt, run.hardDeadline, scope.expiresAt))
      throw Error('Task machine run mismatch')
    const key = leaseKey(scope.leaseId), stored = await storage.get(key)
    if (stored && (stored.closed || stored.boot !== run.reviewBoot.bootId || stored.operationId !== grant.operationId ||
        stored.scope.bindingId !== scope.bindingId || stored.scope.kind !== scope.kind || stored.scope.expiresAt <= now)) throw Error('Task review lease expired')
    if (operation.action === 'attach') {
      await storage.put(key, {...stored, scope:{...scope,expiresAt:Math.min(scope.expiresAt,stored?.scope.expiresAt ?? Infinity)},
        boot:run.reviewBoot.bootId, operationId:grant.operationId})
      return {attached:true}
    }
    if (!stored) throw Error('Task review lease expired')
    if (scope.kind === 'preview') return previewControl(machine, run, grant, key, stored, operation)
    if (['terminal-prepare','terminal-existing'].includes(operation.action) && /^[A-Za-z0-9+/]{43}=$/.test(operation.key ?? '')) {
      const result = await guestControl(machine.ctx.container, operation.action, {key:operation.key})
      await storage.put(key, {...stored,terminal:true})
      return result
    }
    const method = {stream:'GET',input:'POST',resize:'POST',close:'POST'}[operation.action]
    if (!['GET','POST'].includes(method) || typeof operation.ticket !== 'string' || operation.ticket.length > 8192 ||
        typeof operation.body !== 'string' || operation.body.length > 8192) throw Error('Invalid task review scope')
    const headers = {authorization:'Bearer '+operation.ticket, ...(method === 'GET' ? {accept:'text/event-stream'} : {'content-type':'application/json'})}
    return machine.ctx.container.getTcpPort(6084).fetch(new Request('http://localhost/' + operation.action,
      {method, redirect:'manual', headers, ...(method === 'POST' ? {body:operation.body} : {})}))
  })
}

async function previewControl(machine, run, grant, key, stored, operation) {
  const scope = stored.scope, suffix = previewSuffix(machine.env)
  if (!suffix) throw Error('Private task preview domain unavailable')
  const binding = {taskId:grant.taskId,runId:grant.runId,ownerId:grant.ownerId,workspaceId:grant.workspaceId,
    deviceId:scope.deviceId,repoId:scope.repoId,sandboxId:machine.ctx.id.toString(),epoch:scope.epoch,
    worktreePath:scope.worktreePath,expiresAt:Math.min(scope.expiresAt,run.expiresAt,run.hardDeadline)/1000}
  if (operation.action === 'preview-prepare') {
    if (operation.port !== undefined && !safePort(operation.port)) throw Error('Invalid task review scope')
    const reply = await guestControl(machine.ctx.container,'preview',{operation:'prepare',binding,
      ...(operation.port === undefined ? {} : {port:operation.port})})
    if (reply.running !== true) return {running:false,code:reply.code,error:reply.error}
    if (!safePort(reply.gatewayPort) || !safePort(reply.port)) throw Error('Task review control unavailable')
    const alias = stored.preview?.alias ?? previewAlias(machine.ctx.id.toString())
    await machine.ctx.storage.put({[key]:{...stored,preview:{alias,gatewayPort:reply.gatewayPort,port:reply.port}},[aliasKey(alias)]:scope.leaseId})
    return {running:true,port:reply.port,expiresAt:binding.expiresAt,origin:'https://'+alias+'.'+suffix}
  }
  if (operation.action !== 'preview-issue' || !stored.preview || !Number.isSafeInteger(operation.expiresAt) ||
      operation.expiresAt <= Date.now() || operation.expiresAt > scope.expiresAt) throw Error('Invalid task review scope')
  const parent = new URL(operation.parentOrigin), origin = 'https://'+stored.preview.alias+'.'+suffix
  if (parent.protocol !== 'https:' || parent.origin !== operation.parentOrigin || parent.origin === origin)
    throw Error('Invalid task review scope')
  binding.expiresAt = Math.min(binding.expiresAt, operation.expiresAt/1000)
  const issued = await guestControl(machine.ctx.container,'preview',{operation:'issue',binding,gatewayPort:stored.preview.gatewayPort,
    origin,parentOrigin:parent.origin,leaseId:scope.leaseId})
  return {ticket:issued.ticket,expiresAt:issued.expiresAt,origin}
}

async function closeReview(machine, grant, op) {
  if (!Array.isArray(op.leaseIds) || !op.leaseIds.length || op.leaseIds.length > 2 ||
      !op.leaseIds.every(id=>typeof id === 'string' && uuid.test(id)) || !['terminal','preview'].includes(op.kind))
    throw Error('Invalid task review scope')
  const {storage,container} = machine.ctx, run = await storage.get('run')
  for (const id of op.leaseIds) {
    const key = leaseKey(id), lease = await storage.get(key)
    if (lease && (lease.operationId !== grant.operationId || (lease.scope && lease.scope.kind !== op.kind))) throw Error('Task machine run mismatch')
    const retired = {...lease,closed:true,operationId:grant.operationId,discardAfter:Date.now()+335_000}
    await storage.put(key,retired)
    if (lease?.preview) await storage.delete(aliasKey(lease.preview.alias))
    if (!lease?.scope || lease.closedAck || run?.state !== 'running' || run.grant.runId !== grant.runId ||
        run.reviewBoot?.bootId !== lease.boot || !container?.running) continue
    if (op.kind === 'preview' && lease.preview) {
      const out = await guestControl(container,'preview',{operation:'revoke',runId:grant.runId,leaseIds:[id]})
      if (out.revoked !== true) throw Error('Task review close unconfirmed')
    } else if (op.kind === 'terminal' && lease.terminal) {
      const out = await guestControl(container,'terminal-revoke',{runId:grant.runId,workspaceId:grant.workspaceId,ownerId:grant.ownerId,leaseIds:[id]})
      if (out.revoked !== true) throw Error('Task review close unconfirmed')
    }
    await storage.put(key,{...retired,closedAck:true})
  }
  if (run?.review && run.grant.operationId === grant.operationId) {
    if (run.stoppedAt) return {closed:true,stopped:machine.receipt(run)}
    const remaining = await storage.list({prefix:'review-lease:'})
    if (![...remaining.values()].some(v=>v.operationId === grant.operationId && !v.closed && v.scope.expiresAt > Date.now()))
      return {closed:true,stopped:await machine.stop(run,'settled',true)}
  }
  return {closed:true}
}
