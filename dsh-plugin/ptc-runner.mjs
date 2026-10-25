/**
 * Isolated program runner for the hprof_ptc tool (plan B).
 *
 * The Host sends one `run` message with a program and a namespace descriptor;
 * the program sees a context-created `hprof` object plus `console`. Every
 * hprof call crosses a JSON-line RPC back to the Host, where the real service
 * executes. Values are JSON-cloned at the boundary so host objects never leak
 * into the sandbox realm. The Host owns the timeout and kills this process.
 */
import { createInterface } from 'node:readline'
import vm from 'node:vm'

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
const pending = new Map()
const logs = []
let nextCall = 0
let running = false

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function logHost(args) {
  if (logs.length >= 200) return
  let text
  try {
    text = args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
  } catch {
    text = '[unserializable]'
  }
  logs.push(String(text).slice(0, 2_000))
}

function callHost(op, params) {
  return new Promise((resolve) => {
    const id = ++nextCall
    pending.set(id, resolve)
    send({ type: 'call', id, op, params: params ?? {} })
  })
}

const factory = new vm.Script(`(callHost, logHost, descriptorJson) => {
  const descriptor = JSON.parse(descriptorJson)
  const invoke = (op, params) => callHost(op, params).then((replyJson) => {
    const reply = JSON.parse(replyJson)
    if (!reply.ok) throw new Error(String(reply.error))
    const value = reply.result
    if (value === undefined || value === null) return value
    return JSON.parse(JSON.stringify(value))
  })
  const hprof = {
    call: (op, params) => invoke(op, params),
    capabilities: () => invoke('capabilities', {}),
  }
  for (const group of Object.keys(descriptor)) {
    hprof[group] = {}
    for (const name of descriptor[group]) {
      hprof[group][name] = (params) => invoke(group + '.' + name, params)
    }
  }
  const console = {
    log: (...args) => logHost(args),
    info: (...args) => logHost(args),
    warn: (...args) => logHost(args),
    error: (...args) => logHost(args),
  }
  return { hprof, console }
}`)

async function run(message) {
  if (running) {
    send({ type: 'done', ok: false, error: 'a program is already running' })
    return
  }
  running = true
  try {
    const context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
    })
    const makeBindings = factory.runInContext(context)
    const api = makeBindings(callHost, logHost, JSON.stringify(message.descriptor ?? {}))
    const program = new vm.Script(`(async (hprof, console) => {\n${message.code}\n})`)
    const fn = program.runInContext(context)
    const result = await fn(api.hprof, api.console)
    const resultText = JSON.stringify(result === undefined ? null : result)
    if (resultText === undefined) throw new Error('program result is not JSON serializable')
    if (resultText.length > 200_000) throw new Error('program result exceeds 200000 characters')
    send({ type: 'done', ok: true, result: JSON.parse(resultText), logs })
  } catch (error) {
    send({
      type: 'done',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      logs,
    })
  }
}

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message?.type === 'reply') {
    const resolve = pending.get(message.id)
    if (resolve !== undefined) {
      pending.delete(message.id)
      resolve(JSON.stringify({ ok: message.ok === true, result: message.result, error: message.error }))
    }
    return
  }
  if (message?.type === 'run') void run(message)
})

rl.on('close', () => {
  for (const resolve of pending.values()) resolve(JSON.stringify({ ok: false, error: 'runner closed' }))
  pending.clear()
  process.exit(0)
})
