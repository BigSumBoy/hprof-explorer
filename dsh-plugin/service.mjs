/**
 * Read-only HPROF domain service.
 *
 * The service is the single projection surface over one or more open dumps:
 * tools, and later the PTC client and the Web UI, call these operations
 * instead of maintaining their own method lists. Every entity is addressed by
 * its dump id plus object/class id; collections are paginated; arrays and
 * strings are read in slices. Findings are the one mutable layer, keyed by
 * dump file identity so they survive dump-id churn.
 */
import fs from 'node:fs/promises'
import { createFindingsStore } from './findings.mjs'
import { createUiState } from './ui-state.mjs'

const CAPABILITIES = {
  name: 'hprof',
  version: 1,
  readOnly: true,
  entities: {
    dump: 'Open heap dump; id is the runtime dump handle.',
    object: 'Instance, class, object array, primitive array or String; id is the heap object id.',
    class: 'Object id whose class-table entry is a class (kind: class).',
    field: 'A named field on an instance; an object field points at another object id.',
    array: 'Object or primitive array; elements are paged.',
    root: 'A GC root entry with its object id and root types.',
    path: 'A chain of object/class nodes with the field or root edge used at each step.',
    finding: 'An annotation attached to an object, class, path, field or dump; persisted by dump file identity.',
  },
  operations: {
    capabilities: 'Return this manifest.',
    'dump.open': 'Open a dump. params: { path }',
    'dump.list': 'List open dumps. params: {}',
    'dump.close': 'Close one dump. params: { dump_id }',
    'dump.summary': 'Counts and graph summary. params: { dump_id? }',
    'entity.get': 'Full object/class detail. params: { id, dump_id? }',
    'entity.fields': 'Instance fields or class field metadata. params: { id, dump_id? }',
    'entity.array': 'Paged array elements or String text. params: { id, page?, size?, dump_id? }',
    'entity.statics': 'Class static fields. params: { id, dump_id? }',
    'entity.referrers': 'Incoming references. params: { id, dump_id? }',
    'entity.children': 'Outgoing object references from an instance/class. params: { id, page?, size?, dump_id? }',
    'query.classes': 'Class histogram. params: { query?, sort?, min_count?, min_bytes?, offset?, limit?, dump_id? }',
    'query.instances': 'Instances of a class, optionally projecting field values. params: { class_id, kind?, page?, size?, fields?, query?, heap?, id_prefix?, min_bytes?, dump_id? }',
    'query.strings': 'String search. params: { query?, page?, size?, readable?, min_length?, id_prefix?, dump_id? }',
    'query.roots': 'GC roots. params: { type?, query?, heap?, page?, size?, id_prefix?, dump_id? }',
    'query.retained': 'Retained-size ranking. params: { class_filter?, min_retained?, page?, size?, dump_id? }',
    'paths.object': 'Shortest GC-root path for one object. params: { id, weak?, dump_id? }',
    'paths.class': 'Grouped GC-root paths for one class. params: { class_id, kind?, weak?, page?, size?, dump_id? }',
    'analyze.classStats': 'Aggregate reachability, native state, callsites and roots/holders. params: { class_id, kind?, dump_id? }',
    'analyze.diff': 'Compare two dumps by class. params: { base, other }',
    'analyze.report': 'Write a Markdown report including findings. params: { dump_id?, out_path? }',
    'findings.create': 'Attach a finding to a target. params: { dump_id?, target, title, note?, severity?, tags?, author? }',
    'findings.list': 'List findings for a dump, optionally filtered. params: { dump_id?, kind?, target_id? }',
    'findings.update': 'Update one finding. params: { dump_id?, id, title?, note?, severity?, tags? }',
    'findings.delete': 'Delete one finding. params: { dump_id?, id }',
    'ui.state': 'Read live panel state. params: { dump_id?, client_id? }',
    'ui.command': 'Send one UI action: selectTab, selectRow, setFilters, setPage, setSort, toggleNode, selectObject, selectClass, openDump, closeDump, closeDrawer, refresh, runReport, draftMessage, notice. params: { dump_id?, client_id?, action, params? }',
    'ui.events': 'Read the bounded UI event ledger. params: { dump_id?, limit? }',
  },
  examples: [
    { op: 'query.classes', params: { query: 'SurfaceControl', sort: 'count' } },
    { op: 'analyze.classStats', params: { class_id: 49980688 } },
    { op: 'query.instances', params: { class_id: 49980688, fields: ['mNativeObject', 'mCallsite'] } },
    { op: 'entity.array', params: { id: 194142312, page: 0, size: 100 } },
    { op: 'entity.referrers', params: { id: 168770128 } },
    { op: 'paths.class', params: { class_id: 49980688, page: 0, size: 10 } },
    { op: 'findings.create', params: { target: { kind: 'object', id: 168770128 }, title: 'task 9 leash is retained by ShellTaskOrganizer' } },
    { op: 'ui.state', params: {} },
    { op: 'ui.command', params: { action: 'selectObject', params: { id: 168770128 } } },
  ],
}

