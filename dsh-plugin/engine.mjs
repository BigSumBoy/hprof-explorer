/**
 * HPROF engine child process for the DSH adapter (B-plan).
 *
 * Loads the parser from `HPROF_APP_DIR/src/hprof.mjs`, parses and analyzes one
 * dump, then serves line-delimited JSON requests on stdin/stdout. Keeping the
 * heap in this process isolates its ~1 GB from the Harness Host.
 *
 * Protocol:
 *   in : { id, method, params }
 *   out: { id, ok: true, result } | { id, ok: false, error }
 *   out: { event: 'ready', fileSize, counts, parseMs, analyzeMs }
 *   out: { event: 'fatal', error }
 */
import { createInterface } from 'node:readline'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const file = process.argv[2]
const appDir = process.env.HPROF_APP_DIR

if (typeof file !== 'string' || file === '') {
  send({ event: 'fatal', error: 'missing hprof file argument' })
  process.exit(1)
}
if (typeof appDir !== 'string' || appDir === '') {
  send({ event: 'fatal', error: 'missing HPROF_APP_DIR' })
  process.exit(1)
}

let idx
try {
  const module = await import(pathToFileURL(path.join(appDir, 'src', 'hprof.mjs')).href)
  idx = module.loadHprof(file)
  idx.analyze()
} catch (error) {
  send({ event: 'fatal', error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
}

let summaryCache = null
function summary() {
  if (summaryCache === null) summaryCache = idx.summary()
  return summaryCache
}

const methods = {
  summary() {
    const full = summary()
    const { classes, ...rest } = full
    return { ...rest, classCount: classes.length, analysis: idx.graphStats, analyzeMs: idx.analyzeMs }
  },

  classes(params = {}) {
    const query = String(params.query ?? '').trim().toLowerCase()
    const sort = params.sort === 'count' || params.sort === 'name' ? params.sort : 'bytes'
    const minCount = Number(params.min_count) || 0
    const minBytes = Number(params.min_bytes) || 0
    const limit = clamp(params.limit, 25, 1, 1_000)
    const offset = clamp(params.offset, 0, 0, 1_000_000)
    let list = summary().classes
    if (query !== '') list = list.filter((c) => c.name.toLowerCase().includes(query))
    const kind = params.kind === 'class' || params.kind === 'primitive' ? params.kind : ''
    if (kind !== '') list = list.filter((c) => c.kind === kind)
    if (minCount > 0) list = list.filter((c) => c.count >= minCount)
    if (minBytes > 0) list = list.filter((c) => c.bytes >= minBytes)
    const groupBy = params.group_by === 'package' || params.group_by === 'classloader' || params.group_by === 'superclass'
      ? params.group_by
      : ''
    if (groupBy !== '') {
      const grouped = new Map()
      for (const c of list) {
        let name
        if (groupBy === 'package') {
          const dot = c.name.lastIndexOf('.')
          name = c.kind === 'primitive' ? '<primitive>'
            : c.name.endsWith('[]') ? '<array>'
              : dot <= 0 ? '<default>' : c.name.slice(0, dot)
        } else if (groupBy === 'superclass') {
          const info = c.kind === 'class' ? idx.classes.get(c.id) : undefined
          name = info?.superId ? (idx.classes.get(info.superId)?.name ?? `class ${info.superId}`) : '<none>'
        } else {
          const info = c.kind === 'class' ? idx.classes.get(c.id) : undefined
          const loader = info?.loaderId ? idx.objectClassName(info.loaderId) : null
          name = loader === null ? '<bootstrap>' : loader
        }
        const row = grouped.get(name) ?? { name, kind: 'group', classes: 0, count: 0, bytes: 0 }
        row.classes++
        row.count += c.count
        row.bytes += c.bytes
        grouped.set(name, row)
      }
      let rows = [...grouped.values()]
      if (sort === 'count') rows.sort((a, b) => b.count - a.count)
      else if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name))
      else rows.sort((a, b) => b.bytes - a.bytes)
      return { total: rows.length, offset, shown: Math.min(limit, Math.max(0, rows.length - offset)), items: rows.slice(offset, offset + limit), groupBy }
    }
    list = list.slice()
    if (sort === 'count') list.sort((a, b) => b.count - a.count)
    else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name))
    else list.sort((a, b) => b.bytes - a.bytes)
    return { total: list.length, offset, shown: Math.min(limit, Math.max(0, list.length - offset)), items: list.slice(offset, offset + limit) }
  },

  instances(params = {}) {
    const kind = params.kind === 'primitive' ? 'primitive' : 'class'
    const id = Number(params.class_id)
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('class_id must be a non-negative integer')
    const page = clamp(params.page, 0, 0, 1_000_000)
    const size = clamp(params.size, 20, 1, 500)
    const result = idx.instances(kind, id, page, size, {
      id: String(params.id_prefix ?? ''),
      className: String(params.query ?? ''),
      heap: String(params.heap ?? ''),
      minSize: params.min_bytes === undefined ? '' : String(params.min_bytes),
    })
    const requested = params.fields === '*'
      ? ['*']
      : Array.isArray(params.fields)
        ? params.fields.map((name) => String(name))
        : (typeof params.fields === 'string' ? params.fields.split(',').map((name) => name.trim()).filter(Boolean) : [])
    if (requested.length > 0) {
      for (const item of result.items) {
        const fields = idx.instanceFields(item.id)
        const byName = new Map(fields.map((field) => [field.name, field]))
        const projected = {}
        const names = requested.includes('*') ? fields.map((field) => field.name) : requested
        for (const name of names) {
          const field = byName.get(name)
          projected[name] = field === undefined ? null : projectField(field)
        }
        item.fields = projected
      }
    }
    return result
  },

  object(params = {}) {
    const id = Number(params.id)
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('id must be a non-negative integer')
    return { ...idx.objectDetail(id), retained: idx.retainedInfo(id) }
  },

  arrayElements(params = {}) {
    const id = Number(params.id)
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('id must be a non-negative integer')
    const info = idx.arrayInfo(id)
    if (info === null) throw new Error('not an array or string')
    if (info.kind === 'string') return { kind: 'string', length: info.length, text: info.text }
    const page = clamp(params.page, 0, 0, 1_000_000)
    const size = clamp(params.size, 100, 1, 500)
    const start = page * size
    const end = Math.min(info.length, start + size)
    const items = []
    if (info.kind === 'object') {
      for (let index = start; index < end; index++) {
        const objectId = info.elements(index)
        items.push(objectId === 0 ? null : { id: objectId, className: idx.objectClassName(objectId) })
      }
    } else {
      for (let index = start; index < end; index++) {
        const value = info.read(index)
        items.push(typeof value === 'bigint' ? String(value) : value)
      }
    }
    return {
      kind: info.kind,
      typeName: info.typeName ?? null,
      length: info.length,
      page,
      size,
      items,
      hasMore: end < info.length,
    }
  },

  path(params = {}) {
    const id = Number(params.id)
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('id must be a non-negative integer')
    return idx.pathToRoot(id, params.weak === true)
  },

  classPaths(params = {}) {
    const kind = params.kind === 'primitive' ? 'primitive' : 'class'
    const id = Number(params.class_id)
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('class_id must be a non-negative integer')
    const page = clamp(params.page, 0, 0, 100_000)
    const size = clamp(params.size, 100, 1, 100)
    const result = idx.classPaths(kind, id, 20_000, size, params.weak === true, page * size)
    if (result === null) throw new Error('analysis not ready')
    result.page = page
    result.size = size
    result.hasMore = result.groupOffset + result.groups.length < result.groupCount
    // Holder ids let the caller follow up with object() without re-walking paths.
    if (params.include_holders === true) {
      for (const group of result.groups) {
        for (const sample of group.samples) {
          const path = idx.pathToRoot(sample.id, params.weak === true)
          sample.holderId = path.found ? (path.path[path.path.length - 2]?.id ?? null) : null
        }
      }
    }
    return result
  },

  classStats(params = {}) {
    const kind = params.kind === 'primitive' ? 'primitive' : 'class'
    const id = Number(params.class_id)
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('class_id must be a non-negative integer')
    const paths = idx.classPaths(kind, id, 20_000, 20_000, false)
    if (paths === null) throw new Error('analysis not ready')
    const ids = idx.members.get(kind === 'primitive' ? `p:${id}` : `c:${id}`) ?? []
    const callsites = new Map()
    const roots = new Map()
    const holders = new Map()
    const native = { field: false, retained: 0, released: 0, unknown: 0 }
    let reachable = 0
    let unreachable = 0
    let hidden = 0
    let zeroSize = 0

    for (const objectId of ids) {
      const fields = idx.instanceFields(objectId)
      const byName = new Map(fields.map((field) => [field.name, field]))
      const node = idx.nodeIndex.get(objectId)
      const distance = node === undefined ? -1 : (idx.bfsDist[node] ?? -1)
      const isReachable = distance >= 0
      if (isReachable) reachable++
      else unreachable++

      const nativeField = byName.get('mNativeObject')
      let retained = false
      let released = false
      if (nativeField === undefined) {
        native.unknown++
      } else {
        native.field = true
        if (String(nativeField.value) === '0') {
          native.released++
          released = true
        } else {
          native.retained++
          retained = true
        }
      }

      const isHidden = byName.get('mHiddenRequested')?.value === true
      if (isHidden) hidden++
      const width = byName.get('mWidth')
      const height = byName.get('mHeight')
      if ((width !== undefined || height !== undefined)
        && Number(width?.value ?? 0) === 0
        && Number(height?.value ?? 0) === 0) {
        zeroSize++
      }

      const callsiteField = byName.get('mCallsite')
      const callsite = callsiteField?.value == null
        ? '?'
        : (idx.readString(callsiteField.value) ?? '?')
      const row = callsites.get(callsite)
        ?? { callsite, count: 0, reachable: 0, native: 0, released: 0, hidden: 0 }
      row.count++
      if (isReachable) row.reachable++
      if (retained) row.native++
      if (released) row.released++
      if (isHidden) row.hidden++
      callsites.set(callsite, row)
    }

    for (const group of paths.groups) {
      const steps = group.steps
      const root = steps[1]
      if (root !== undefined) {
        const row = roots.get(root.className) ?? { className: root.className, count: 0 }
        row.count += group.count
        roots.set(root.className, row)
      }
      const holder = steps[steps.length - 2]
      if (holder !== undefined) {
        const key = `${holder.className}\u0000${holder.via ?? ''}`
        const row = holders.get(key)
          ?? { className: holder.className, via: holder.via ?? null, count: 0 }
        row.count += group.count
        holders.set(key, row)
      }
    }

    return {
      className: paths.className,
      kind,
      totalObjects: ids.length,
      reachable,
      unreachable,
      groupCount: paths.groupCount,
      native,
      hidden,
      zeroSize,
      callsites: [...callsites.values()].sort((a, b) => b.count - a.count),
      roots: [...roots.values()].sort((a, b) => b.count - a.count),
      holders: [...holders.values()].sort((a, b) => b.count - a.count),
      topPath: paths.groups[0] === undefined ? null : {
        count: paths.groups[0].count,
        steps: paths.groups[0].steps,
        samples: paths.groups[0].samples,
      },
    }
  },

  leakSuspects(params = {}) {
    const limit = clamp(params.limit, 5, 1, 20)
    const rows = summary().classes
    const chosen = new Map()
    const nativeIds = new Set()
    const add = (row) => {
      if (row === undefined || row === null || row.kind !== 'class' || row.count === 0) return
      if (row.name === 'java.lang.String' || row.name.endsWith('[]')) return
      if (!chosen.has(row.id)) chosen.set(row.id, row)
    }
    if (params.class_id !== undefined) {
      const id = Number(params.class_id)
      const row = rows.find((item) => item.kind === 'class' && item.id === id)
      if (row === undefined) throw new Error('class not found')
      add(row)
    } else {
      for (const row of rows.filter((item) => item.kind === 'class').slice(0, 12)) add(row)
      for (const row of rows.filter((item) => item.kind === 'class').sort((a, b) => b.count - a.count).slice(0, 12)) add(row)
      for (const info of idx.classes.values()) {
        const count = idx.classAgg.get(`c:${info.id}`)?.count ?? 0
        if (count === 0) continue
        if (!(info.fields ?? []).some((field) => field.name === 'mNativeObject')) continue
        nativeIds.add(info.id)
        add({ kind: 'class', id: info.id, name: info.name, count, bytes: idx.classAgg.get(`c:${info.id}`)?.bytes ?? 0 })
      }
      for (const name of ['android.view.SurfaceControl', 'android.view.ViewRootImpl', 'java.lang.ref.FinalizerReference', 'sun.misc.Cleaner']) {
        const row = rows.find((item) => item.kind === 'class' && item.name === name)
        if (row !== undefined) add(row)
      }
    }
    const candidates = [...chosen.values()]
      .sort((a, b) => (nativeIds.has(b.id) ? 1 : 0) - (nativeIds.has(a.id) ? 1 : 0) || b.count - a.count)
      .slice(0, params.class_id !== undefined ? 1 : Math.min(12, Math.max(6, limit * 2)))
    const suspects = []
    for (const candidate of candidates) {
      let stats
      try {
        stats = methods.classStats({ class_id: candidate.id, kind: 'class' })
      } catch {
        continue
      }
      const top = stats.topPath
      const first = top?.steps?.[1]
      const last = top?.steps?.[top.steps.length - 2]
      const chain = top === null || top === undefined ? null : top.steps
        .map((step, index) => (index === 0 ? '<root>' : `${step.className} <- ${step.via ?? '?'}`))
        .join(' | ')
      const reasons = []
      if (top !== null && top !== undefined && top.count >= 10) reasons.push(`top path holds ${top.count} objects`)
      if (stats.native?.retained > 0) reasons.push(`${stats.native.retained} native handles retained`)
      if (stats.native?.released > stats.native?.retained) reasons.push(`${stats.native.released} released wrappers`)
      if (stats.hidden > 0) reasons.push(`${stats.hidden} hidden objects`)
      const score = (top?.count ?? 0) * 100 + (stats.native?.retained ?? 0) * 20 + Math.min(stats.reachable, 5000)
      suspects.push({
        classId: candidate.id,
        className: candidate.name,
        score,
        totalObjects: stats.totalObjects,
        reachable: stats.reachable,
        unreachable: stats.unreachable,
        native: stats.native,
        hidden: stats.hidden,
        callsites: stats.callsites.slice(0, 5),
        topPath: top === null || top === undefined ? null : {
          count: top.count,
          root: first?.className ?? null,
          holder: last?.className ?? null,
          chain,
          samples: top.samples?.slice(0, 3) ?? [],
        },
        reasons,
      })
    }
    suspects.sort((a, b) => b.score - a.score)
    return {
      suspects: suspects.slice(0, limit),
      candidatesAnalyzed: candidates.length,
      note: 'Heuristic suspects rank native/finalizer holders and the largest aggregated GC-root container per class.',
    }
  },

  retainedSet(params = {}) {
    const ids = Array.isArray(params.ids) ? params.ids.map(Number).filter((id) => Number.isSafeInteger(id) && id >= 0) : []
    if (ids.length === 0) throw new Error('ids must be a non-empty array of object ids')
    const limit = clamp(params.limit, 20000, 1, 100000)
    return idx.retainedSet(ids, limit)
  },

  retainedClasses(params = {}) {
    return idx.retainedClasses(clamp(params.limit, 30, 1, 200))
  },

  retained(params = {}) {
    const page = clamp(params.page, 0, 0, 1_000_000)
    const size = clamp(params.size, 20, 1, 200)
    return idx.retainedPage(page, size, {
      id: String(params.id_prefix ?? ''),
      className: String(params.query ?? ''),
      minRetained: params.min_retained === undefined ? '' : String(params.min_retained),
    })
  },

  domTree(params = {}) {
    const parent = Number(params.parent ?? 0)
    const offset = clamp(params.offset, 0, 0, 1_000_000)
    const limit = clamp(params.limit, 100, 1, 500)
    const tree = idx.domTree(parent, offset, limit)
    if (tree === null) throw new Error('unknown dominator node')
    return tree
  },

  strings(params = {}) {
    const page = clamp(params.page, 0, 0, 1_000_000)
    const size = clamp(params.size, 50, 1, 200)
    return idx.stringsPage(page, size, {
      q: String(params.query ?? ''),
      readable: params.readable === true,
      id: String(params.id_prefix ?? ''),
      minLength: params.min_length === undefined ? '' : String(params.min_length),
    })
  },

  roots(params = {}) {
    const page = clamp(params.page, 0, 0, 1_000_000)
    const size = clamp(params.size, 50, 1, 200)
    return idx.rootsPage(page, size, {
      id: String(params.id_prefix ?? ''),
      className: String(params.query ?? ''),
      type: String(params.type ?? ''),
      heap: String(params.heap ?? ''),
    })
  },

  referrers(params = {}) {
    const id = Number(params.id)
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('id must be a non-negative integer')
    const page = clamp(params.page, 0, 0, 1_000_000)
    const size = clamp(params.size, 100, 1, 500)
    return idx.referrers(id, size, 5_000, {
      offset: page * size,
      type: params.type,
      field: params.field,
    })
  },

  /**
   * Compact class profile for cross-dump comparison. Aggregates by
   * kind + name so two dumps with different class ids still compare.
   */
  profile() {
    const full = summary()
    const aggregated = new Map()
    for (const c of full.classes) {
      const key = `${c.kind}\u0000${c.name}`
      let entry = aggregated.get(key)
      if (entry === undefined) {
        entry = [c.kind, c.name, 0, 0]
        aggregated.set(key, entry)
      }
      entry[2] += c.count
      entry[3] += c.bytes
    }
    return {
      file: full.file,
      fileSize: full.fileSize,
      parseMs: full.parseMs,
      analyzeMs: idx.analyzeMs,
      counts: full.counts,
      classes: [...aggregated.values()],
    }
  },
}

send({
  event: 'ready',
  fileSize: idx.fileSize,
  counts: idx.counts,
  parseMs: idx.parseMs,
  analyzeMs: idx.analyzeMs,
})

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  void handle(line)
})

async function handle(line) {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const id = request?.id
  const method = request?.method
  const handler = methods[method]
  if (typeof handler !== 'function') {
    await send({ id, ok: false, error: `unknown method: ${String(method)}` })
    return
  }
  try {
    const result = handler(request.params ?? {})
    await send({ id, ok: true, result })
  } catch (error) {
    await send({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function send(message) {
  const line = `${JSON.stringify(message)}\n`
  if (process.stdout.write(line)) return Promise.resolve()
  return new Promise((resolve) => process.stdout.once('drain', resolve))
}

function projectField(field) {
  if (field.type === 'object') {
    if (field.value == null) return null
    return { id: field.value, className: idx.objectClassName(field.value) }
  }
  if (field.type === 'char') return String.fromCharCode(field.value)
  return typeof field.value === 'bigint' ? String(field.value) : field.value
}

function clamp(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.floor(number), min), max)
}
