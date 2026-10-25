/**
 * DeepSeek Harness adapter for HPROF Explorer (B-plan).
 *
 * The plugin owns one engine child process per open dump (`engine.mjs`), exposes
 * the dump registry to tools, and registers `/hprof-api` routes for the native
 * Client panel. The parser and dominator tree stay in the engine process, so a
 * 129 MB dump does not occupy Harness Host memory.
 *
 * Consumers:
 *   - hprof_* tools and the generic hprof_api service tool (model-facing)
 *   - /hprof-api routes (Client panel, same-origin fetch behind the connection fence)
 *   - `ctx.hprof` is not provided as a Cordis service yet; `service.mjs` is the
 *     shared read-only domain layer the tools and routes can converge on.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHprofService } from './service.mjs'
import { createFindingsStore } from './findings.mjs'
import { createUiState } from './ui-state.mjs'
import { runHprofPtc } from './ptc.mjs'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_APP_DIR = path.resolve(PLUGIN_DIR, '..')
const API_PREFIX = '/hprof-api'

/** Cordis plugin name. */
export const name = 'hprof-explorer'
/** Tools are always available; HTTP routes wait for the Web-profile services. */
export const inject = ['tools']

const DEFAULTS = {
  appDir: DEFAULT_APP_DIR,
  nodePath: process.execPath,
  nodeArgs: [],
  maxDumps: 3,
  startTimeoutMs: 180_000,
  requestTimeoutMs: 60_000,
  profileTimeoutMs: 180_000,
  idleTimeoutMs: 15 * 60_000,
  maxPageSize: 200,
  workspaceRoot: undefined,
}

/**
 * Register the adapter in a Harness profile.
 * @param ctx - plugin context carrying `ctx.tools`.
 * @param config - optional adapter configuration; see DEFAULTS.
 */
export function apply(ctx, config = {}) {
  const runtime = createHprofRuntime(config)
  const findings = createFindingsStore(runtime)
  const uiState = createUiState()
  const service = createHprofService(runtime, { findings, uiState })
  ctx.effect(() => () => runtime.dispose())

  for (const definition of createToolDefinitions(runtime, { findings, uiState, service })) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  ctx.inject(['webServer', 'connection'], (scope) => {
    const handler = createApiHandler(runtime, { findings, uiState, service })
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        const rejection = scope.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        return handler(req, res)
      },
    }), `hprof: ${API_PREFIX} routes`)
  })
}

/**
 * Build the dump registry and the engine protocol client without a Harness
 * context. Exported for standalone smoke tests.
 * @param config - optional adapter configuration; see DEFAULTS.
 */
