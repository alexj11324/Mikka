import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retainEnrollmentSourcesForAcceptance } from './subscription-enrollment-policy'

test('isolated test retention cannot disable normal production cleanup',()=>{
  for(const [environment,flag,expected] of [['preview',undefined,false],['preview','1',true],['production','1',false],['development','1',false],[undefined,'1',false],['preview','0',false]] as const){
    assert.equal(retainEnrollmentSourcesForAcceptance({VERCEL_ENV:environment,MIKKA_BYOS_ACCEPTANCE_RETAIN_SOURCES:flag}),expected)
  }
})
