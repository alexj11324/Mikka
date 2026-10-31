import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'
import { ScheduleError } from './contract'

const calls:string[]=[]
let nativeAllowed=true,scheduledAllowed=true
mock.module('../../lib/coordinator/native.ts',{namedExports:{nativeCoordinatorStore:{assertToolActive:async()=>{calls.push('native');if(!nativeAllowed)throw new Error('nativeDenied')}}}})
mock.module('../../lib/schedules/runtime.ts',{namedExports:{assertScheduledRead:async()=>{calls.push('schedule');if(!scheduledAllowed)throw new ScheduleError('scheduleReadAuthorityLost',403)}}})
let assertNativeToolScope:typeof import('../../workflows/coordinator/tool-scope').assertNativeToolScope
before(async()=>{({assertNativeToolScope}=await import('../../workflows/coordinator/tool-scope'))})
const scheduledRead={botId:null,occurrence:{occurrenceId:'d4303c80-b410-43b8-a6ab-5db89d3c05ce',leaseToken:randomUUID(),allowedActions:['get_issue'],prompt:'Read only'}}
beforeEach(()=>{calls.length=0;nativeAllowed=true;scheduledAllowed=true})
test('scheduled SDK calls use the occurrence authority without manufacturing native identities',async()=>{await assertNativeToolScope('owner',{scheduledRead});assert.deepEqual(calls,['schedule'])})
test('scheduled native calls retain the current holder/turn/call fence as well',async()=>{await assertNativeToolScope('owner',{holder:'host',turnId:'turn',callId:'call',scheduledRead});assert.deepEqual(calls,['native','schedule'])})
test('a stopped native call cannot proceed through a still-valid schedule',async()=>{nativeAllowed=false;await assert.rejects(assertNativeToolScope('owner',{holder:'host',turnId:'turn',callId:'call',scheduledRead}),/nativeDenied/);assert.deepEqual(calls,['native'])})
test('cancellation or stale schedule scope refuses both SDK and native calls',async()=>{scheduledAllowed=false;await assert.rejects(assertNativeToolScope('owner',{scheduledRead}),/scheduleReadAuthorityLost/);await assert.rejects(assertNativeToolScope('owner',{holder:'host',turnId:'turn',callId:'call',scheduledRead}),/scheduleReadAuthorityLost/);assert.deepEqual(calls,['schedule','native','schedule'])})