export function createHprofRuntime(config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  cfg.maxDumps = Math.max(1, Math.floor(Number(cfg.maxDumps) || DEFAULTS.maxDumps))
  const enginePath = path.join(PLUGIN_DIR, 'engine.mjs')
  const dumps = new Map()
  let nextDump = 0
  let disposed = false

  function appDir() {
    const dir = path.resolve(cfg.appDir)
    if (!fs.existsSync(path.join(dir, 'src', 'hprof.mjs'))) {
      throw new Error(`hprof appDir does not contain src/hprof.mjs: ${dir}`)
    }
    return dir
  }

  function baseDir(exec) {
    return exec?.agent?.session?.header?.cwd ?? cfg.workspaceRoot ?? process.cwd()
  }

  function resolvePath(input, exec) {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new Error('path must be a non-empty string')
    }
    return path.resolve(baseDir(exec), input)
  }

  function touch(rec) {
    rec.lastUsed = Date.now()
    if (rec.timer !== undefined) clearTimeout(rec.timer)
    rec.timer = setTimeout(() => stop(rec), cfg.idleTimeoutMs)
    rec.timer.unref?.()
  }

  function stop(rec) {
    if (rec.timer !== undefined) {
      clearTimeout(rec.timer)
      rec.timer = undefined
    }
    for (const pending of rec.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`dump ${rec.id} was closed`))
    }
    rec.pending.clear()
    if (rec.child !== undefined && rec.child.exitCode === null) {
      try {
        rec.child.kill()
      } catch {
        // The engine may already have exited; nothing left to release.
      }
    }
    if (dumps.get(rec.id) === rec) dumps.delete(rec.id)
  }

  function dispose() {
    disposed = true
    for (const rec of [...dumps.values()]) stop(rec)
  }

  function pickDump(dumpId) {
    if (dumpId !== undefined) {
      const rec = dumps.get(String(dumpId))
      if (rec === undefined) throw new Error(`unknown dump_id "${dumpId}"; call hprof_open first`)
      touch(rec)
      return rec
    }
    let latest
    for (const rec of dumps.values()) {
      if (latest === undefined || rec.lastUsed > latest.lastUsed) latest = rec
    }
    if (latest === undefined) throw new Error('no dump is open; call hprof_open first')
    touch(latest)
    return latest
  }

  function evictIfNeeded() {
    while (dumps.size >= cfg.maxDumps) {
      let oldest
      for (const rec of dumps.values()) {
        if (oldest === undefined || rec.lastUsed < oldest.lastUsed) oldest = rec
      }
      if (oldest === undefined) return
      stop(oldest)
    }
  }

  async function open(inputPath, exec) {
    if (disposed) throw new Error('hprof adapter is disposed')
    const abs = resolvePath(inputPath, exec)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      throw new Error(`hprof file not found: ${abs}`)
    }
    if (!stat.isFile()) throw new Error(`not a file: ${abs}`)
    if (abs.toLowerCase().endsWith('.zip')) {
      throw new Error('expected an extracted .hprof file, not a .zip; unzip it first')
    }

    const real = safeRealpath(abs)
    const existing = [...dumps.values()].find((rec) => rec.realPath === real)
    if (existing !== undefined && existing.child.exitCode === null) {
      touch(existing)
      if (existing.opened === undefined) throw new Error(`dump ${existing.id} is still opening; retry shortly`)
      return existing.opened
    }
    if (existing !== undefined) stop(existing)
    evictIfNeeded()

    const rec = {
      id: `dump-${++nextDump}`,
      path: abs,
      realPath: real,
      child: undefined,
      pending: new Map(),
      nextRequest: 0,
      stderr: '',
      lastUsed: Date.now(),
      timer: undefined,
      opened: undefined,
      summary: undefined,
      readyPromise: undefined,
      resolveReady: undefined,
      rejectReady: undefined,
      fatal: undefined,
    }
    dumps.set(rec.id, rec)
    touch(rec)

    const dir = appDir()
    const child = spawn(
      cfg.nodePath,
      [...cfg.nodeArgs, enginePath, abs],
      {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, HPROF_APP_DIR: dir },
      },
    )
    rec.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      rec.stderr = (rec.stderr + chunk).slice(-8_000)
    })
    rec.readyPromise = new Promise((resolve, reject) => {
      rec.resolveReady = resolve
      rec.rejectReady = reject
    })
    lineReader(child.stdout, (line) => handleEngineLine(rec, line))
    child.once('error', (error) => {
      rec.rejectReady?.(new Error(`failed to spawn hprof engine: ${error.message}`))
    })
    child.once('exit', (code) => {
      const message = `hprof engine exited (code ${code})${rec.fatal === undefined ? '' : `: ${rec.fatal}`}`
      rec.rejectReady?.(new Error(`${message}: ${tail(rec.stderr)}`))
      for (const pending of rec.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(message))
      }
      rec.pending.clear()
      if (dumps.get(rec.id) === rec) dumps.delete(rec.id)
    })

    try {
      await raceTimeout(rec.readyPromise, cfg.startTimeoutMs, `hprof engine did not start within ${cfg.startTimeoutMs} ms: ${tail(rec.stderr)}`)
      const summary = await call(rec, 'summary', {}, { signal: exec?.signal })
      const retained = await call(rec, 'retained', { page: 0, size: 10 }, { signal: exec?.signal })
      rec.summary = summary
      rec.opened = describeOpen(rec, summary, retained)
      return rec.opened
    } catch (error) {
      stop(rec)
      throw error
    }
  }

  function handleEngineLine(rec, line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message?.event === 'ready') {
      rec.resolveReady?.(message)
      return
    }
    if (message?.event === 'fatal') {
      rec.fatal = String(message.error)
      rec.rejectReady?.(new Error(`hprof engine failed: ${rec.fatal}`))
      return
    }
    if (message?.id === undefined) return
    const pending = rec.pending.get(message.id)
    if (pending === undefined) return
    rec.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok === true) pending.resolve(message.result)
    else pending.reject(new Error(String(message.error ?? 'hprof engine error')))
  }

  function call(rec, method, params = {}, options = {}) {
    if (rec.fatal !== undefined) return Promise.reject(new Error(rec.fatal))
    if (rec.child.exitCode !== null) return Promise.reject(new Error(`hprof engine for ${rec.id} exited; reopen the dump`))
    const signal = options.signal
    if (signal?.aborted === true) return Promise.reject(new Error('aborted'))
    const id = ++rec.nextRequest
    const timeoutMs = options.timeoutMs ?? cfg.requestTimeoutMs
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = rec.pending.get(id)
        if (pending === undefined) return
        rec.pending.delete(id)
        clearTimeout(pending.timer)
        reject(new Error('aborted'))
      }
      const timer = setTimeout(() => {
        rec.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`hprof ${method} exceeded ${timeoutMs} ms`))
      }, timeoutMs)
      rec.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        rec.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        rec.pending.delete(id)
        reject(new Error(`failed to write to hprof engine: ${error.message}`))
      }
    })
  }

  async function summaryOf(rec) {
    if (rec.summary !== undefined) return rec.summary
    rec.summary = await call(rec, 'summary')
    return rec.summary
  }

  async function diff(baseId, otherId, exec) {
    const base = pickDump(baseId)
    const other = pickDump(otherId)
    if (base.id === other.id) throw new Error('diff needs two different dumps')
    const [baseProfile, otherProfile] = await Promise.all([
      call(base, 'profile', {}, { signal: exec?.signal, timeoutMs: cfg.profileTimeoutMs }),
      call(other, 'profile', {}, { signal: exec?.signal, timeoutMs: cfg.profileTimeoutMs }),
    ])
    return diffProfiles(base, other, baseProfile, otherProfile)
  }

  async function report(dumpId, outPath, exec) {
    const rec = pickDump(dumpId)
    const summary = await summaryOf(rec)
    const retained = await call(rec, 'retained', { page: 0, size: 20 }, { signal: exec?.signal })
    const classes = await call(rec, 'classes', { sort: 'bytes', limit: 20 }, { signal: exec?.signal })
    const markdown = buildReport(rec, summary, retained, classes)
    const target = outPath === undefined || outPath === null || outPath === ''
      ? path.join(baseDir(exec), `hprof-report-${rec.id}-${Date.now()}.md`)
      : resolvePath(outPath, exec)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, markdown, 'utf8')
    return {
      path: target,
      bytes: Buffer.byteLength(markdown),
      preview: markdown.slice(0, 1_500),
    }
  }

  return {
    open,
    close(dumpId) {
      const rec = pickDump(dumpId)
      const id = rec.id
      stop(rec)
      return { closed: id }
    },
    pickDump,
    call,
    summaryOf,
    diff,
    report,
    dispose,
    list: () => [...dumps.values()].filter((rec) => rec.opened !== undefined).map((rec) => rec.opened),
    config: cfg,
  }
}

