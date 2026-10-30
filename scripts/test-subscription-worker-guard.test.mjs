import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('custody acceptance loads server-only shim and passes preservation to both test processes',async()=>{
 const source=await readFile(new URL('./test-subscription-worker.mjs',import.meta.url),'utf8')
 assert.match(source, /\["--import", "\.\/tests\/support\/server-only\.mjs", "--import", "tsx", "--test", "tests\/byos-application\.test\.mjs"/)
 assert.match(source, /dockerArgs\.push\('-e', 'MIKKA_PRESERVE_BYOS_FIXTURES=1'/)
 assert.match(source, /MIKKA_PRESERVE_BYOS_FIXTURES: process\.env\.MIKKA_PRESERVE_BYOS_FIXTURES/)
})
