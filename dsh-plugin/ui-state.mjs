/**
 * Ephemeral UI-state bridge between Web panels and the agent.
 *
 * Each panel reports under its own client id, so two open panels no longer
 * overwrite each other. Commands may target a client id; an untargeted command
 * is delivered to the first panel that polls. The latest state is returned for
 * agents that omit client_id, together with every panel's state. A bounded
 * event ledger records reports, commands and deliveries for observation; true
 * SessionEventMap integration remains deferred.
 */

const ACTIONS = new Set([
  'selectTab',
  'selectRow',
  'setFilters',
  'setPage',
  'setSort',
  'setWeak',
  'toggleNode',
  'selectObject',
  'selectClass',
  'openDump',
  'closeDump',
  'closeDrawer',
  'refresh',
  'runReport',
  'draftMessage',
  'notice',
])

const MAX_EVENTS = 200

function dumpKey(dumpId) {
  return dumpId === undefined || dumpId === null || dumpId === '' ? 'latest' : String(dumpId)
}

function panelKey(dumpId, clientId) {
  return `${dumpKey(dumpId)}\u0000${clientId ?? ''}`
}

export function createUiState() {
  const states = new Map()
  const queues = new Map()
  const events = new Map()
  const acks = new Map()
  let sequence = 0

  function record(dumpId, event) {
    const key = dumpKey(dumpId)
    const list = events.get(key) ?? []
    list.push({ ...event, at: new Date().toISOString() })
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS)
    events.set(key, list)
  }

  function setState(dumpId, clientId, state) {
    if (state === null || typeof state !== 'object') throw new Error('state must be an object')
    const text = JSON.stringify(state)
    if (text.length > 64 * 1024) throw new Error('state exceeds 65536 characters')
    const key = panelKey(dumpId, clientId)
    const recordValue = { state, updatedAt: new Date().toISOString(), client_id: clientId ?? null }
    states.set(key, recordValue)
    record(dumpId, { type: 'state', client_id: clientId ?? null })
    return { dump_id: dumpId ?? null, ...recordValue }
  }

  function getState(dumpId, clientId) {
    const key = dumpKey(dumpId)
    if (clientId !== undefined && clientId !== null) {
      const recordValue = states.get(panelKey(dumpId, clientId))
      const statuses = (acks.get(key) ?? []).filter((entry) => entry.client_id === clientId).slice(-10).reverse()
      const panels = recordValue === undefined ? [] : [{ ...recordValue, client_id: clientId }]
      if (recordValue === undefined) {
        return {
          dump_id: dumpId ?? null,
          state: null,
          updatedAt: null,
          client_id: clientId,
          panels,
          command_status: statuses,
        }
      }
      return { dump_id: dumpId ?? null, ...recordValue, panels, command_status: statuses }
    }
    const panels = []
    for (const [key2, recordValue] of states) {
      if (!key2.startsWith(`${key}\u0000`)) continue
      panels.push({ ...recordValue })
    }
    panels.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    const latest = panels[0]
    const statuses = (acks.get(key) ?? [])
      .filter((entry) => clientId === undefined || clientId === null || entry.client_id === clientId)
      .slice(-10)
      .reverse()
    return {
      dump_id: dumpId ?? null,
      state: latest?.state ?? null,
      updatedAt: latest?.updatedAt ?? null,
      client_id: latest?.client_id ?? null,
      panels,
      command_status: statuses,
    }
  }

  function command(dumpId, action, params, clientId) {
    const name = String(action ?? '')
    if (!ACTIONS.has(name)) throw new Error(`unknown UI action "${name}"`)
    const payload = params === null || typeof params !== 'object' ? {} : params
    const text = JSON.stringify(payload)
    if (text.length > 16 * 1024) throw new Error('command params exceed 16384 characters')
    const key = dumpKey(dumpId)
    const queue = queues.get(key) ?? []
    if (queue.length >= 100) throw new Error('UI command queue is full')
    const entry = {
      id: `ui-${++sequence}`,
      action: name,
      params: payload,
      dump_id: dumpId ?? null,
      client_id: clientId ?? null,
      createdAt: new Date().toISOString(),
    }
    queue.push(entry)
    queues.set(key, queue)
    record(dumpId, { type: 'command', command: entry })
    return entry
  }

  function ack(dumpId, clientId, commandId, status, error) {
    const key = dumpKey(dumpId)
    const entry = {
      command_id: String(commandId ?? ''),
      client_id: clientId ?? null,
      status: String(status ?? 'applied'),
      at: new Date().toISOString(),
    }
    if (error !== undefined && error !== null) entry.error = String(error)
    const list = acks.get(key) ?? []
    list.push(entry)
    if (list.length > 100) list.splice(0, list.length - 100)
    acks.set(key, list)
    record(dumpId, { type: 'ack', ...entry })
    return entry
  }

  function drain(dumpId, clientId) {
    const key = dumpKey(dumpId)
    const queue = queues.get(key) ?? []
    let selected
    let remaining
    if (clientId !== undefined && clientId !== null) {
      selected = queue.filter((entry) => entry.client_id === null || entry.client_id === clientId)
      remaining = queue.filter((entry) => entry.client_id !== null && entry.client_id !== clientId)
    } else {
      selected = queue
      remaining = []
    }
    if (remaining.length === 0) queues.delete(key)
    else queues.set(key, remaining)
    if (selected.length > 0) {
      record(dumpId, { type: 'deliver', client_id: clientId ?? null, command_ids: selected.map((entry) => entry.id) })
    }
    return { dump_id: dumpId ?? null, client_id: clientId ?? null, commands: selected }
  }

  function clear(dumpId, clientId) {
    const key = dumpKey(dumpId)
    if (clientId !== undefined && clientId !== null) {
      states.delete(panelKey(dumpId, clientId))
      return
    }
    for (const key2 of [...states.keys()]) {
      if (key2.startsWith(`${key}\u0000`)) states.delete(key2)
    }
    queues.delete(key)
    acks.delete(key)
  }

  function eventLog(dumpId, limit = 50) {
    const list = events.get(dumpKey(dumpId)) ?? []
    return { dump_id: dumpId ?? null, events: list.slice(-Math.min(200, Math.max(1, limit))) }
  }

  return { setState, getState, command, drain, ack, clear, eventLog, actions: [...ACTIONS] }
}
