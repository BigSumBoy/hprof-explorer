/**
 * Host-side manager for the hprof_ptc tool (plan B).
 *
 * One short-lived child process runs one model-written program in a vm context
 * that sees only the `hprof` namespace and `console`. Every hprof call is a
 * JSON-line RPC back to this process, so the child never gets the parser, the
 * Host context, fs, or process globals. This is a plugin-local program runner,
 * not DSH's core run_code; see PTC_SEAM_PLAN.md for the generic seam (plan A).
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ptc-runner.mjs')
const MAX_CODE = 50_000
const MAX_RESULT = 256 * 1024
const MAX_LOGS = 20_000

function descriptorOf(service) {
  const operations = service.capabilities().operations ?? {}
  const groups = {}
  for (const operation of Object.keys(operations)) {
    if (operation === 'capabilities') continue
    const [group, name] = operation.split('.')
    if (group === undefined || name === undefined) continue
    if (!Object.hasOwn(groups, group)) groups[group] = []
    groups[group].push(name)
  }
  return groups
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one JavaScript program against the hprof service.
 * @param {object} service - createHprofService result.
 * @param {{ code?: unknown, timeoutMs?: unknown }} args - program and optional timeout.
 * @param {{ signal?: AbortSignal }} exec - tool execution context.
 * @returns {Promise<{ result: unknown, logs: string[] }>}
 */
export function runHprofPtc(service, args = {}, exec = {}) {
  const code = typeof args.code === 'string' ? args.code : ''
  if (code.trim() === '') return Promise.reject(new Error('code must be a non-empty string'))
  if (code.length > MAX_CODE) return Promise.reject(new Error(`code exceeds ${MAX_CODE} characters`))
  const timeoutMs = Math.min(60_000, Math.max(1_000, Number(args.timeoutMs) || 20_000))
  const descriptor = descriptorOf(service)
  const child = spawn(process.execPath, [RUNNER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })

  return new Promise((resolve, reject) => {
    let settled = false
    let stderr = ''
    let timer
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      exec.signal?.removeEventListener?.('abort', onAbort)
      try {
        child.kill()
      } catch {
        // The runner may have exited after sending its final message.
      }
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const onAbort = () => finish(new Error('hprof_ptc was aborted'))
    if (exec.signal?.aborted === true) {
      finish(new Error('hprof_ptc was aborted'))
      return
    }
    exec.signal?.addEventListener?.('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      finish(new Error(`hprof_ptc timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4_000) stderr += chunk
    })
    child.on('error', (error) => finish(new Error(`hprof_ptc runner failed: ${errorMessage(error)}`)))
    child.on('exit', (code, signal) => {
      if (settled) return
      const suffix = stderr.trim() === '' ? '' : `: ${stderr.trim()}`
      finish(new Error(`hprof_ptc runner exited (${signal ?? code})${suffix}`))
    })
    lines.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message?.type === 'call') {
        const id = message.id
        const op = typeof message.op === 'string' ? message.op : ''
        const params = message.params !== null && typeof message.params === 'object' ? message.params : {}
        void (async () => {
          try {
            const result = await service.dispatch(op, params, exec)
            const text = JSON.stringify(result)
            if (text !== undefined && text.length > MAX_RESULT) {
              throw new Error(`result exceeds ${MAX_RESULT} characters; paginate or project fields`)
            }
            child.stdin.write(`${JSON.stringify({ type: 'reply', id, ok: true, result })}\n`)
          } catch (error) {
            child.stdin.write(`${JSON.stringify({
              type: 'reply', id, ok: false, error: errorMessage(error),
            })}\n`)
          }
        })()
        return
      }
      if (message?.type !== 'done') return
      if (message.ok !== true) {
        finish(new Error(String(message.error ?? 'hprof_ptc failed')))
        return
      }
      const logs = Array.isArray(message.logs) ? message.logs.map(String).slice(0, 200) : []
      const logBytes = logs.join('\n').length
      finish(undefined, {
        result: message.result ?? null,
        logs: logBytes > MAX_LOGS ? [`… logs truncated at ${MAX_LOGS} characters`] : logs,
      })
    })

    child.stdin.write(`${JSON.stringify({ type: 'run', code, descriptor })}\n`)
  })
}