function describeOpen(rec, summary, retained) {
  const counts = summary.counts ?? {}
  return {
    dump_id: rec.id,
    file: rec.path,
    file_size_bytes: summary.fileSize,
    id_size: summary.idSize,
    parse_ms: summary.parseMs,
    analyze_ms: summary.analyzeMs,
    counts: {
      classes: counts.classes,
      instances: counts.instances,
      object_arrays: counts.objectArrays,
      primitive_arrays: counts.primitiveArrays,
      strings: counts.stringInstances,
      gc_roots: counts.roots,
    },
    graph: summary.analysis,
    heaps: summary.heaps,
    top_classes_by_bytes: (summary.topClasses ?? []).slice(0, 10).map((c) => ({
      id: c.id,
      name: c.name,
      count: c.count,
      bytes: c.bytes,
    })),
    top_retained: (retained.items ?? []).slice(0, 10),
  }
}

export function diffProfiles(base, other, baseProfile, otherProfile) {
  const baseMap = new Map()
  for (const [kind, name, count, bytes] of baseProfile.classes) {
    baseMap.set(`${kind}\u0000${name}`, { kind, name, count, bytes })
  }
  const otherMap = new Map()
  for (const [kind, name, count, bytes] of otherProfile.classes) {
    otherMap.set(`${kind}\u0000${name}`, { kind, name, count, bytes })
  }
  const keys = new Set([...baseMap.keys(), ...otherMap.keys()])
  const rows = []
  for (const key of keys) {
    const before = baseMap.get(key)
    const after = otherMap.get(key)
    const baseBytes = before?.bytes ?? 0
    const otherBytes = after?.bytes ?? 0
    const baseCount = before?.count ?? 0
    const otherCount = after?.count ?? 0
    if (baseBytes === otherBytes && baseCount === otherCount) continue
    rows.push({
      kind: after?.kind ?? before?.kind,
      name: after?.name ?? before?.name,
      base_instances: baseCount,
      other_instances: otherCount,
      delta_instances: otherCount - baseCount,
      base_bytes: baseBytes,
      other_bytes: otherBytes,
      delta_bytes: otherBytes - baseBytes,
    })
  }
  const growth = rows.filter((row) => row.delta_bytes > 0).sort((a, b) => b.delta_bytes - a.delta_bytes).slice(0, 50)
  const shrink = rows.filter((row) => row.delta_bytes < 0).sort((a, b) => a.delta_bytes - b.delta_bytes).slice(0, 20)
  const added = rows.filter((row) => row.base_bytes === 0 && row.other_bytes > 0).sort((a, b) => b.other_bytes - a.other_bytes).slice(0, 20)
  const removed = rows.filter((row) => row.other_bytes === 0 && row.base_bytes > 0).sort((a, b) => b.base_bytes - a.base_bytes).slice(0, 20)
  const countKeys = ['classes', 'instances', 'objectArrays', 'primitiveArrays', 'roots', 'stringInstances']
  const counts = {}
  for (const key of countKeys) {
    const before = baseProfile.counts?.[key] ?? 0
    const after = otherProfile.counts?.[key] ?? 0
    counts[key] = { base: before, other: after, delta: after - before }
  }
  return {
    base: { dump_id: base.id, file: base.path },
    other: { dump_id: other.id, file: other.path },
    counts,
    top_growth: growth,
    top_shrink: shrink,
    new_classes: added,
    removed_classes: removed,
  }
}

