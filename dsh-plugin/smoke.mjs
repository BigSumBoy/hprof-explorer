/**
 * Standalone smoke test for the Harness adapter, without booting Harness.
 *
 * Run from the HPROF Explorer root:
 *   node dsh-plugin/smoke.mjs
 *
 * It exercises the engine protocol through the tool definitions and the
 * `/hprof-api` handler, then checks the diff aggregation with synthetic
 * profiles. Opening the real dump uses about 1 GB in the engine process.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  createApiHandler,
  createHprofRuntime,
  createToolDefinitions,
  diffProfiles,
} from './index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '..')
const dump = findDump()
const runtime = createHprofRuntime({ appDir, workspaceRoot: appDir })
assert.equal(runtime.config.idleTimeoutMs, 0, 'idle close must be disabled by default')
const tools = new Map(createToolDefinitions(runtime).map((tool) => [tool.name, tool]))
const exec = { signal: new AbortController().signal }

try {
  const opened = await call('hprof_open', { path: dump })
  assert.equal(typeof opened.dump_id, 'string')
  assert.ok(opened.counts.classes > 1_000, 'expected more than 1000 classes')
  assert.ok(Array.isArray(opened.top_classes_by_bytes) && opened.top_classes_by_bytes.length > 0)
  console.log(
    `open: ${opened.file_size_bytes} bytes, ${opened.counts.classes} classes, `
    + `${opened.counts.instances} instances, parse ${opened.parse_ms} ms`,
  )

  const classes = await call('hprof_classes', { dump_id: opened.dump_id, sort: 'bytes', limit: 50 })
  assert.ok(classes.items.length > 0)
  console.log(`classes: top ${classes.items[0].name} (${classes.items[0].bytes} bytes)`)

  const target = classes.items.find((item) => item.kind === 'class' && item.count > 10)
  assert.ok(target !== undefined, 'expected a non-array class with instances')
  const instances = await call('hprof_instances', {
    dump_id: opened.dump_id,
    class_id: target.id,
    kind: target.kind,
    size: 2,
  })
  assert.ok(instances.items.length > 0, 'expected instances for a class with count > 10')
  console.log(`instances: ${instances.total} total for ${target.name}`)

  const classPaths = await call('hprof_class_paths', {
    dump_id: opened.dump_id,
    class_id: target.id,
    kind: target.kind,
  })
  assert.ok(Array.isArray(classPaths.groups) && classPaths.groups.length > 0, 'expected GC-root path groups')
  assert.equal(classPaths.groups[0].signature, undefined, 'signature must be trimmed from model output')
  assert.equal(classPaths.groups[0].steps, undefined, 'paths must be compact chain strings')
  assert.ok(typeof classPaths.groups[0].chain === 'string' && classPaths.groups[0].chain.includes('<-'))
  assert.ok(classPaths.reachable + classPaths.unreachable <= classPaths.totalObjects)
  assert.ok(typeof classPaths.unreachable === 'number')
  assert.ok(classPaths.totalObjects <= target.count)
  console.log(`class_paths: ${classPaths.groupCount ?? classPaths.groups.length} groups`)

  const deepPage = await call('hprof_class_paths', {
    dump_id: opened.dump_id,
    class_id: target.id,
    kind: target.kind,
    page: 50,
    size: 10,
  })
  assert.ok(deepPage.groups.length > 0, 'class path pagination must go beyond the old 100-group cap')
  assert.equal(deepPage.page, 50)
  assert.equal(deepPage.hasMore, deepPage.page * deepPage.size + deepPage.groups.length < deepPage.groupCount)
  console.log(`class_paths deep page: ${deepPage.groups.length} groups at page ${deepPage.page}`)

  const surfaceClasses = await call('hprof_classes', {
    dump_id: opened.dump_id,
    query: 'android.view.SurfaceControl',
    sort: 'count',
    limit: 10,
  })
  const surface = surfaceClasses.items.find((item) => item.name === 'android.view.SurfaceControl')
  assert.ok(surface !== undefined, 'expected android.view.SurfaceControl in the real dump')

  const stats = await call('hprof_class_stats', {
    dump_id: opened.dump_id,
    class_id: surface.id,
    kind: 'class',
  })
  assert.equal(stats.totalObjects, surface.count)
  assert.equal(stats.reachable + stats.unreachable, stats.totalObjects)
  assert.equal(stats.native.retained + stats.native.released + stats.native.unknown, stats.totalObjects)
  assert.equal(stats.native.field, true, 'SurfaceControl must expose mNativeObject')
  assert.ok(stats.callsites.length > 0 && stats.callsites[0].callsite !== undefined)
  assert.ok(stats.holders.length > 0 && stats.holders[0].className !== undefined)
  const statsText = JSON.stringify(stats, null, 2)
  assert.ok(statsText.length < 7_000, `class stats must fit a tool result, got ${statsText.length} chars`)
  console.log(
    `class_stats: ${stats.totalObjects} total, ${stats.reachable} reachable, ${stats.unreachable} unreachable, `
    + `${stats.native.retained} native, ${stats.native.released} released, ${stats.groupCount} groups`,
  )

  const firstPage = await call('hprof_class_paths', {
    dump_id: opened.dump_id,
    class_id: surface.id,
    kind: 'class',
    page: 0,
    size: 5,
  })
  assert.equal(firstPage.groups.length, 5)
  assert.equal(firstPage.groupCount, stats.groupCount)
  assert.equal(firstPage.hasMore, true)
  assert.ok(firstPage.groups[0].chain.includes('android.view.SurfaceControl'))
  assert.ok(typeof firstPage.groups[0].samples[0].holderId === 'number', 'holder ids must be present')
  const lastPage = await call('hprof_class_paths', {
    dump_id: opened.dump_id,
    class_id: surface.id,
    kind: 'class',
    page: Math.ceil(stats.groupCount / 5) - 1,
    size: 5,
  })
  assert.equal(lastPage.hasMore, false)
  console.log(`class_paths pages: returned ${firstPage.groups.length}/${firstPage.groupCount}, last page ${lastPage.groups.length} groups`)

  const capabilities = await call('hprof_api', { op: 'capabilities' })
  assert.equal(capabilities.name, 'hprof')
  assert.ok(capabilities.operations['entity.array'] !== undefined)
  assert.ok(Array.isArray(capabilities.examples) && capabilities.examples.length > 0)

  const apiStats = await call('hprof_api', {
    op: 'analyze.classStats',
    params: { class_id: surface.id },
  })
  assert.equal(apiStats.totalObjects, stats.totalObjects)
  assert.equal(apiStats.reachable, stats.reachable)

  const apiInstances = await call('hprof_api', {
    op: 'query.instances',
    params: { class_id: surface.id, size: 5, fields: ['mNativeObject', 'mCallsite'] },
  })
  assert.equal(apiInstances.items.length, 5)
  assert.ok('mNativeObject' in apiInstances.items[0].fields)
  assert.ok('mCallsite' in apiInstances.items[0].fields)
  const sampleId = apiInstances.items[0].id
  const reachableSampleId = firstPage.groups[0].samples[0].id
  const apiFields = await call('hprof_api', { op: 'entity.fields', params: { id: sampleId } })
  assert.ok(Array.isArray(apiFields.fields) && apiFields.fields.some((field) => field.name === 'mNativeObject'))
  const apiPath = await call('hprof_api', { op: 'paths.object', params: { id: reachableSampleId } })
  assert.equal(apiPath.found, true)
  const apiClassPaths = await call('hprof_api', {
    op: 'paths.class',
    params: { class_id: surface.id, page: 0, size: 5 },
  })
  assert.equal(apiClassPaths.groups.length, 5)
  const apiClasses = await call('hprof_api', {
    op: 'query.classes',
    params: { offset: 5, limit: 5 },
  })
  assert.equal(apiClasses.items.length, 5)
  const uiCommand = await call('hprof_api', {
    op: 'ui.command',
    params: { action: 'selectTab', params: { tab: 'findings' } },
  })
  assert.equal(uiCommand.action, 'selectTab')
  const rowCommand = await call('hprof_api', {
    op: 'ui.command',
    params: { action: 'selectRow', params: { table: 'classes', id: surface.id } },
  })
  assert.equal(rowCommand.action, 'selectRow')
  const filterCommand = await call('hprof_api', {
    op: 'ui.command',
    params: { action: 'setFilters', params: { tab: 'classes', filters: { query: 'Surface' } } },
  })
  assert.equal(filterCommand.action, 'setFilters')
  const pageCommand = await call('hprof_api', {
    op: 'ui.command',
    params: { action: 'setPage', params: { tab: 'instances', page: 1 } },
  })
  assert.equal(pageCommand.action, 'setPage')
  const sortCommand = await call('hprof_api', {
    op: 'ui.command',
    params: { action: 'setSort', params: { tab: 'classes', sort: 'count' } },
  })
  assert.equal(sortCommand.action, 'setSort')
  const treeCommand = await call('hprof_api', {
    op: 'ui.command',
    params: { action: 'toggleNode', params: { id: 168770128 } },
  })
  assert.equal(treeCommand.action, 'toggleNode')
  const classPathCommand = await call('hprof_api', {
    op: 'ui.command',
    params: { action: 'toggleNode', params: { view: 'classpaths', index: 0 } },
  })
  assert.equal(classPathCommand.action, 'toggleNode')
  const draftCommand = await call('hprof_api', {
    op: 'ui.command',
    params: { action: 'draftMessage', params: { text: 'smoke draft' } },
  })
  assert.equal(draftCommand.action, 'draftMessage')
  console.log(`hprof_api: ${Object.keys(capabilities.operations).length} ops, fields projection + paths + classes pagination + ui commands ok`)

  const ptc = await call('hprof_ptc', {
    code: `
      const classes = await hprof.query.classes({ query: 'android.view.SurfaceControl', sort: 'count' })
      const surface = classes.items.find((item) => item.name === 'android.view.SurfaceControl')
      const stats = await hprof.analyze.classStats({ class_id: surface.id })
      const paths = await hprof.paths.class({ class_id: surface.id, page: 0, size: 3 })
      console.log('surface total', stats.totalObjects)
      return {
        total: stats.totalObjects,
        reachable: stats.reachable,
        groups: paths.groups.length,
        hasSurfaceChain: paths.groups[0].chain.includes('SurfaceControl'),
      }
    `,
  })
  assert.equal(ptc.result.total, stats.totalObjects)
  assert.equal(ptc.result.reachable, stats.reachable)
  assert.equal(ptc.result.groups, 3)
  assert.equal(ptc.result.hasSurfaceChain, true)
  assert.ok(ptc.logs.some((line) => line.includes('surface total')))
  await assert.rejects(
    () => call('hprof_ptc', { code: 'throw new Error("ptc boom")' }),
    /ptc boom/,
  )
  await assert.rejects(
    () => call('hprof_ptc', { code: 'while (true) {}', timeout_ms: 1000 }),
    /timed out/,
  )
  console.log(`hprof_ptc: ${ptc.result.total} objects, ${ptc.result.groups} path groups, logs and error isolation ok`)

  const createdFinding = await call('hprof_annotate', {
    action: 'create',
    dump_id: opened.dump_id,
    target: { kind: 'object', id: 168770128, label: 'TaskAppearedInfo[9].mLeash' },
    title: 'SurfaceControl retained by task 9',
    note: 'Smoke test finding.',
    severity: 'info',
    tags: ['smoke', 'surfacecontrol'],
  })
  assert.equal(typeof createdFinding.id, 'string')
  assert.equal(createdFinding.target.id, 168770128)
  const listedFindings = await call('hprof_annotate', { action: 'list', dump_id: opened.dump_id })
  assert.ok(listedFindings.findings.some((finding) => finding.id === createdFinding.id))
  const updatedFinding = await call('hprof_annotate', {
    action: 'update',
    dump_id: opened.dump_id,
    id: createdFinding.id,
    title: 'SurfaceControl retained by task 9 (updated)',
    severity: 'warn',
  })
  assert.equal(updatedFinding.severity, 'warn')
  const deletedFinding = await call('hprof_annotate', {
    action: 'delete',
    dump_id: opened.dump_id,
    id: createdFinding.id,
  })
  assert.equal(deletedFinding.deleted, createdFinding.id)
  console.log(`hprof_annotate: created/listed/updated/deleted ${createdFinding.id}`)

  const primitive = classes.items.find((item) => item.kind === 'primitive')
  if (primitive !== undefined) {
    const arrays = await call('hprof_instances', {
      dump_id: opened.dump_id,
      class_id: primitive.id,
      kind: 'primitive',
      size: 2,
    })
    assert.ok(arrays.items.length > 0, 'expected primitive arrays for a primitive class')
    const arrayPage = await call('hprof_api', { op: 'entity.array', params: { id: arrays.items[0].id, size: 2 } })
    assert.ok(Array.isArray(arrayPage.items) && arrayPage.items.length === 2)
    console.log(`primitive instances: ${arrays.total} for ${primitive.name}`)
  }

  const retained = await call('hprof_retained', { dump_id: opened.dump_id, size: 5 })
  assert.ok(retained.items.length > 0)
  const big = retained.items[0]
  console.log(`retained: ${big.className} ${big.retained} bytes`)

  const object = await call('hprof_object', { dump_id: opened.dump_id, id: big.id })
  assert.ok(typeof object.kind === 'string')
  assert.ok(object.retained !== undefined)
  console.log(`object: ${object.kind} ${object.className ?? ''}`)

  const gcPath = await call('hprof_path', { dump_id: opened.dump_id, id: big.id })
  assert.equal(gcPath.found, true, 'a retained object must be reachable')
  console.log(`path: ${gcPath.distance} hops`)

  const strings = await call('hprof_strings', { dump_id: opened.dump_id, query: '设置', size: 3 })
  assert.ok(strings.items.length > 0, 'expected readable strings')
  console.log(`strings: ${strings.total} matches`)

  const roots = await call('hprof_roots', { dump_id: opened.dump_id, type: 'JNI_GLOBAL', size: 3 })
  assert.ok(roots.items.length > 0, 'expected JNI_GLOBAL roots')
  console.log(`roots: ${roots.total} JNI_GLOBAL`)

  const referrers = await call('hprof_referrers', { dump_id: opened.dump_id, id: big.id })
  assert.ok(Array.isArray(referrers.items))
  console.log(`referrers: ${referrers.items.length}${referrers.truncated ? ' (truncated)' : ''}`)

  const reportFinding = await call('hprof_annotate', {
    action: 'create',
    dump_id: opened.dump_id,
    target: { kind: 'object', id: big.id, label: 'report smoke target' },
    title: 'report smoke finding',
    note: 'This note must appear in the generated report.',
    severity: 'warn',
    tags: ['smoke', 'report'],
  })
  const reportPath = path.join(os.tmpdir(), `hprof-smoke-report-${Date.now()}.md`)
  const report = await call('hprof_report', { dump_id: opened.dump_id, out_path: reportPath })
  assert.ok(fs.existsSync(report.path), 'report file must exist')
  assert.ok(fs.statSync(report.path).size > 200, 'report must not be empty')
  assert.ok(report.findings >= 1)
  const reportText = fs.readFileSync(report.path, 'utf8')
  assert.ok(reportText.includes('## Findings'), 'report must contain a Findings section')
  assert.ok(reportText.includes('report smoke finding'), 'report must contain the finding title')
  assert.ok(reportText.includes(reportFinding.id) || reportText.includes('This note must appear'), 'report must contain finding details')
  fs.rmSync(report.path, { force: true })
  await call('hprof_annotate', { action: 'delete', dump_id: opened.dump_id, id: reportFinding.id })
  console.log(`report: ${report.bytes} bytes, ${report.findings} finding`)

  await exerciseRoutes(runtime)
  exerciseDiff()
  console.log('routes: ok')
  console.log('diff: ok')

  const closed = await call('hprof_close', { dump_id: opened.dump_id })
  assert.equal(closed.closed, opened.dump_id)
  console.log('close: ok')
  console.log('SMOKE OK')
} finally {
  runtime.dispose()
}

function call(name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  return definition.execute(args, exec)
}

async function exerciseRoutes(runtime) {
  const handler = createApiHandler(runtime)

  const dumps = await get(handler, '/hprof-api/dumps')
  assert.ok(Array.isArray(dumps.dumps) && dumps.dumps.length === 1)

  const summary = await get(handler, `/hprof-api/summary?dump_id=${dumps.dumps[0].dump_id}`)
  assert.ok(summary.counts.classes > 1_000)
  assert.equal(summary.classes, undefined, 'summary must not carry the full class list')

  const classes = await get(handler, `/hprof-api/classes?dump_id=${dumps.dumps[0].dump_id}&sort=count&limit=5`)
  assert.ok(classes.items.length === 5)

  const primitiveClasses = await get(handler, `/hprof-api/classes?dump_id=${dumps.dumps[0].dump_id}&kind=primitive&limit=5`)
  assert.ok(primitiveClasses.items.length > 0)
  assert.ok(primitiveClasses.items.every((item) => item.kind === 'primitive'), 'kind filter must only return primitive rows')

  const filteredInstances = await get(handler, `/hprof-api/instances?dump_id=${dumps.dumps[0].dump_id}&class_id=${classes.items[0].id}&kind=${classes.items[0].kind}&query=${encodeURIComponent(classes.items[0].name)}&size=3`)
  assert.ok(Array.isArray(filteredInstances.items))

  const retained = await get(handler, `/hprof-api/retained?dump_id=${dumps.dumps[0].dump_id}&size=3`)
  assert.ok(retained.items.length === 3)

  const first = retained.items[0]
  const object = await get(handler, `/hprof-api/object?dump_id=${dumps.dumps[0].dump_id}&id=${first.id}`)
  assert.equal(object.id, first.id)

  const gcPath = await get(handler, `/hprof-api/path?dump_id=${dumps.dumps[0].dump_id}&id=${first.id}`)
  assert.equal(gcPath.found, true)

  const strings = await get(handler, `/hprof-api/strings?dump_id=${dumps.dumps[0].dump_id}&query=${encodeURIComponent('设置')}&readable=1&size=3`)
  assert.ok(strings.items.length > 0)

  const stringById = await get(handler, `/hprof-api/strings?dump_id=${dumps.dumps[0].dump_id}&id_prefix=${strings.items[0].id}&size=3`)
  assert.ok(stringById.items.some((item) => item.id === strings.items[0].id), 'id_prefix must match the source string')

  const roots = await get(handler, `/hprof-api/roots?dump_id=${dumps.dumps[0].dump_id}&type=JNI_GLOBAL&size=3`)
  assert.ok(roots.items.length > 0)

  const referrers = await get(handler, `/hprof-api/referrers?dump_id=${dumps.dumps[0].dump_id}&id=${first.id}`)
  assert.ok(Array.isArray(referrers.items))

  const domtree = await get(handler, `/hprof-api/domtree?dump_id=${dumps.dumps[0].dump_id}&parent=0&limit=5`)
  assert.ok(Array.isArray(domtree.items) && domtree.items.length > 0)

  const report = await post(handler, '/hprof-api/report', { dump_id: dumps.dumps[0].dump_id })
  assert.ok(typeof report.path === 'string' && fs.existsSync(report.path))
  fs.rmSync(report.path, { force: true })

  const finding = await post(handler, '/hprof-api/findings', {
    dump_id: dumps.dumps[0].dump_id,
    target: { kind: 'object', id: first.id },
    title: 'route smoke finding',
    severity: 'info',
  })
  const findings = await get(handler, `/hprof-api/findings?dump_id=${dumps.dumps[0].dump_id}`)
  assert.ok(findings.findings.some((item) => item.id === finding.id))
  const removed = await post(handler, '/hprof-api/findings/delete', {
    dump_id: dumps.dumps[0].dump_id,
    id: finding.id,
  })
  assert.equal(removed.deleted, finding.id)

  await post(handler, '/hprof-api/ui/state', {
    dump_id: dumps.dumps[0].dump_id,
    state: { tab: 'classes', object_id: null },
  })
  const uiState = await get(handler, `/hprof-api/ui/state?dump_id=${dumps.dumps[0].dump_id}`)
  assert.equal(uiState.state.tab, 'classes')
  const command = await post(handler, '/hprof-api/ui/command', {
    dump_id: dumps.dumps[0].dump_id,
    action: 'selectTab',
    params: { tab: 'roots' },
  })
  const commands = await get(handler, `/hprof-api/ui/commands?dump_id=${dumps.dumps[0].dump_id}`)
  assert.equal(commands.commands[0].id, command.id)

  await post(handler, '/hprof-api/ui/state', {
    dump_id: dumps.dumps[0].dump_id,
    client_id: 'panel-a',
    state: { tab: 'findings' },
  })
  const panelState = await get(handler, `/hprof-api/ui/state?dump_id=${dumps.dumps[0].dump_id}&client_id=panel-a`)
  assert.equal(panelState.state.tab, 'findings')
  const targeted = await post(handler, '/hprof-api/ui/command', {
    dump_id: dumps.dumps[0].dump_id,
    client_id: 'panel-a',
    action: 'selectTab',
    params: { tab: 'classes' },
  })
  const otherPanel = await get(handler, `/hprof-api/ui/commands?dump_id=${dumps.dumps[0].dump_id}&client_id=panel-b`)
  assert.equal(otherPanel.commands.length, 0)
  const targetPanel = await get(handler, `/hprof-api/ui/commands?dump_id=${dumps.dumps[0].dump_id}&client_id=panel-a`)
  assert.ok(targetPanel.commands.some((item) => item.id === targeted.id))
  const panels = await get(handler, `/hprof-api/ui/state?dump_id=${dumps.dumps[0].dump_id}`)
  assert.ok(Array.isArray(panels.panels) && panels.panels.length >= 1)
}

function exerciseDiff() {
  const diff = diffProfiles(
    { id: 'dump-a', path: 'a.hprof' },
    { id: 'dump-b', path: 'b.hprof' },
    {
      counts: { classes: 2, instances: 3, objectArrays: 0, primitiveArrays: 0, roots: 1, stringInstances: 1 },
      classes: [['class', 'A', 1, 10], ['class', 'B', 2, 20]],
    },
    {
      counts: { classes: 3, instances: 5, objectArrays: 0, primitiveArrays: 0, roots: 1, stringInstances: 1 },
      classes: [['class', 'A', 3, 30], ['class', 'C', 2, 5]],
    },
  )
  assert.equal(diff.counts.instances.delta, 2)
  assert.equal(diff.top_growth[0].name, 'A')
  assert.equal(diff.top_growth[0].delta_bytes, 20)
  assert.equal(diff.new_classes[0].name, 'C')
  assert.equal(diff.removed_classes[0].name, 'B')
}

function get(handler, url) {
  return invoke(handler, { method: 'GET', url, headers: {} })
}

function post(handler, url, body) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))])
  stream.method = 'POST'
  stream.url = url
  stream.headers = { 'content-type': 'application/json' }
  return invoke(handler, stream)
}

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(body) {
        if (this.statusCode >= 400) return reject(new Error(`HTTP ${this.statusCode}: ${body}`))
        try {
          resolve(body === undefined || body === '' ? null : JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

function findDump() {
  const dataDir = path.join(appDir, 'data')
  const files = fs.readdirSync(dataDir).filter((file) => file.endsWith('.hprof'))
  if (files.length === 0) throw new Error(`no .hprof under ${dataDir}`)
  return path.join(dataDir, files[0])
}
