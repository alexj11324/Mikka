#!/usr/bin/env node
// Offline official-auth protocol fixture. Contains only synthetic tokens.
import { existsSync, lstatSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { spawn } from "node:child_process"

const send = (value) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`)
const pending = new Map()
let login = null
let experimental = false
let turn = 0
const lines = createInterface({ input: process.stdin })
lines.on("line", async (line) => {
  const { id, method, params, result, error } = JSON.parse(line)
  if (!method) {
    const settled = pending.get(id)
    pending.delete(id)
    settled?.({ result, error })
    return
  }
  if (id === undefined) return
  if (method === "initialize") {
    experimental = params.capabilities?.experimentalApi === true
    return send({ id, result: { userAgent: "fixture" } })
  }
  if (method === "account/login/start") {
    if (
      !experimental ||
      params.type !== "chatgptAuthTokens" ||
      Object.keys(params).some(
        (key) =>
          ![
            "type",
            "accessToken",
            "chatgptAccountId",
            "chatgptPlanType"
          ].includes(key)
      ) ||
      existsSync(join(process.env.CODEX_HOME, "auth.json")) ||
      process.env.OPENAI_API_KEY
    )
      return send({
        id,
        error: { code: -1, message: "fixture auth boundary failed" }
      })
    if (params.accessToken === "fixture-unsupported")
      return send({
        id,
        error: { code: -1, message: "fixture-secret-must-not-leak" }
      })
    if (params.accessToken === "fixture-paid-mode")
      return send({ id, result: { type: "apiKey" } })
    login = params
    return send({ id, result: { type: "chatgptAuthTokens" } })
  }
  if (method === "thread/start") {
    if (!login)
      return send({
        id,
        error: { code: -1, message: "subscription login required" }
      })
    return send({
      id,
      result: { thread: { id: "fixture-subscription-thread" } }
    })
  }
  if (method === "turn/start") {
    const turnId = `fixture-turn-${++turn}`
    send({ id, result: { turn: { id: turnId } } })
    const prompt = params.input[0].text
    const fullComputer = prompt === 'FULL_COMPUTER' || prompt.startsWith('# FULL_COMPUTER\n')
    if (prompt === 'COMPUTER' || fullComputer) {
      async function call(server, name, args) {
        const prefix = `mcp_servers.${server}.args=`
        const configured = process.argv.find(value => value.startsWith(prefix))
        if (!configured) process.exit(2)
        const proxy = spawn('node', JSON.parse(configured.slice(prefix.length)), { stdio: ['pipe', 'pipe', 'ignore'] })
      const reply = new Promise((resolve, reject) => {
        const reader = createInterface({ input: proxy.stdout })
        reader.once('line', line => { reader.close(); resolve(JSON.parse(line)) })
        proxy.once('error', reject)
        proxy.once('exit', code => { if (code) reject(new Error('computer proxy failed')) })
      })
      proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
      const answer = await reply
      proxy.kill()
      if (answer.result?.isError) process.exit(2)
      }
      if (fullComputer) await call('mikka_computer', 'get_desktop_state', {})
      await call('mikka_computer', 'click', fullComputer ? { x: 150, y: 150 } : { x: 3, y: 4 })
      if (fullComputer) await call('mikka_computer', 'press_key', { key: 'tab' })
      if (fullComputer) await call('mikka_computer', 'scroll', { direction: 'down', amount: 2, x: 150, y: 150 })
      if (fullComputer) await call('mikka', 'submit', { summary: 'Synthetic computer task completed' })
    }
    if(prompt==='PROBE_GIT') {
      const target=lstatSync('.git').isFile()?'.git':'.git/guard'
      try{writeFileSync(target,'synthetic metadata mutation');process.exit(2)}catch(error){if(!['EROFS','EBUSY','EACCES'].includes(error.code))process.exit(2)}
    }
    if (prompt.includes("FAIL")) {
      send({
        method: "error",
        params: {
          error: { message: "fixture-secret-must-not-leak" },
          willRetry: false
        }
      })
      send({
        method: "turn/completed",
        params: {
          threadId: "fixture-subscription-thread",
          turn: {
            id: turnId,
            status: "failed",
            error: { message: "fixture-secret-must-not-leak" }
          }
        }
      })
      return
    }
    if (prompt.includes("CRASH")) {
      process.stderr.write("fixture-secret-must-not-leak")
      setTimeout(() => process.exit(1), 10)
      return
    }
    if (prompt.includes("REFRESH")) {
      const key = `refresh-${turn}`
      const reply = new Promise((resolve) => pending.set(key, resolve))
      send({
        id: key,
        method: "account/chatgptAuthTokens/refresh",
        params: {
          reason: "unauthorized",
          previousAccountId: prompt.includes("WRONG")
            ? "other-account"
            : login.chatgptAccountId
        }
      })
      const response = await reply
      if (
        response.error ||
        response.result?.chatgptAccountId !== login.chatgptAccountId ||
        response.result?.accessToken !== "fixture-access-rotated"
      )
        return
    }
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "fixture-subscription-thread",
        turnId,
        itemId: "fixture-text",
        delta: "Subscription fixture completed"
      }
    })
    send({
      method: "turn/completed",
      params: {
        threadId: "fixture-subscription-thread",
        turn: { id: turnId, status: "completed", error: null }
      }
    })
    return
  }
  if (method === "turn/interrupt") return send({ id, result: {} })
  send({ id, result: {} })
})
lines.on("close", () => process.exit(0))