function asDumpId(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asId(value, name) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`${name} must be a non-negative integer`)
  return id
}

function asPage(value) {
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 0 ? page : 0
}

function asSize(value, fallback, max) {
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 1) return fallback
  return Math.min(size, max)
}

function withMore(result, page, size) {
  if (result === null || typeof result !== 'object') return result
  const total = Number(result.total ?? result.length ?? result.pageSize ?? 0)
  const offset = result.offset ?? page * (size ?? result.pageSize ?? 0)
  const returned = Array.isArray(result.items) ? result.items.length : 0
  return { ...result, hasMore: returned > 0 && offset + returned < total }
}

function compactClassPaths(result, page, size) {
  const groups = Array.isArray(result.groups) ? result.groups : []
  const start = page * size
  const slice = groups.slice(start, start + size).map((group) => {
    const steps = Array.isArray(group.steps) ? group.steps : []
    const chain = steps
      .map((step, index) => (index === 0 ? '<root>' : `${step.className}${step.via ? ` <- ${step.via}` : ''}`))
      .join(' | ')
    return {
      count: group.count,
      shallow: group.shallow,
      chain,
      samples: group.samples ?? [],
    }
  })
  return {
    className: result.className,
    groupCount: result.groupCount,
    page,
    size,
    returned: slice.length,
    hasMore: start + slice.length < groups.length,
    groups: slice,
  }
}