function buildReport(rec, summary, retained, classes) {
  const counts = summary.counts ?? {}
  const lines = [
    '# HPROF report',
    '',
    `- File: \`${rec.path}\``,
    `- Size: ${summary.fileSize} bytes`,
    `- Parsed: ${summary.parseMs} ms; analysis: ${summary.analyzeMs} ms`,
    `- Classes: ${counts.classes}; instances: ${counts.instances}; object arrays: ${counts.objectArrays}; primitive arrays: ${counts.primitiveArrays}`,
    `- Strings: ${counts.stringInstances}; GC roots: ${counts.roots}`,
    '',
    '## Top classes by shallow bytes',
    '',
    '| Class | Instances | Bytes |',
    '| --- | ---: | ---: |',
  ]
  for (const c of classes.items ?? []) {
    lines.push(`| \`${c.name}\` | ${c.count} | ${c.bytes} |`)
  }
  lines.push('', '## Top objects by retained size', '', '| Object | Class | Retained | Shallow |', '| --- | --- | ---: | ---: |')
  for (const item of retained.items ?? []) {
    lines.push(`| \`0x${item.id.toString(16)}\` | \`${item.className}\` | ${item.retained} | ${item.shallow} |`)
  }
  lines.push(
    '',
    '## Notes',
    '',
    '- Retained sizes cover the strong-reference dominator tree; weak/soft/phantom `referent` edges are excluded.',
    '- Class paths and per-object paths are available through `hprof_class_paths` and `hprof_path`.',
    '',
  )
  return lines.join('\n')
}

/**
 * Build the same-origin HTTP handler used by the Client panel.
 * The caller owns the connection trust fence.
 * @param runtime - result of createHprofRuntime.
 */
