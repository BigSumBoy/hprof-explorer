/**
 * Persistent findings attached to heap objects, classes, paths and dumps.
 *
 * A finding is keyed by the dump file's real path, not by the runtime dump id:
 * `dump-N` changes every time the engine restarts, while the file identity is
 * stable. The JSON files live under `<appDir>/data/findings`, which is already
 * an ignored local-data directory.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SEVERITIES = new Set(['info', 'warn', 'error'])
const TARGET_KINDS = new Set(['object', 'class', 'path', 'field', 'dump'])

function asText(value, name, max) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const text = value.trim()
  if (text === '') throw new Error(`${name} must be non-empty`)
  if (text.length > max) throw new Error(`${name} exceeds ${max} characters`)
  return text
}

function normalizeTarget(target) {
  if (target === null || typeof target !== 'object') throw new Error('target must be an object')
  const kind = String(target.kind ?? '')
  if (!TARGET_KINDS.has(kind)) throw new Error(`target.kind must be one of ${[...TARGET_KINDS].join(', ')}`)
  const next = { kind }
  if (kind === 'object' || kind === 'class') {
    const id = Number(target.id)
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('target.id must be a non-negative integer')
    next.id = id
  }
  if (kind === 'path') {
    if (!Array.isArray(target.ids) || target.ids.length === 0) throw new Error('target.ids must be a non-empty array')
    next.ids = target.ids.map((id) => {
      const value = Number(id)
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('target.ids must contain non-negative integers')
      return value
    })
  }
  if (kind === 'field') {
    next.field = asText(target.field, 'target.field', 200)
    const id = Number(target.id)
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('target.id must be a non-negative integer')
    next.id = id
  }
  if (typeof target.label === 'string' && target.label.trim() !== '') next.label = target.label.trim().slice(0, 300)
  return next
}

function normalizeTags(tags) {
  if (tags === undefined) return []
  if (!Array.isArray(tags)) throw new Error('tags must be an array')
  return tags.map((tag) => asText(tag, 'tags[]', 60)).slice(0, 20)
}

export function createFindingsStore(runtime, options = {}) {
  const dir = options.dir ?? path.join(runtime.config?.appDir ?? process.cwd(), 'data', 'findings')

  function entryFor(dumpId) {
    const dumps = runtime.list()
    const entry = dumpId === undefined
      ? dumps[dumps.length - 1]
      : dumps.find((dump) => dump.dump_id === dumpId)
    if (entry === undefined) throw new Error(`unknown dump_id "${dumpId ?? ''}"; call hprof_open first`)
    return entry
  }

  function keyOf(file) {
    return crypto.createHash('sha1').update(path.resolve(file)).digest('hex')
  }

  function fileOf(key) {
    return path.join(dir, `${key}.json`)
  }

  function load(dumpId) {
    const entry = entryFor(dumpId)
    const key = keyOf(entry.file)
    const file = fileOf(key)
    if (!fs.existsSync(file)) return { dump_file: entry.file, dump_id: entry.dump_id, findings: [] }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return {
        dump_file: entry.file,
        dump_id: entry.dump_id,
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      }
    } catch {
      return { dump_file: entry.file, dump_id: entry.dump_id, findings: [] }
    }
  }

  function save(entry, findings) {
    fs.mkdirSync(dir, { recursive: true })
    const key = keyOf(entry.file)
    const file = fileOf(key)
    fs.writeFileSync(file, JSON.stringify({ version: 1, dump_file: entry.file, findings }, null, 2))
    return file
  }

  function create(dumpId, params = {}) {
    const entry = entryFor(dumpId)
    const title = asText(params.title, 'title', 200)
    const target = normalizeTarget(params.target)
    const severity = params.severity === undefined ? 'info' : String(params.severity)
    if (!SEVERITIES.has(severity)) throw new Error('severity must be info, warn or error')
    const note = params.note === undefined ? '' : String(params.note).slice(0, 8_000)
    const finding = {
      id: `f-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      target,
      title,
      note,
      severity,
      tags: normalizeTags(params.tags),
      author: params.author === 'user' ? 'user' : 'agent',
      createdAt: new Date().toISOString(),
    }
    const state = load(dumpId)
    save(entry, [finding, ...state.findings])
    return { ...finding, dump_id: entry.dump_id, dump_file: entry.file }
  }

  function list(dumpId, filter = {}) {
    const entry = entryFor(dumpId)
    const state = load(dumpId)
    let findings = state.findings
    if (filter.kind !== undefined) findings = findings.filter((item) => item.target.kind === filter.kind)
    if (filter.target_id !== undefined) findings = findings.filter((item) => item.target.id === Number(filter.target_id))
    return { dump_id: entry.dump_id, dump_file: entry.file, findings }
  }

  function update(dumpId, params = {}) {
    const entry = entryFor(dumpId)
    const id = asText(params.id, 'id', 100)
    const state = load(dumpId)
    const index = state.findings.findIndex((item) => item.id === id)
    if (index < 0) throw new Error(`unknown finding "${id}"`)
    const before = state.findings[index]
    const next = { ...before }
    if (params.title !== undefined) next.title = asText(params.title, 'title', 200)
    if (params.note !== undefined) next.note = String(params.note).slice(0, 8_000)
    if (params.severity !== undefined) {
      const severity = String(params.severity)
      if (!SEVERITIES.has(severity)) throw new Error('severity must be info, warn or error')
      next.severity = severity
    }
    if (params.tags !== undefined) next.tags = normalizeTags(params.tags)
    next.updatedAt = new Date().toISOString()
    const findings = state.findings.slice()
    findings[index] = next
    save(entry, findings)
    return { ...next, dump_id: entry.dump_id, dump_file: entry.file }
  }

  function remove(dumpId, params = {}) {
    const entry = entryFor(dumpId)
    const id = asText(params.id, 'id', 100)
    const state = load(dumpId)
    const findings = state.findings.filter((item) => item.id !== id)
    if (findings.length === state.findings.length) throw new Error(`unknown finding "${id}"`)
    save(entry, findings)
    return { deleted: id, dump_id: entry.dump_id }
  }

  return {
    create: (params) => create(params.dump_id, params),
    list: (params = {}) => list(params.dump_id, params),
    update: (params) => update(params.dump_id, params),
    remove: (params) => remove(params.dump_id, params),
  }
}
