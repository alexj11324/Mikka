import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleOriginAllowed } from './http'
test('browser schedule requests bind configured origin and actual Host despite internal Next URL',()=>{
 const make=(origin:string,host='127.0.0.1:3179')=>new Request('http://localhost:3179/mikka/api/schedules',{headers:{cookie:'synthetic-session',origin,host}})
 assert.equal(scheduleOriginAllowed(make('http://127.0.0.1:3179'),'http://127.0.0.1:3179'),true)
 assert.equal(scheduleOriginAllowed(make('https://attacker.example'),'http://127.0.0.1:3179'),false)
 assert.equal(scheduleOriginAllowed(make('http://127.0.0.1:3179','attacker.example'),'http://127.0.0.1:3179'),false)
 assert.equal(scheduleOriginAllowed(make(''),'http://127.0.0.1:3179'),false)
 const forwarded=make('https://attacker.example','attacker.example');forwarded.headers.set('x-forwarded-host','127.0.0.1:3179')
 assert.equal(scheduleOriginAllowed(forwarded,'http://127.0.0.1:3179'),false)
})