export function createApiHandler(runtime, options = {}) {
  const findings = options.findings ?? createFindingsStore(runtime)
  const uiState = options.uiState ?? createUiState()
  const service = options.service ?? createHprofService(runtime, { findings, uiState })
  return async function handle(req, res) {
    const url = new URL(String(req.url), 'http://localhost')
    const route = url.pathname.startsWith(API_PREFIX)
      ? url.pathname.slice(API_PREFIX.length) || '/'
      : url.pathname
    try {
      if (req.method === 'GET' && route === '/dumps') {
        sendJson(res, 200, { dumps: runtime.list() })
        return
      }
      if (req.method === 'GET' && route === '/findings') {
        sendJson(res, 200, findings.list({
          dump_id: url.searchParams.get('dump_id') ?? undefined,
          kind: url.searchParams.get('kind') ?? undefined,
          target_id: url.searchParams.get('target_id') ?? undefined,
        }))
        return
      }
      if (req.method === 'POST' && route === '/findings') {
        const body = await readJsonBody(req)
        sendJson(res, 200, findings.create(body))
        return
      }
      if (req.method === 'POST' && route === '/findings/update') {
        const body = await readJsonBody(req)
        sendJson(res, 200, findings.update(body))
        return
      }
      if (req.method === 'POST' && route === '/findings/delete') {
        const body = await readJsonBody(req)
        sendJson(res, 200, findings.remove(body))
        return
      }
      if (req.method === 'GET' && route === '/ui/state') {
        sendJson(res, 200, uiState.getState(
          url.searchParams.get('dump_id') ?? undefined,
          url.searchParams.get('client_id') ?? undefined,
        ))
        return
      }
      if (req.method === 'POST' && route === '/ui/state') {
        const body = await readJsonBody(req)
        sendJson(res, 200, uiState.setState(body.dump_id, body.client_id, body.state))
        return
      }
      if (req.method === 'POST' && route === '/ui/command') {
        const body = await readJsonBody(req)
        sendJson(res, 200, uiState.command(body.dump_id, body.action, body.params, body.client_id))
        return
      }
      if (req.method === 'GET' && route === '/ui/commands') {
        sendJson(res, 200, uiState.drain(
          url.searchParams.get('dump_id') ?? undefined,
          url.searchParams.get('client_id') ?? undefined,
        ))
        return
      }
      if (req.method === 'GET' && route === '/ui/events') {
        sendJson(res, 200, uiState.eventLog(
          url.searchParams.get('dump_id') ?? undefined,
          Number(url.searchParams.get('limit')) || 50,
        ))
        return
      }
      if (req.method === 'POST' && route === '/open') {
        const body = await readJsonBody(req)
        const opened = await runtime.open(String(body.path ?? ''))
        sendJson(res, 200, opened)
        return
      }
      if (req.method === 'POST' && route === '/close') {
        const body = await readJsonBody(req)
        sendJson(res, 200, runtime.close(body.dump_id))
        return
      }
      if (req.method === 'POST' && route === '/report') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await service.dispatch('analyze.report', {
          dump_id: body.dump_id,
          out_path: body.out_path,
        }, {}))
        return
      }
      if (req.method === 'GET' && route === '/diff') {
        const base = url.searchParams.get('base') ?? undefined
        const other = url.searchParams.get('other') ?? undefined
        sendJson(res, 200, await runtime.diff(base, other))
        return
      }
      if (req.method === 'GET') {
        const rec = runtime.pickDump(url.searchParams.get('dump_id') ?? undefined)
        const params = paramsFromQuery(url.searchParams)
        if (route === '/summary') return sendJson(res, 200, await runtime.summaryOf(rec))
        if (route === '/classes') return sendJson(res, 200, await runtime.call(rec, 'classes', params))
        if (route === '/instances') return sendJson(res, 200, await runtime.call(rec, 'instances', params))
        if (route === '/object') return sendJson(res, 200, await runtime.call(rec, 'object', params))
        if (route === '/path') return sendJson(res, 200, await runtime.call(rec, 'path', params))
        if (route === '/classpaths') return sendJson(res, 200, await runtime.call(rec, 'classPaths', params))
        if (route === '/retained') return sendJson(res, 200, await runtime.call(rec, 'retained', params))
        if (route === '/domtree') return sendJson(res, 200, await runtime.call(rec, 'domTree', params))
        if (route === '/strings') return sendJson(res, 200, await runtime.call(rec, 'strings', params))
        if (route === '/roots') return sendJson(res, 200, await runtime.call(rec, 'roots', params))
        if (route === '/referrers') return sendJson(res, 200, await runtime.call(rec, 'referrers', params))
      }
      sendJson(res, 404, { error: `unknown hprof route: ${req.method} ${route}` })
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function paramsFromQuery(searchParams) {
  const params = {}
  for (const [key, value] of searchParams) {
    if (key === 'dump_id') continue
    if (value === '') continue
    if (key === 'id' || key === 'class_id' || key === 'page' || key === 'size' || key === 'limit'
      || key === 'parent' || key === 'offset' || key === 'min_bytes' || key === 'min_retained'
      || key === 'min_length') {
      params[key] = Number(value)
    } else if (key === 'weak' || key === 'readable') {
      params[key] = value === '1' || value === 'true'
    } else {
      params[key] = value
    }
  }
  return params
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function readJsonBody(req, limit = 65_536) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

export function createToolDefinitions(runtime, options = {}) {
  const service = options.service ?? createHprofService(runtime, options)
  return [
    definition({
      name: 'hprof_api',
      description:
        'Generic HPROF service call. The service exposes dumps, entities, edges, queries, paths and analysis '
        + 'through one operation surface; call op="capabilities" first for the manifest and examples. '
        + 'Params are an object matching the operation (dump_id, ids, cursor/page, fields).',
      required: ['op'],
      properties: {
        op: {
          type: 'string',
          description: 'Operation, e.g. capabilities, entity.get, entity.array, query.instances, analyze.classStats.',
        },
        params: {
          type: 'object',
          description: 'Operation parameters; see op="capabilities" for exact fields.',
          additionalProperties: true,
        },
      },
      async execute(args, exec) {
        const op = asString(args?.op, 'op')
        const params = args?.params !== null && typeof args?.params === 'object' ? args.params : {}
        return service.dispatch(op, params, exec)
      },
    }),
    definition({
      name: 'hprof_ptc',
      description:
        'Run one JavaScript program against the typed hprof namespace and return its JSON result. '
        + 'The program sees hprof.call(op, params), hprof.<group>.<method>(params) for every service '
        + 'operation, and console.log. Example: '
        + 'const c=await hprof.query.classes({query:"SurfaceControl"}); '
        + 'const s=await hprof.analyze.classStats({class_id:c.items[0].id}); return {total:s.totalObjects}. '
        + 'This is the plugin-local plan-B runner: no fs, process, require, or shell; timeout enforced.',
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'JavaScript program body; return a JSON value.' },
        timeout_ms: { type: 'number', description: 'Program timeout in milliseconds (default 20000, max 60000).' },
      },
      async execute(args, exec) {
        return runHprofPtc(service, { code: args?.code, timeoutMs: args?.timeout_ms }, exec)
      },
    }),
    definition({
      name: 'hprof_annotate',
      description:
        'Create, list, update or delete a finding attached to a heap object, class, path, field or dump. '
        + 'Findings persist by dump file identity (not dump-N) under the app data directory. '
        + 'target={kind:"object"|"class",id} or {kind:"path",ids:[...]} or {kind:"field",id,field} or {kind:"dump"}.',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete'] },
        dump_id: DUMP_ID,
        id: { type: 'string', description: 'Finding id for update/delete.' },
        target: { type: 'object', description: 'Finding target; see the tool description.' },
        title: { type: 'string', description: 'Short finding title.' },
        note: { type: 'string', description: 'Longer Markdown note.' },
        severity: { type: 'string', enum: ['info', 'warn', 'error'] },
        tags: { type: 'array', items: { type: 'string' } },
        kind: { type: 'string', description: 'List filter: target kind.' },
        target_id: { type: 'number', description: 'List filter: target object/class id.' },
      },
      async execute(args, exec) {
        const action = asString(args?.action, 'action')
        const params = { ...args }
        delete params.action
        return service.dispatch(`findings.${action}`, params, exec)
      },
    }),
    definition({
      name: 'hprof_open',
      description:
        'Open an Android/ART HPROF heap dump (from `am dumpheap`) and return a dump_id with counts, '
        + 'top classes by bytes, and top objects by retained size. Call this before any other hprof_* tool. '
        + 'Parsing and dominator analysis run in a separate Node process and can take several seconds and '
        + 'about 1 GB for a 129 MB dump. Pass an absolute path or one relative to the workspace. The dump '
        + 'stays open until hprof_close, the idle timeout, or eviction by a newer dump.',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to an extracted .hprof file (not a .zip).' },
      },
      async execute(args, exec) {
        return runtime.open(asString(args?.path, 'path'), exec)
      },
    }),
    definition({
      name: 'hprof_close',
      description: 'Stop the engine process for one dump and release its memory. Use it when finished with a large dump.',
      properties: { dump_id: DUMP_ID },
      async execute(args) {
        return runtime.close(args?.dump_id)
      },
    }),
    definition({
      name: 'hprof_classes',
      description:
        'List classes in the open dump, sorted by total shallow bytes, instance count, or name. '
        + 'Use it to find which classes dominate the heap. Each row carries the class id and kind needed by '
        + 'hprof_instances and hprof_class_paths.',
      properties: {
        dump_id: DUMP_ID,
        query: { type: 'string', description: 'Case-insensitive substring of the class name.' },
        sort: { type: 'string', enum: ['bytes', 'count', 'name'], description: 'Defaults to bytes.' },
        limit: { type: 'number', description: 'Maximum rows to return (default 25, max 200).' },
      },
      async execute(args, exec) {
        const rec = runtime.pickDump(args?.dump_id)
        return runtime.call(rec, 'classes', {
          query: asOptionalString(args?.query),
          sort: asOptionalString(args?.sort),
          limit: clamp(args?.limit, 25, 1, 200),
        }, { signal: exec?.signal })
      },
    }),
    definition({
      name: 'hprof_instances',
      description:
        'List instances of one class (class_id and kind from hprof_classes). Supports an object-id prefix filter '
        + 'and a minimum shallow size, and returns a page plus the total count.',
      required: ['class_id'],
      properties: {
        dump_id: DUMP_ID,
        class_id: { type: 'number', description: 'Class id from hprof_classes.' },
        kind: {
          type: 'string',
          enum: ['class', 'primitive'],
          description: 'The kind field from hprof_classes. Use primitive for byte[], char[], int[] and other arrays.',
        },
        id_prefix: { type: 'string', description: 'Optional object-id prefix, decimal or 0x hex.' },
        min_bytes: { type: 'number', description: 'Minimum shallow size in bytes.' },
        page: { type: 'number', description: 'Zero-based page (default 0).' },
        size: { type: 'number', description: 'Page size (default 20, max 200).' },
      },
      async execute(args, exec) {
        const rec = runtime.pickDump(args?.dump_id)
        return runtime.call(rec, 'instances', {
          class_id: asId(args?.class_id, 'class_id'),
          kind: args?.kind === 'primitive' ? 'primitive' : 'class',
          id_prefix: asOptionalString(args?.id_prefix),
          min_bytes: args?.min_bytes,
          page: clamp(args?.page, 0, 0, 1_000_000),
          size: clamp(args?.size, 20, 1, Math.min(runtime.config.maxPageSize, 200)),
        }, { signal: exec?.signal })
      },
    }),
    definition({
      name: 'hprof_object',
      description:
        'Show one object or class: kind, class name, heap, shallow size, retained size, dominator, fields '
        + 'with values, array elements, or full String content. Object ids inside field values can be passed '
        + 'to hprof_object, hprof_path, and hprof_classes.',
      required: ['id'],
      properties: {
        dump_id: DUMP_ID,
        id: { type: 'number', description: 'Object or class id in decimal (from any hprof_* list).' },
      },
      async execute(args, exec) {
        const rec = runtime.pickDump(args?.dump_id)
        const detail = await runtime.call(rec, 'object', { id: asId(args?.id, 'id') }, { signal: exec?.signal })
        return trimObjectDetail(detail)
      },
    }),
    definition({
      name: 'hprof_path',
      description:
        'Shortest GC-root path for one object: the reference chain from a root to the object, with the '
        + 'field or array index used at each step. Weak references are excluded unless weak is true.',
      required: ['id'],
      properties: {
        dump_id: DUMP_ID,
        id: { type: 'number', description: 'Object id.' },
        weak: { type: 'boolean', description: 'Include Weak/Soft/Phantom reference edges. Default false.' },
      },
      async execute(args, exec) {
        const rec = runtime.pickDump(args?.dump_id)
        return runtime.call(rec, 'path', { id: asId(args?.id, 'id'), weak: args?.weak === true }, { signal: exec?.signal })
      },
    }),
    definition({
      name: 'hprof_class_paths',
      description:
        'Group the GC-root paths of every object of one class (MAT "Path to GC Roots"), with object counts '
        + 'and shallow totals per distinct chain. Returns one page of compact chain strings; each group carries '
        + 'up to five sample object ids and their holder ids. Use hprof_object(holder_id) to inspect holder state.',
      required: ['class_id'],
      properties: {
        dump_id: DUMP_ID,
        class_id: { type: 'number', description: 'Class id from hprof_classes.' },
        kind: {
          type: 'string',
          enum: ['class', 'primitive'],
          description: 'The kind field from hprof_classes; use primitive for array types.',
        },
        weak: { type: 'boolean', description: 'Include weak reference edges. Default false.' },
        page: { type: 'number', description: 'Zero-based group page (default 0).' },
        size: { type: 'number', description: 'Groups per page, 1-10 (default 10); 10 compact chains fit one tool result.' },
      },
      async execute(args, exec) {
        const rec = runtime.pickDump(args?.dump_id)
        const page = Math.max(0, Math.floor(Number(args?.page) || 0))
        const size = Math.min(10, Math.max(1, Math.floor(Number(args?.size) || 10)))
        const result = await runtime.call(rec, 'classPaths', {
          class_id: asId(args?.class_id, 'class_id'),
          kind: args?.kind === 'primitive' ? 'primitive' : 'class',
          weak: args?.weak === true,
          include_holders: true,
        }, { signal: exec?.signal })
        return trimClassPaths(result, page, size)
      },
    }),
    definition({
      name: 'hprof_class_stats',
      description:
        'Aggregate one class without fetching every instance: total/reachable/unreachable counts, '
        + 'native-handle state (mNativeObject when present), creation sites (mCallsite), hidden/zero-size '
        + 'counts, and grouped GC-root and holder categories. Use hprof_class_paths for the complete per-group chains.',
      required: ['class_id'],
      properties: {
        dump_id: DUMP_ID,
        class_id: { type: 'number', description: 'Class id from hprof_classes.' },
        kind: {
          type: 'string',
          enum: ['class', 'primitive'],
          description: 'The kind field from hprof_classes; use primitive for array types.',
        },
      },
      async execute(args, exec) {
        const rec = runtime.pickDump(args?.dump_id)
        const result = await runtime.call(rec, 'classStats', {
          class_id: asId(args?.class_id, 'class_id'),
          kind: args?.kind === 'primitive' ? 'primitive' : 'class',
        }, { signal: exec?.signal })
        return trimClassStats(result)
      },
    }),
    definition({
      name: 'hprof_retained',
      description:
        'Rank reachable objects by retained size (the memory freed if the object became unreachable), with '
        + 'optional class-name and minimum-retained filters. This is the fastest way to find what holds the heap.',
      properties: {
        dump_id: DUMP_ID,
        class_filter: { type: 'string', description: 'Case-insensitive substring of the class name.' },
        min_retained: { type: 'number', description: 'Minimum retained size in bytes.' },
        page: { type: 'number', description: 'Zero-based page (default 0).' },
        size: { type: 'number', description: 'Page size (default 20, max 100).' },
      },
      async execute(args, exec) {
        const rec = runtime.pickDump(args?.dump_id)
        return runtime.call(rec, 'retained', {
          query: asOptionalString(args?.class_filter),
          min_retained: args?.min_retained,
          page: clamp(args?.page, 0, 0, 1_000_000),
          size: clamp(args?.size, 20, 1, 100),
        }, { signal: exec?.signal })
      },
    }),
    definition({
      name: 'hprof_strings',
      description:
        'Search String values in the open dump. Readable text is shown by default; turn readable off to include '
        + 'binary/ICU content. Filter by substring and minimum length. Returns a page plus the total count.',
      properties: {
        dump_id: DUMP_ID,
        query: { type: 'string', description: 'Case-insensitive substring of the String value.' },
        min_length: { type: 'number', description: 'Minimum character length.' },
        readable: { type: 'boolean', description: 'Only readable text when true (default true).' },
        page: { type: 'number', description: 'Zero-based page (default 0).' },
        size: { type: 'number', description: 'Page size (default 50, max 200).' },
      },
      async execute(args, exec) {
        const rec = runtime.pickDump(args?.dump_id)
        return runtime.call(rec, 'strings', {
          query: asOptionalString(args?.query),
          min_length: args?.min_length,
          readable: args?.readable !== false,
          page: clamp(args?.page, 0, 0, 1_000_000),
          size: clamp(args?.size, 50, 1, 200),
        }, { signal: exec?.signal })
      },
    }),
    definition({
      name: 'hprof_roots',
      description:
        'List GC roots in the open dump, with root type, class name, and logical heap. Filter by type or class '
        + 'substring. Returns a page plus the total count.',
      properties: {
        dump_id: DUMP_ID,
        type: { type: 'string', description: 'Root type substring, for example JNI_GLOBAL or THREAD.' },
        query: { type: 'string', description: 'Case-insensitive substring of the class name.' },
        page: { type: 'number', description: 'Zero-based page (default 0).' },
        size: { type: 'number', description: 'Page size (default 50, max 200).' },
      },
      async execute(args, exec) {
        const rec = runtime.pickDump(args?.dump_id)
        return runtime.call(rec, 'roots', {
          type: asOptionalString(args?.type),
          query: asOptionalString(args?.query),
          page: clamp(args?.page, 0, 0, 1_000_000),
          size: clamp(args?.size, 50, 1, 200),
        }, { signal: exec?.signal })
      },
    }),
    definition({
      name: 'hprof_referrers',
      description:
        'Find objects and static fields that reference one object ("who references me"). This scans the whole '
        + 'heap and stops at 200 matches or 3 seconds; the result reports truncation.',
      required: ['id'],
      properties: {
        dump_id: DUMP_ID,
        id: { type: 'number', description: 'Target object id.' },
      },
      async execute(args, exec) {
        const rec = runtime.pickDump(args?.dump_id)
        return runtime.call(rec, 'referrers', { id: asId(args?.id, 'id') }, { signal: exec?.signal })
      },
    }),
    definition({
      name: 'hprof_diff',
      description:
        'Compare two heap dumps by class: counts and bytes added or removed per class, plus new and removed '
        + 'classes. Opens both dumps if they are not already open (each engine keeps its own heap; two 129 MB '
        + 'dumps need roughly 2 GB). Use it for leak comparisons between two snapshots.',
      required: ['base', 'other'],
      properties: {
        base: { type: 'string', description: 'Baseline dump path.' },
        other: { type: 'string', description: 'Comparison dump path.' },
      },
      async execute(args, exec) {
        const [base, other] = await Promise.all([
          runtime.open(asString(args?.base, 'base'), exec),
          runtime.open(asString(args?.other, 'other'), exec),
        ])
        return runtime.diff(base.dump_id, other.dump_id, exec)
      },
    }),
    definition({
      name: 'hprof_report',
      description:
        'Write a Markdown report for one dump (counts, top classes, top retained objects, plus all current findings) '
        + 'to a file and return its path. Pass out_path to choose the location (relative to the workspace) or omit it '
        + 'for a generated name. Use present to hand the file to the user.',
      properties: {
        dump_id: DUMP_ID,
        out_path: { type: 'string', description: 'Optional output path, relative to the workspace.' },
      },
      async execute(args, exec) {
        return service.dispatch('analyze.report', {
          dump_id: args?.dump_id,
          out_path: asOptionalString(args?.out_path),
        }, exec)
      },
    }),
  ]
}

