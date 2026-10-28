import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
const deny = () => { throw new Error('pure-test guard: external transport or destructive filesystem operation forbidden') }
globalThis.fetch = deny
net.Socket.prototype.connect = deny
net.createConnection = deny
net.connect = deny
net.createServer = deny
http.request = deny
http.get = deny
http.createServer = deny
https.request = deny
https.get = deny
for (const key of ['unlink','unlinkSync','rm','rmSync','rmdir','rmdirSync','rename','renameSync']) if (key in fs) fs[key] = deny
for (const key of ['unlink','rm','rmdir','rename']) if (key in fsp) fsp[key] = deny
syncBuiltinESMExports()
