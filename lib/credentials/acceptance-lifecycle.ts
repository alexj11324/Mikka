// Explicit one-run synthetic acceptance only; no approval is created here.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAcceptanceResourceRegistry } from './acceptance-resource-registry'
import type { AcceptanceProfile, AcceptanceResources } from './owned-chromium'
import type { Binding } from './contracts'
import { prepareAdmission, admitRun, admitCall, admitCleanup } from '../../scripts/disposal/credential-admission.mjs'

export async function prepareAcceptanceLifecycle(parent: string, binding: Binding) {
  const registry = await createAcceptanceResourceRegistry(parent, { profiles: 2, launches: 2 })
  const base = registry.acceptanceResources()
  const profiles = [await base.prepareProfile(), await base.prepareProfile()]
  const reservations = await Promise.all(profiles.map(p => readFile(join(registry.root, `${p.id}.reservation.json`), 'utf8').then(JSON.parse)))
  const prepared = prepareAdmission(registry.root, binding, reservations, '/usr/lib/chromium/chromium')
  const resources = bindAcceptanceLifecycle(base, profiles, prepared.plan, binding)
  return { root: registry.root, manifestHash: prepared.manifestHash, plan: structuredClone(prepared.plan), resources }
}

export function bindAcceptanceLifecycle(base: AcceptanceResources, profiles: AcceptanceProfile[], preparedPlan: ReturnType<typeof prepareAdmission>['plan'], binding: Binding): AcceptanceResources {
  const plan = structuredClone(preparedPlan), expectedBinding = structuredClone(binding)
  let admitted = false, next = 0
  const indexOf = (profile: AcceptanceProfile) => {
    const index = profiles.findIndex(p => p.id === profile.id)
    assert.ok(index >= 0, 'unknown lifecycle reservation')
    assert.deepEqual(profile, profiles[index])
    return index
  }
  const resources: AcceptanceResources = {
    async prepareProfile(actual) {
      assert.deepEqual(actual, expectedBinding, 'binding changed')
      assert.ok(next < 2, 'executor call budget exhausted')
      return profiles[next]
    },
    async admitLaunch(profile, actual) {
      assert.deepEqual(actual, expectedBinding)
      const index = indexOf(profile); assert.equal(index, next, 'out of order executor call')
      await base.beforeCleanup(profile, 'launch-blocked') // directory/owner checks before any admission
      if (!admitted) { admitRun(plan, actual); admitted = true }
      const result = admitCall(plan, plan.sessions[index].role, actual)
      next++
      return result
    },
    started: base.started,
    async beforeCleanup(profile, stage) {
      const index = indexOf(profile)
      if (!admitted) { await base.beforeCleanup(profile, stage); return }
      // Exact spawn receipts also handle an already-exited browser. The retained-only
      // registry hook requires a live registered PID and must not gate this branch.
      return admitCleanup(plan, plan.sessions[index].role, expectedBinding)
    },
    recordFailure: base.recordFailure,
  }
  return resources
}