function safeRealpath(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

function raceTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function tail(text) {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return '(no stderr)'
  return trimmed.length > 2_000 ? `…${trimmed.slice(-2_000)}` : trimmed
}

function lineReader(stream, onLine) {
  let buffer = ''
  stream.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      onLine(line)
    }
  })
}

function clamp(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.floor(number), min), max)
}

function asId(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim()
    const parsed = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  throw new Error(`${field} must be a non-negative object id (decimal or 0x hex)`)
}

function asString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value
}

function asOptionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function renderJson(value, maxChars = 7_000) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch (error) {
    text = `result is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n… (truncated at ${maxChars} characters; narrow the query or use pagination)`
  }
  return [{ type: 'text', text }]
}

const DUMP_ID = {
  type: 'string',
  description: 'Dump handle returned by hprof_open. Omit to use the most recently opened dump.',
}

function definition(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties: spec.properties ?? {},
      ...(spec.required === undefined ? {} : { required: spec.required }),
      additionalProperties: false,
    },
    output: {
      schema: {},
      render(_args, value) {
        return renderJson(value)
      },
    },
    execute: spec.execute,
  }
}

function trimObjectDetail(detail) {
  const out = { ...detail }
  if (Array.isArray(out.fields) && out.fields.length > 200) {
    out.fields = out.fields.slice(0, 200)
    out.fields_truncated = true
  }
  if (Array.isArray(out.elements) && out.elements.length > 200) {
    out.elements = out.elements.slice(0, 200)
    out.elements_truncated = true
  }
  if (Array.isArray(out.values) && out.values.length > 200) {
    out.values = out.values.slice(0, 200)
    out.values_truncated = true
  }
  if (typeof out.string === 'string' && out.string.length > 2_000) {
    out.string = `${out.string.slice(0, 2_000)}…`
    out.string_truncated = true
  }
  if (out.class !== undefined && Array.isArray(out.class.statics) && out.class.statics.length > 200) {
    out.class = { ...out.class, statics: out.class.statics.slice(0, 200), statics_truncated: true }
  }
  return out
}