function renderFindings(items) {
  const lines = ['', '## Findings', '']
  if (items.length === 0) {
    lines.push('No findings recorded for this dump.', '')
    return lines.join('\n')
  }
  lines.push(`${items.length} finding(s) recorded for this dump.`, '')
  for (const finding of items) {
    lines.push(`### [${finding.severity}] ${finding.title}`, '')
    const target = finding.target
    let targetText = target.kind
    if (target.id !== undefined) targetText += ` ${target.id}`
    if (target.field !== undefined) targetText += `.${target.field}`
    if (target.ids !== undefined) targetText += ` [${target.ids.join(' -> ')}]`
    if (target.label !== undefined) targetText += ` (${target.label})`
    lines.push(`- target: ${targetText}`)
    lines.push(`- author: ${finding.author}`)
    if (finding.tags.length > 0) lines.push(`- tags: ${finding.tags.join(', ')}`)
    lines.push(`- created: ${finding.createdAt}`)
    if (finding.note !== '') {
      lines.push('', finding.note)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function createHprofService(runtime, options = {}) {
  const findings = options.findings ?? createFindingsStore(runtime)
  const ui = options.uiState ?? createUiState()
  async function call(dumpId, method, params, exec) {
    const rec = runtime.pickDump(asDumpId(dumpId))
    return runtime.call(rec, method, params, exec?.signal ? { signal: exec.signal } : undefined)
  }

  const service = {
    capabilities() {
      return CAPABILITIES
    },

    dump: {
      async open(params = {}, exec) {
        const path = typeof params.path === 'string' ? params.path.trim() : ''
        if (path === '') throw new Error('path must be a non-empty string')
        return runtime.open(path, exec)
      },
      list() {
        return { dumps: runtime.list() }
      },
      close(params = {}) {
        return runtime.close(asDumpId(params.dump_id))
      },
      async summary(params = {}, exec) {
        return call(params.dump_id, 'summary', {}, exec)
      },
    },

    entity: {
      async get(params = {}, exec) {
        return call(params.dump_id, 'object', { id: asId(params.id, 'id') }, exec)
      },
      async fields(params = {}, exec) {
        const detail = await call(params.dump_id, 'object', { id: asId(params.id, 'id') }, exec)
        if (detail.kind === 'class') {
          return {
            kind: 'class',
            id: detail.id,
            className: detail.class?.name ?? null,
            fields: detail.class?.fields ?? [],
            statics: detail.class?.statics ?? [],
          }
        }
        return {
          kind: detail.kind,
          id: detail.id,
          className: detail.className ?? null,
          heap: detail.heap ?? null,
          size: detail.size ?? null,
          fields: detail.fields ?? [],
          length: detail.length ?? null,
          string: detail.string,
          truncated: detail.truncated === true,
        }
      },
      async array(params = {}, exec) {
        const page = asPage(params.page)
        const size = asSize(params.size, 100, 500)
        return call(params.dump_id, 'arrayElements', {
          id: asId(params.id, 'id'),
          page,
          size,
        }, exec)
      },
      async statics(params = {}, exec) {
        const detail = await call(params.dump_id, 'object', { id: asId(params.id, 'id') }, exec)
        if (detail.kind !== 'class') throw new Error('object is not a class')
        return { className: detail.class?.name ?? null, statics: detail.class?.statics ?? [] }
      },
      async referrers(params = {}, exec) {
        return call(params.dump_id, 'referrers', { id: asId(params.id, 'id') }, exec)
      },
      async children(params = {}, exec) {
        const page = asPage(params.page)
        const size = asSize(params.size, 100, 500)
        const detail = await call(params.dump_id, 'object', { id: asId(params.id, 'id') }, exec)
        const references = []
        for (const field of detail.fields ?? []) {
          if (field.value !== null && typeof field.value === 'object' && typeof field.value.id === 'number') {
            references.push({ via: `field ${field.name}`, id: field.value.id, className: field.value.name ?? null })
          }
        }
        for (const field of detail.class?.statics ?? []) {
          if (field.value !== null && typeof field.value === 'object' && typeof field.value.id === 'number') {
            references.push({ via: `static ${field.name}`, id: field.value.id, className: field.value.name ?? null })
          }
        }
        return {
          total: references.length,
          page,
          size,
          items: references.slice(page * size, page * size + size),
          hasMore: (page + 1) * size < references.length,
        }
      },
    },

    query: {
      async classes(params = {}, exec) {
        const offset = asPage(params.offset)
        const limit = asSize(params.limit, 100, 1_000)
        const result = await call(params.dump_id, 'classes', {
          query: params.query,
          sort: params.sort,
          min_count: params.min_count,
          min_bytes: params.min_bytes,
          offset,
          limit,
        }, exec)
        return withMore({ ...result, offset }, offset, limit)
      },
      async instances(params = {}, exec) {
        const page = asPage(params.page)
        const size = asSize(params.size, 100, 500)
        const result = await call(params.dump_id, 'instances', {
          class_id: asId(params.class_id, 'class_id'),
          kind: params.kind === 'primitive' ? 'primitive' : 'class',
          page,
          size,
          fields: params.fields,
          query: params.query,
          heap: params.heap,
          id_prefix: params.id_prefix,
          min_bytes: params.min_bytes,
        }, exec)
        return withMore(result, page, size)
      },
      async strings(params = {}, exec) {
        const page = asPage(params.page)
        const size = asSize(params.size, 50, 200)
        const result = await call(params.dump_id, 'strings', {
          page,
          size,
          query: params.query,
          readable: params.readable,
          min_length: params.min_length,
          id_prefix: params.id_prefix,
        }, exec)
        return withMore(result, page, size)
      },
      async roots(params = {}, exec) {
        const page = asPage(params.page)
        const size = asSize(params.size, 50, 200)
        const result = await call(params.dump_id, 'roots', {
          page,
          size,
          type: params.type,
          query: params.query,
          heap: params.heap,
          id_prefix: params.id_prefix,
        }, exec)
        return withMore(result, page, size)
      },
      async retained(params = {}, exec) {
        const page = asPage(params.page)
        const size = asSize(params.size, 20, 200)
        const result = await call(params.dump_id, 'retained', {
          page,
          size,
          query: params.class_filter,
          min_retained: params.min_retained,
        }, exec)
        return withMore(result, page, size)
      },
    },

    paths: {
      async object(params = {}, exec) {
        return call(params.dump_id, 'path', {
          id: asId(params.id, 'id'),
          weak: params.weak === true,
        }, exec)
      },
      async class(params = {}, exec) {
        const page = asPage(params.page)
        const size = asSize(params.size, 10, 10)
        const result = await call(params.dump_id, 'classPaths', {
          class_id: asId(params.class_id, 'class_id'),
          kind: params.kind === 'primitive' ? 'primitive' : 'class',
          weak: params.weak === true,
          include_holders: true,
        }, exec)
        return compactClassPaths(result, page, size)
      },
    },

    analyze: {
      async classStats(params = {}, exec) {
        return call(params.dump_id, 'classStats', {
          class_id: asId(params.class_id, 'class_id'),
          kind: params.kind === 'primitive' ? 'primitive' : 'class',
        }, exec)
      },
      async diff(params = {}, exec) {
        const base = typeof params.base === 'string' ? params.base.trim() : ''
        const other = typeof params.other === 'string' ? params.other.trim() : ''
        if (base === '' || other === '') throw new Error('base and other must be non-empty paths')
        const [baseDump, otherDump] = await Promise.all([
          runtime.open(base, exec),
          runtime.open(other, exec),
        ])
        return runtime.diff(baseDump.dump_id, otherDump.dump_id, exec)
      },
      async report(params = {}, exec) {
        const dumpId = asDumpId(params.dump_id) ?? runtime.list().at(-1)?.dump_id
        const report = await runtime.report(
          dumpId,
          typeof params.out_path === 'string' ? params.out_path : undefined,
          exec,
        )
        const recorded = findings.list({ dump_id: dumpId }).findings
        const original = await fs.readFile(report.path, 'utf8')
        const next = `${original}${renderFindings(recorded)}`
        await fs.writeFile(report.path, next, 'utf8')
        return {
          ...report,
          bytes: Buffer.byteLength(next),
          preview: next.slice(0, 1_500),
          findings: recorded.length,
        }
      },
    },

    findings: {
      create(params = {}) {
        return findings.create(params)
      },
      list(params = {}) {
        return findings.list(params)
      },
      update(params = {}) {
        return findings.update(params)
      },
      delete(params = {}) {
        return findings.remove(params)
      },
    },

    ui: {
      state(params = {}) {
        const dumpId = asDumpId(params.dump_id) ?? runtime.list().at(-1)?.dump_id
        return ui.getState(dumpId, params.client_id)
      },
      command(params = {}) {
        const dumpId = asDumpId(params.dump_id) ?? runtime.list().at(-1)?.dump_id
        return ui.command(dumpId, params.action, params.params, params.client_id)
      },
      events(params = {}) {
        const dumpId = asDumpId(params.dump_id) ?? runtime.list().at(-1)?.dump_id
        return ui.eventLog(dumpId, Number(params.limit) || 50)
      },
    },

    dispatch(op, params = {}, exec) {
      if (op === 'capabilities') return this.capabilities()
      const [group, name] = typeof op === 'string' ? op.split('.') : []
      const handler = group === undefined ? undefined : this[group]?.[name]
      if (typeof handler !== 'function') {
        throw new Error(`unknown hprof operation "${String(op)}"; call op capabilities`)
      }
      return handler.call(this, params, exec)
    },
  }

  return service
}
