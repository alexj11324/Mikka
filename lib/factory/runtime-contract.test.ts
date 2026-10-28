import assert from 'node:assert/strict';
import { before, mock, test } from 'node:test';
import type { PoolClient } from 'pg';
import type { FactoryConsumerAdapter } from './consumer-contract';
let databaseCalls=0;
const unexpected = async () => {databaseCalls++;throw Error('unexpected database operation');};
mock.module('@/lib/db',{namedExports:{pool:{query:unexpected,connect:unexpected},withDatabaseClient:unexpected}});
mock.module('@/lib/issue-access',{namedExports:{issueForUser:unexpected}});
mock.module('@/lib/agent-runs',{namedExports:{queueRun:unexpected}});
let runtime:typeof import('./runtime');
before(async()=>{runtime=await import('./runtime');});
test('actual runtime stays default-off and rejects incomplete or conflicting host registrations before SQL',async()=>{
  const keys=['MIKKA_FACTORY_ROUTING_ENABLED','MIKKA_FACTORY_LIFECYCLE_ENABLED'];
  const saved=keys.map(key=>process.env[key]);
  const adapter:FactoryConsumerAdapter={stage:'monitor',configure:async()=>{},validateClaim:async()=>({}),gate:async()=>false,reconcile:async()=>{}};
  try {
    for(const key of keys)delete process.env[key];
    assert.throws(()=>runtime.factoryRuntimeForBot('bot'),/factoryLifecycleUnavailable/);
    assert.deepEqual(await runtime.guardFactoryClaim({query:unexpected} as unknown as PoolClient,'owner','device','run','future'),{});
    for(const key of keys)process.env[key]='1';
    assert.throws(()=>runtime.factoryRuntimeForBot('bot',{}, {},undefined,{},[{...adapter,gate:undefined} as unknown as FactoryConsumerAdapter]),/factoryConsumerRegistrationInvalid/);
    assert.throws(()=>runtime.factoryRuntimeForBot('bot',{}, {monitor:adapter.configure},undefined,{},[adapter]),/factoryConsumerRegistrationInvalid/);
    assert.throws(()=>runtime.factoryRuntimeForBot('bot',{}, {},adapter.validateClaim,{},[adapter]),/factoryConsumerRegistrationInvalid/);
    assert.throws(()=>runtime.factoryRuntimeForBot('bot',{gates:{monitor:adapter.gate}}, {},undefined,{},[adapter]),/factoryConsumerRegistrationInvalid/);
    assert.throws(()=>runtime.factoryRuntimeForBot('bot',{}, {},undefined,{monitor:adapter.reconcile},[adapter]),/factoryConsumerRegistrationInvalid/);
    // Construction installs no route, performs no probe, and does not execute any hook.
    assert.equal(typeof runtime.factoryRuntimeForBot('bot',{}, {},undefined,{},[adapter]).claim,'function');
    assert.equal(databaseCalls,0);
  } finally {
    keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
  }
});