function trimClassPaths(result, page = 0, size = 10) {
  const all = Array.isArray(result.groups) ? result.groups : []
  const start = page * size
  const groups = all.slice(start, start + size).map((group) => {
    const steps = Array.isArray(group.steps) ? group.steps : []
    const chain = steps
      .map((step, index) => (index === 0 ? '<root>' : `${step.className}${step.via ? ` <- ${step.via}` : ''}`))
      .join(' | ')
    return {
      count: group.count,
      shallow: group.shallow,
      chain,
      samples: Array.isArray(group.samples) ? group.samples.slice(0, 5) : [],
    }
  })
  return {
    ...result,
    groups,
    groupCount: result.groupCount ?? all.length,
    availableGroups: all.length,
    page,
    size,
    returned: groups.length,
    hasMore: start + groups.length < all.length,
  }
}

function trimClassStats(result) {
  const out = { ...result }
  const maxCallsites = 10
  const maxHolders = 10
  if (Array.isArray(out.callsites)) {
    out.callsites_truncated = out.callsites.length > maxCallsites
    out.callsites = out.callsites.slice(0, maxCallsites)
  }
  if (Array.isArray(out.holders)) {
    out.holders_truncated = out.holders.length > maxHolders
    out.holders = out.holders.slice(0, maxHolders)
  }
  return out
}
