/**
 * Native HPROF Explorer panel for the DeepSeek Harness Web UI.
 *
 * Plain-JS Client half: registers a right-Sidebar tab type, its body, a guide
 * entry, and a composer shortcut. The body is React (from the browser module
 * table) and talks to the Host plugin through same-origin `/hprof-api` routes;
 * it never embeds the standalone Web UI.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-hprof-explorer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const API = '/hprof-api'
    const UI_TABS = new Set([
      'overview', 'classes', 'retained', 'strings', 'roots', 'domtree', 'leaks',
      'findings', 'diff', 'instances', 'path', 'classpaths', 'referrers',
    ])
    const FILTER_TABS = new Set(['classes', 'instances', 'strings', 'roots', 'retained'])
    const ROW_TABS = new Set(['classes', 'instances', 'retained', 'strings', 'roots', 'referrers'])
    const PAGE_TABS = new Set(['instances', 'retained', 'strings', 'roots'])

    /**
     * Feature stylesheet. All colors come from theme tokens; hover and focus
     * states are the clickability signal, and regions get distinct tints.
     */
    const UI_CSS = `
.hp-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1.4; white-space: nowrap; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 1px color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); cursor: pointer; transition: background .12s ease, border-color .12s ease, color .12s ease, box-shadow .12s ease; }
.hp-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-2)); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-brand-primary); box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.hp-btn:active:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-2)); box-shadow: none; }
.hp-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); outline-offset: 1px; }
.hp-btn:disabled { opacity: .45; cursor: default; }
.hp-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent); }
.hp-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); filter: brightness(1.06); }
.hp-btn-primary:active:not(:disabled) { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); filter: brightness(.96); }
.hp-btn-sm { padding: 1px 7px; font-size: 11px; }
.hp-btn-ghost { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 5%, var(--dsw-alias-bg-layer-1)); border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); box-shadow: none; }
.hp-btn-ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, var(--dsw-alias-bg-layer-2)); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-brand-primary); }
.hp-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, var(--dsw-alias-bg-layer-1)); }
.hp-btn-danger:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-state-error-primary); }
.hp-segmented { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.hp-segment { padding: 3px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 11px; font-weight: 500; line-height: 1.4; white-space: nowrap; cursor: pointer; }
.hp-segment:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); color: var(--dsw-alias-brand-primary); }
.hp-segment-active { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.hp-segment-active:hover { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.hp-header { background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); box-shadow: inset 0 2px 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent); }
.hp-tabs { background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.hp-tab { flex: 0 0 auto; padding: 7px 12px; font-family: inherit; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary); border: 0; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0; background: transparent; cursor: pointer; white-space: nowrap; transition: background .12s ease, color .12s ease; }
.hp-tab:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.hp-tab-active { color: var(--dsw-alias-brand-primary); border-bottom-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
.hp-tab-active:hover { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 11%, transparent); }
.hp-row { transition: background .1s ease; }
.hp-row-click { cursor: pointer; }
.hp-row-click:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent); }
.hp-link { padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-weight: 500; text-align: left; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; cursor: pointer; }
.hp-link:hover { text-decoration-thickness: 2px; }
.hp-link:disabled { opacity: .45; cursor: default; text-decoration: none; }
.hp-link:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); outline-offset: 1px; border-radius: 3px; }
.hp-input, .hp-select, .hp-chat-input { font-family: inherit; }
.hp-input:focus, .hp-select:focus, .hp-chat-input:focus, .hp-filter-input:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); outline-offset: 1px; border-color: var(--dsw-alias-brand-primary); }
.hp-input::placeholder, .hp-filter-input::placeholder, .hp-chat-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: .8; }
.hp-section-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.hp-section-title::before { content: ''; width: 3px; height: 15px; border-radius: 2px; background: var(--dsw-alias-brand-primary); flex: 0 0 auto; }
.hp-page-header { margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.hp-page-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 16px; font-weight: 500; line-height: 1.35; color: var(--dsw-alias-label-primary); }
.hp-page-title::before { content: ''; width: 4px; height: 18px; border-radius: 2px; background: var(--dsw-alias-brand-primary); flex: 0 0 auto; }
.hp-th { background: var(--dsw-alias-bg-layer-2); }
.hp-th-filter { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, var(--dsw-alias-bg-layer-2)); }
.hp-table th, .hp-table td { border-right: 1px solid var(--dsw-alias-border-l2); }
.hp-table th:last-child, .hp-table td:last-child { border-right: 0; }
.hp-table thead th { border-bottom: 1px solid var(--dsw-alias-border-l2); }
.hp-table thead tr:first-child th { border-bottom: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l2)); }
.hp-table tbody tr:nth-child(even) { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 3%, transparent); }
.hp-table tbody tr.hp-row-click:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
.hp-table tbody tr.hp-row-selected { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.hp-table tbody tr.hp-row-selected td { color: var(--dsw-alias-label-primary); }
.hp-table tbody tr.hp-row-selected td:first-child { box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary); }
.hp-table tbody tr.hp-row-selected:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent); }
.hp-table tbody td:first-child { font-weight: 500; color: var(--dsw-alias-label-primary); }
.hp-table tbody td.hp-cell-strong { font-weight: 500; color: var(--dsw-alias-label-primary); }
.hp-row-actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; white-space: nowrap; }
.hp-action { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 22px; padding: 2px 9px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-brand-primary); font-family: inherit; font-size: 11px; font-weight: 500; line-height: 1.3; white-space: nowrap; cursor: pointer; transition: background .12s ease, border-color .12s ease, color .12s ease; }
.hp-action:hover { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.hp-action:active { filter: brightness(.95); }
.hp-action:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); outline-offset: 1px; }
.hp-action-quiet { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.hp-action-quiet:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.hp-tree { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.hp-tree-row { display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 3px 8px 3px 5px; border-radius: 5px; border-left: 3px solid transparent; color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 500; line-height: 1.45; transition: background .1s ease, border-color .1s ease; }
.hp-tree-row:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent); }
.hp-tree-row-depth-0 { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 5%, var(--dsw-alias-bg-layer-1)); border-left-color: var(--dsw-alias-brand-primary); }
.hp-tree-row-depth-1 { border-left-color: var(--dsw-alias-state-success-primary); }
.hp-tree-row-depth-2 { border-left-color: var(--dsw-alias-state-warn-primary); }
.hp-tree-row-depth-3 { border-left-color: var(--dsw-alias-label-secondary); }
.hp-tree-indents { display: inline-flex; align-self: stretch; flex: 0 0 auto; }
.hp-tree-indent { width: 14px; align-self: stretch; border-left: 1px solid var(--dsw-alias-border-l2); opacity: .75; }
.hp-tree-caret { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: 0 0 16px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer; }
.hp-tree-caret:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.hp-tree-caret:disabled { cursor: default; opacity: .55; }
.hp-tree-dot { width: 5px; height: 5px; flex: 0 0 5px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.hp-tree-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.hp-tree-via { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 400; }
.hp-tree-count { flex: 0 0 auto; margin-left: auto; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-secondary); font-size: 10px; font-weight: 500; white-space: nowrap; }
.hp-tree-name-button { min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-weight: 500; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.hp-tree-name-button:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline; text-underline-offset: 2px; }
.hp-tree-id { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; font-weight: 500; }
.hp-tree-metric { flex: 0 0 auto; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 10px; font-weight: 500; white-space: nowrap; }
.hp-tree-row-highlight { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, var(--dsw-alias-bg-layer-1)); border-left-color: var(--dsw-alias-brand-primary); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent); }
.hp-tree-row-highlight:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, var(--dsw-alias-bg-layer-1)); }
.hp-tree-row-highlight .hp-tree-count { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.hp-highlight-legend { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-brand-primary); font-size: 11px; font-weight: 500; white-space: nowrap; }
.hp-highlight-swatch { width: 7px; height: 7px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.hp-ref-type { display: inline-flex; padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 10px; font-weight: 500; }
.hp-suspect-card { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-left: 3px solid var(--dsw-alias-brand-primary); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); }
.hp-suspect-rank { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 20px; padding: 0 5px; border-radius: 999px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 11px; font-weight: 500; }
.hp-suspect-score { color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 500; }
.hp-suspect-reason { display: inline-flex; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-state-warn-primary); font-size: 10px; font-weight: 500; }
.hp-sync-status { padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 9px; font-weight: 500; white-space: nowrap; }
.hp-sync-status-error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-state-error-primary); }
.hp-filter { position: relative; display: flex; align-items: center; }
.hp-filter-icon { position: absolute; left: 5px; top: 50%; transform: translateY(-50%); width: 11px; height: 11px; color: var(--dsw-alias-label-secondary); pointer-events: none; }
.hp-filter-prefix { position: absolute; left: 5px; top: 50%; transform: translateY(-50%); font-size: 10px; line-height: 1; color: var(--dsw-alias-label-secondary); pointer-events: none; }
.hp-filter-input { width: 100%; box-sizing: border-box; padding: 2px 4px 2px 19px; font-family: inherit; font-size: 11px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.hp-filter-num .hp-filter-input { padding-left: 15px; }
.hp-card { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-top-width: 2px; border-radius: 8px; }
.hp-drawer { border-left: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, var(--dsw-alias-border-l1)); background: var(--dsw-alias-bg-layer-1); }
.hp-drawer-handle { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 2; }
.hp-drawer-handle:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); }
.hp-workspace-handle { flex: 0 0 6px; align-self: stretch; cursor: col-resize; background: var(--dsw-alias-border-l1); opacity: .45; transition: opacity .12s ease, background .12s ease; }
.hp-workspace-handle:hover { opacity: .9; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l1)); }
.hp-chat-head { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 7%, var(--dsw-alias-bg-layer-1)); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.hp-chat-handle { position: absolute; top: -3px; left: 0; right: 0; height: 6px; cursor: row-resize; z-index: 2; }
.hp-chat-handle:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); }
.hp-chat-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); flex: 0 0 auto; }
.hp-analysis-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary); flex: 0 0 auto; }
.hp-region-label { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
`

    /** Immutable per-dump detail results, keyed by request URL. */
    const DETAIL_CACHE = new Map()
    const DETAIL_CACHE_LIMIT = 400

    function cacheSet(url, data) {
      if (DETAIL_CACHE.size >= DETAIL_CACHE_LIMIT) {
        const oldest = DETAIL_CACHE.keys().next().value
        DETAIL_CACHE.delete(oldest)
      }
      DETAIL_CACHE.set(url, data)
    }

    function clearDetailCache() {
      DETAIL_CACHE.clear()
    }

    /** Panels that must refresh their dump list when the Host registry changes. */
    const dumpInvalidatedListeners = new Set()
    let dumpInvalidationScheduled = false

    /** Last successfully opened dump path, persisted for restart recovery. */
    const LAST_DUMP_KEY = 'hprof.lastDumpPath'
    let autoRestoreInFlight = null
    let autoRestoreDone = false

    function readLastDumpPath() {
      try {
        return localStorage.getItem(LAST_DUMP_KEY) ?? ''
      } catch {
        return ''
      }
    }

    function writeLastDumpPath(path) {
      try {
        localStorage.setItem(LAST_DUMP_KEY, path)
      } catch {
        // Storage can be unavailable in a restricted browser; restore is then skipped.
      }
    }

    function clearLastDumpPath() {
      try {
        localStorage.removeItem(LAST_DUMP_KEY)
      } catch {
        // Nothing to clear when storage is unavailable.
      }
    }

    function readViewState(base, table) {
      if (base === null || base === undefined || base === '') return {}
      try {
        const raw = localStorage.getItem(`hprof.view.${base}.${table}`)
        if (raw === null) return {}
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function writeViewState(base, table, patch) {
      if (base === null || base === undefined || base === '') return
      try {
        const current = readViewState(base, table)
        localStorage.setItem(`hprof.view.${base}.${table}`, JSON.stringify({ ...current, ...patch }))
      } catch {
        // Persistence is best-effort; the in-memory view still works.
      }
    }

    /** Coalesce several failed tabs into one dump-list refresh. */
    function notifyDumpInvalidated() {
      if (dumpInvalidationScheduled) return
      dumpInvalidationScheduled = true
      queueMicrotask(() => {
        dumpInvalidationScheduled = false
        for (const listener of [...dumpInvalidatedListeners]) {
          try {
            listener()
          } catch {
            // A panel that already unmounted must not break the other listeners.
          }
        }
      })
    }

    /**
     * Fetch one JSON route and expose loading/error/data. `cache: true` keeps
     * immutable detail results across tab and drawer remounts.
     */
    function useFetch(url, options = {}) {
      const useCache = options.cache === true
      const cached = useCache && url ? DETAIL_CACHE.get(url) : undefined
      const [state, setState] = useState(cached === undefined
        ? { loading: false, data: null, error: null }
        : { loading: false, data: cached, error: null })
      useEffect(() => {
        if (!url) {
          setState({ loading: false, data: null, error: null })
          return
        }
        if (useCache) {
          const hit = DETAIL_CACHE.get(url)
          if (hit !== undefined) {
            setState({ loading: false, data: hit, error: null })
            return
          }
        }
        let alive = true
        setState({ loading: true, data: null, error: null })
        fetch(url, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const text = await response.text()
            let body = null
            try {
              body = text === '' ? null : JSON.parse(text)
            } catch {
              body = null
            }
            if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`)
            return body
          })
          .then((data) => {
            if (useCache) cacheSet(url, data)
            if (alive) setState({ loading: false, data, error: null })
          })
          .catch((error) => {
            const message = String(error?.message ?? error)
            if (message.includes('unknown dump_id') || message.includes('no dump is open')) notifyDumpInvalidated()
            if (alive) setState({ loading: false, data: null, error: message })
          })
        return () => {
          alive = false
        }
      }, [url])
      return state
    }

    /** Delay a rapidly changing value to avoid a request per keystroke. */
    function useDebounced(value, ms) {
      const [debounced, setDebounced] = useState(value)
      useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), ms)
        return () => clearTimeout(timer)
      }, [value, ms])
      return debounced
    }

    /** Immediate filter inputs plus the debounced values a request uses. */
    function useFilters(initial) {
      const [filters, setFilters] = useState(initial)
      const key = JSON.stringify(filters)
      const debouncedKey = useDebounced(key, 300)
      const applied = useMemo(() => JSON.parse(debouncedKey), [debouncedKey])
      const set = useCallback((name, value) => {
        setFilters((current) => ({ ...current, [name]: value }))
      }, [])
      return { filters, applied, set, key: debouncedKey }
    }

    async function api(path, options = {}) {
      const response = await fetch(API + path, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      const text = await response.text()
      let data = null
      try {
        data = text === '' ? null : JSON.parse(text)
      } catch {
        data = null
      }
      if (!response.ok) throw new Error(data?.error ?? `${response.status} ${response.statusText}`)
      return data
    }

    const S = {
      header: {
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '8px 12px',
      },
      title: { fontWeight: 500, fontSize: 14, marginRight: 6, whiteSpace: 'nowrap' },
      tabs: {
        display: 'flex', gap: 2, padding: '6px 12px 0',
        overflowX: 'auto', flexWrap: 'nowrap',
      },
      input: {
        padding: '4px 8px', fontSize: 12, borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        minWidth: 180,
      },
      select: {
        padding: '4px 8px', fontSize: 12, borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        maxWidth: 260,
      },
      cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 10 },
      card: {
        padding: '8px 10px', borderRadius: 8,
      },
      cardLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 },
      cardValue: { fontSize: 16, fontWeight: 500 },
      section: { marginTop: 16 },
      sectionTitle: { fontSize: 14, marginBottom: 8 },
      tableWrap: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, overflow: 'hidden' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: {
        padding: '6px 8px', textAlign: 'left', fontWeight: 500, fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        position: 'sticky', top: 0, zIndex: 1,
      },
      thFilter: {
        padding: '2px 4px',
        position: 'sticky', top: 30, zIndex: 1,
      },
      scroll: { maxHeight: '58vh', overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 },
      chat: {
        position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0,
        borderTop: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
      },
      chatCollapsed: { height: 36 },
      chatHeader: { display: 'flex', gap: 8, alignItems: 'center', padding: '3px 10px', minHeight: 32 },
      chatLog: { flex: 1, overflow: 'auto', padding: '4px 10px', display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0 },
      chatUser: {
        alignSelf: 'flex-end', maxWidth: '85%', background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        padding: '4px 8px', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      chatAssistant: {
        alignSelf: 'flex-start', maxWidth: '92%', background: 'var(--dsw-alias-bg-layer-2)',
        padding: '4px 8px', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      chatTool: {
        alignSelf: 'flex-start', maxWidth: '92%', color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap',
      },
      chatError: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
      chatComposer: { display: 'flex', gap: 6, alignItems: 'flex-end', padding: '6px 10px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      chatInput: {
        flex: 1, resize: 'vertical', minHeight: 44, maxHeight: 120, padding: '4px 8px', fontSize: 12,
        borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
      },
      td: { padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', verticalAlign: 'top' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, fontWeight: 500 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, marginBottom: 8 },
      notice: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12, marginBottom: 8, wordBreak: 'break-all' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, marginBottom: 8 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      pre: {
        margin: 0, padding: 8, borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      chain: { margin: '6px 0 10px', padding: '6px 10px', borderLeft: '3px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l2))', borderRadius: '0 5px 5px 0', background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 3%, transparent)' },
      chainLine: { fontSize: 12, fontWeight: 500, lineHeight: 1.8, color: 'var(--dsw-alias-label-primary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
    }

    function Btn({ children, onClick, primary, danger, ghost, disabled, title, style }) {
      const className = ['hp-btn', primary ? 'hp-btn-primary' : '', danger ? 'hp-btn-danger' : '', ghost ? 'hp-btn-ghost' : '']
        .filter((name) => name !== '')
        .join(' ')
      return h('button', {
        type: 'button', className, onClick, disabled, title, style,
      }, children)
    }

    function SearchIcon() {
      return h('svg', {
        className: 'hp-filter-icon', viewBox: '0 0 16 16', width: 11, height: 11, fill: 'none', 'aria-hidden': true,
      },
        h('circle', { cx: 6.8, cy: 6.8, r: 4.2, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M10 10l3.2 3.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    function Section({ title, children, actions }) {
      return h('div', { style: S.section },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: S.sectionTitle, className: 'hp-section-title' }, title),
          actions),
        children)
    }

    function Table({ columns, rows, onRowClick, onRowSelect, selectedRowId, rowActions, empty, filters, virtual = false, rowHeight = 28, maxHeight = 520 }) {
      const [scrollTop, setScrollTop] = useState(0)
      const [selectedKey, setSelectedKey] = useState(null)
      const scrollRef = useRef(null)
      useEffect(() => {
        setScrollTop(0)
        if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
      }, [rows])
      const keyOf = (row) => row.id ?? row.name ?? row.className ?? null
      useEffect(() => {
        if (selectedKey === null) return
        if (rows.length === 0) return
        if (!rows.some((row) => keyOf(row) === selectedKey)) {
          setSelectedKey(null)
          onRowSelect?.(null)
        }
      }, [rows, selectedKey])
      useEffect(() => {
        if (selectedRowId === undefined) return
        setSelectedKey(selectedRowId === null ? null : selectedRowId)
      }, [selectedRowId])
      const actionable = onRowClick !== undefined
      const effectiveColumns = actionable
        ? [
          ...columns,
          {
            key: '__actions', title: '操作', align: 'right',
            render: (row) => h('div', { className: 'hp-row-actions' },
              typeof rowActions === 'function' ? rowActions(row) : null,
              h('button', {
                type: 'button',
                className: 'hp-action hp-action-quiet',
                title: '查看详情',
                onClick: (event) => {
                  event.stopPropagation()
                  setSelectedKey(keyOf(row))
                  onRowSelect?.(row)
                  onRowClick(row)
                },
                onDoubleClick: (event) => event.stopPropagation(),
              }, '查看')),
          },
        ]
        : columns
      const total = rows.length
      let start = 0
      let end = total
      if (virtual && total > 0) {
        start = Math.max(0, Math.floor(scrollTop / rowHeight) - 8)
        start = Math.min(start, Math.max(0, total - 1))
        end = Math.min(total, start + Math.ceil(maxHeight / rowHeight) + 16)
      }
      const visible = rows.slice(start, end)
      const table = h('table', { className: 'hp-table', style: S.table },
        h('thead', null,
          h('tr', null, effectiveColumns.map((column) => h('th', {
            key: column.key,
            className: 'hp-th',
            style: { ...S.th, textAlign: column.align ?? 'left' },
          }, column.title))),
          filters === undefined || filters === null
            ? null
            : h('tr', null, effectiveColumns.map((column, index) => {
              const filter = filters[index]
              if (filter === undefined || filter === null) {
                return h('th', { key: `${column.key}:filter`, className: 'hp-th-filter', style: S.thFilter })
              }
              const numeric = filter.type === 'number'
              return h('th', {
                key: `${column.key}:filter`,
                className: 'hp-th-filter',
                style: S.thFilter,
              }, h('div', { className: `hp-filter${numeric ? ' hp-filter-num' : ''}` },
                numeric ? h('span', { className: 'hp-filter-prefix' }, '≥') : h(SearchIcon),
                h('input', {
                  className: 'hp-filter-input',
                  value: filter.value ?? '',
                  placeholder: numeric ? (filter.placeholder ?? '最小') : (filter.placeholder ?? '搜索'),
                  'aria-label': `${column.title}${numeric ? '最小值' : '搜索'}`,
                  inputMode: numeric ? 'numeric' : undefined,
                  onChange: (event) => filter.onChange(event.target.value),
                })))
            }))),
        h('tbody', null,
          virtual && start > 0
            ? h('tr', { style: { height: start * rowHeight } }, h('td', { colSpan: effectiveColumns.length, style: { padding: 0, border: 'none' } }))
            : null,
          total === 0
            ? h('tr', null, h('td', { colSpan: effectiveColumns.length, style: { ...S.td, ...S.muted } }, empty ?? '—'))
            : visible.map((row, offset) => {
              const selected = selectedKey !== null && keyOf(row) === selectedKey
              return h('tr', {
                key: `${start + offset}:${row.id ?? row.name ?? ''}`,
                className: `hp-row${actionable ? ' hp-row-click' : ''}${selected ? ' hp-row-selected' : ''}`,
                title: actionable ? '点击选中，双击或点「查看」打开' : undefined,
                'aria-selected': selected,
                onClick: actionable
                  ? () => {
                    const key = keyOf(row)
                    const next = selectedKey === key ? null : key
                    setSelectedKey(next)
                    onRowSelect?.(next === null ? null : row)
                  }
                  : undefined,
                onDoubleClick: actionable
                  ? () => {
                    setSelectedKey(keyOf(row))
                    onRowSelect?.(row)
                    onRowClick(row)
                  }
                  : undefined,
              }, effectiveColumns.map((column) => h('td', {
                key: column.key,
                className: column.strong ? 'hp-cell-strong' : undefined,
                style: { ...S.td, textAlign: column.align ?? 'left', ...(virtual ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}) },
              }, column.render === undefined ? row[column.key] : column.render(row))))
            }),
          virtual && end < total
            ? h('tr', { style: { height: (total - end) * rowHeight } }, h('td', { colSpan: effectiveColumns.length, style: { padding: 0, border: 'none' } }))
            : null))
      if (!virtual) return h('div', { style: S.tableWrap }, table)
      return h('div', {
        ref: scrollRef,
        style: { ...S.scroll, maxHeight },
        onScroll: (event) => setScrollTop(event.currentTarget.scrollTop),
      }, table)
    }

    function formatBytes(value) {
      const number = Number(value) || 0
      if (number >= 1024 * 1024 * 1024) return `${(number / 1024 / 1024 / 1024).toFixed(2)} GB`
      if (number >= 1024 * 1024) return `${(number / 1024 / 1024).toFixed(2)} MB`
      if (number >= 1024) return `${(number / 1024).toFixed(1)} KB`
      return `${number} B`
    }

    function hexId(id) {
      return typeof id === 'number' ? `0x${id.toString(16)}` : String(id)
    }

    function card(label, value, tone = 'var(--dsw-alias-brand-primary)') {
      return h('div', { key: label, className: 'hp-card', style: { ...S.card, borderTopColor: tone } },
        h('div', { style: S.cardLabel }, label),
        h('div', { style: S.cardValue }, Number(value ?? 0).toLocaleString()))
    }

    function Overview({ dumpId, onClass, onObject, onSelectRow }) {
      const summary = useFetch(dumpId ? `${API}/summary?dump_id=${encodeURIComponent(dumpId)}` : null, { cache: true })
      const retained = useFetch(dumpId ? `${API}/retained?dump_id=${encodeURIComponent(dumpId)}&size=10` : null, { cache: true })
      if (summary.error !== null) return h('div', { style: S.error }, summary.error)
      if (summary.data === null) return h('div', { style: S.muted }, summary.loading ? '加载中…' : '没有打开的 dump')
      const data = summary.data
      const counts = data.counts ?? {}
      const rootRows = Object.entries(data.rootCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ type, count }))
      return h('div', null,
        h('div', { style: S.cards }, [
          card('类', counts.classes, 'var(--dsw-alias-brand-primary)'),
          card('实例', counts.instances, 'var(--dsw-alias-brand-primary)'),
          card('对象数组', counts.objectArrays, 'var(--dsw-alias-state-success-primary)'),
          card('基本类型数组', counts.primitiveArrays, 'var(--dsw-alias-state-success-primary)'),
          card('字符串', counts.stringInstances, 'var(--dsw-alias-state-warn-primary)'),
          card('GC Roots', counts.roots, 'var(--dsw-alias-state-idle-primary)'),
        ]),
        h('div', { style: S.hint },
          `文件 ${formatBytes(data.fileSize)} · 解析 ${data.parseMs} ms · 支配树 ${data.analyzeMs ?? data.analysis?.domMs ?? '?'} ms · `
          + `图 ${Number(data.analysis?.nodes ?? 0).toLocaleString()} 节点 / ${Number(data.analysis?.edges ?? 0).toLocaleString()} 边`),
        h(Section, { title: 'Top 类（按 shallow 字节）' }, h(Table, {
          columns: [
            { key: 'name', title: '类', render: (row) => h('span', { style: S.mono }, row.name) },
            { key: 'kind', title: '类型' },
            { key: 'count', title: '实例', align: 'right' },
            { key: 'bytes', title: '字节', align: 'right', render: (row) => formatBytes(row.bytes) },
          ],
          rows: data.topClasses ?? [],
          onRowClick: (row) => onClass(row),
          onRowSelect: (row) => onSelectRow?.('overview-classes', row),
        })),
        h(Section, { title: 'Top Retained 对象' },
          retained.error !== null
            ? h('div', { style: S.error }, retained.error)
            : h(Table, {
              columns: [
                { key: 'id', title: '对象', render: (row) => h('span', { style: S.mono }, hexId(row.id)) },
                { key: 'className', title: '类' },
                { key: 'retained', title: 'Retained', align: 'right', render: (row) => formatBytes(row.retained) },
                { key: 'shallow', title: 'Shallow', align: 'right', render: (row) => formatBytes(row.shallow) },
              ],
              rows: retained.data?.items ?? [],
              onRowClick: (row) => onObject(row.id),
              onRowSelect: (row) => onSelectRow?.('overview-retained', row),
            })),
        h(Section, { title: '根类型分布' }, h(Table, {
          columns: [
            { key: 'type', title: '根类型' },
            { key: 'count', title: '数量', align: 'right' },
          ],
          rows: rootRows,
          empty: '没有根',
        })),
        h(Section, { title: 'Top 字符串（按长度）' }, h(Table, {
          columns: [
            { key: 'id', title: '对象', render: (row) => h('span', { style: S.mono }, hexId(row.id)) },
            { key: 'length', title: '长度', align: 'right' },
            { key: 'text', title: '内容', strong: true, render: (row) => h('span', { style: { ...S.mono, whiteSpace: 'pre-wrap' } }, row.text) },
          ],
          rows: data.topStrings ?? [],
          onRowClick: (row) => onObject(row.id),
          onRowSelect: (row) => onSelectRow?.('overview-strings', row),
        })))
    }

    function ClassesTab({ dumpId, onClass, onClassPaths, onSelectRow, onFiltersChange, initialFilters, selectedRowId, initialSort, onViewChange }) {
      const [sort, setSort] = useState(initialSort ?? 'bytes')
      const [groupBy, setGroupBy] = useState('')
      const { filters, applied, set } = useFilters({ query: '', kind: '', minCount: '', minBytes: '', ...(initialFilters ?? {}) })
      useEffect(() => { onFiltersChange?.('classes', applied) }, [applied, onFiltersChange])
      useEffect(() => { onViewChange?.('classes', { sort, groupBy }) }, [sort, groupBy, onViewChange])
      const params = new URLSearchParams({ dump_id: dumpId ?? '', sort, limit: '200' })
      if (groupBy !== '') params.set('group_by', groupBy)
      if (applied.query !== '') params.set('query', applied.query)
      if (applied.kind !== '') params.set('kind', applied.kind)
      if (applied.minCount !== '' && Number.isFinite(Number(applied.minCount))) params.set('min_count', String(Number(applied.minCount)))
      if (applied.minBytes !== '' && Number.isFinite(Number(applied.minBytes))) params.set('min_bytes', String(Number(applied.minBytes)))
      const result = useFetch(dumpId ? `${API}/classes?${params}` : null)
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      const items = result.data?.items ?? []
      const grouped = groupBy !== ''
      const columns = grouped
        ? [
          { key: 'name', title: '分组', render: (row) => h('span', { style: S.mono }, row.name) },
          { key: 'classes', title: '类数', align: 'right' },
          { key: 'count', title: '实例', align: 'right' },
          { key: 'bytes', title: '字节', align: 'right', render: (row) => formatBytes(row.bytes) },
        ]
        : [
          { key: 'name', title: '类', render: (row) => h('span', { style: S.mono }, row.name) },
          { key: 'kind', title: '类型' },
          { key: 'count', title: '实例', align: 'right' },
          { key: 'bytes', title: '字节', align: 'right', render: (row) => formatBytes(row.bytes) },
        ]
      return h('div', null,
        h('div', { style: S.row },
          h('select', { className: 'hp-select', style: S.select, value: sort, onChange: (event) => setSort(event.target.value) },
            h('option', { value: 'bytes' }, '按字节'),
            h('option', { value: 'count' }, '按实例数'),
            h('option', { value: 'name' }, '按名称')),
          h('select', { className: 'hp-select', style: S.select, value: groupBy, onChange: (event) => setGroupBy(event.target.value) },
            h('option', { value: '' }, '按类'),
            h('option', { value: 'package' }, '按包'),
            h('option', { value: 'classloader' }, '按 ClassLoader'),
            h('option', { value: 'superclass' }, '按父类')),
          h('span', { style: S.muted }, result.loading ? '加载中…' : `${result.data?.total ?? 0} ${grouped ? '个分组' : '个类'} · 显示 ${items.length}`)),
        h(Section, { title: grouped ? '类分组' : '类' }, h(Table, {
          columns,
          filters: [
            { value: filters.query, onChange: (value) => set('query', value), placeholder: '搜索类名' },
            { value: filters.kind, onChange: (value) => set('kind', value), placeholder: '搜索类型' },
            { value: filters.minCount, onChange: (value) => set('minCount', value), placeholder: '最小实例', type: 'number' },
            { value: filters.minBytes, onChange: (value) => set('minBytes', value), placeholder: '最小字节', type: 'number' },
          ],
          rows: items,
          onRowClick: grouped ? undefined : (row) => onClass(row),
          onRowSelect: grouped ? undefined : (row) => onSelectRow?.('classes', row),
          selectedRowId: grouped ? null : selectedRowId,
          rowActions: grouped ? undefined : (row) => h('button', {
            type: 'button', className: 'hp-action',
            onClick: (event) => { event.stopPropagation(); onClassPaths(row) },
            onDoubleClick: (event) => event.stopPropagation(),
          }, 'GC 路径'),
          empty: grouped ? '没有匹配的分组' : '没有匹配的类',
        })))
    }

    function InstancesTab({ dumpId, classInfo, onObject, onPath, onBack, onSelectRow, onFiltersChange, initialFilters, selectedRowId, initialPage, onViewChange }) {
      const [page, setPage] = useState(initialPage ?? 0)
      const [sort, setSort] = useState('depth')
      const { filters, applied, set, key } = useFilters({ idPrefix: '', query: '', heap: '', minBytes: '', ...(initialFilters ?? {}) })
      const firstClassRef = useRef(true)
      const firstFilterRef = useRef(true)
      useEffect(() => {
        if (firstClassRef.current) { firstClassRef.current = false; return }
        setPage(0)
      }, [classInfo])
      useEffect(() => {
        if (firstFilterRef.current) { firstFilterRef.current = false; return }
        setPage(0)
      }, [key])
      useEffect(() => { onFiltersChange?.('instances', applied) }, [applied, onFiltersChange])
      useEffect(() => { onViewChange?.('instances', { page, sort }) }, [page, sort, onViewChange])
      const params = new URLSearchParams({ dump_id: dumpId ?? '', class_id: String(classInfo?.id ?? ''), kind: classInfo?.kind ?? 'class', page: String(page), size: '200', sort })
      if (applied.idPrefix !== '') params.set('id_prefix', applied.idPrefix)
      if (applied.query !== '') params.set('query', applied.query)
      if (applied.heap !== '') params.set('heap', applied.heap)
      if (applied.minBytes !== '' && Number.isFinite(Number(applied.minBytes))) params.set('min_bytes', String(Number(applied.minBytes)))
      const result = useFetch(dumpId && classInfo ? `${API}/instances?${params}` : null)
      if (classInfo === null) return h('div', { style: S.muted }, '请选择类')
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      const items = result.data?.items ?? []
      const total = result.data?.total ?? 0
      return h('div', null,
        h('div', { style: S.row },
          h(Btn, { onClick: onBack }, '← 返回'),
          h('span', { style: { ...S.mono, fontWeight: 500 } }, classInfo.name),
          h('span', { style: S.muted }, `${total.toLocaleString()} 个对象`),
          h('select', {
            className: 'hp-select', style: S.select, value: sort,
            onChange: (event) => { setPage(0); setSort(event.target.value) },
          },
            h('option', { value: 'depth' }, '引用深度（深→浅）'),
            h('option', { value: 'default' }, '堆顺序'))),
        h(Section, { title: '对象' }, h(Table, {
          columns: [
            { key: 'id', title: '对象', render: (row) => h('span', { style: S.mono }, hexId(row.id)) },
            { key: 'className', title: '类' },
            { key: 'heap', title: '堆' },
            { key: 'depth', title: '引用深度', align: 'right', render: (row) => row.depth >= 0 ? row.depth : '—' },
            { key: 'size', title: 'Shallow', align: 'right', render: (row) => formatBytes(row.size) },
          ],
          filters: [
            { value: filters.idPrefix, onChange: (value) => set('idPrefix', value), placeholder: '搜索 ID' },
            { value: filters.query, onChange: (value) => set('query', value), placeholder: '搜索类名' },
            { value: filters.heap, onChange: (value) => set('heap', value), placeholder: '搜索堆' },
            { value: filters.minBytes, onChange: (value) => set('minBytes', value), placeholder: '最小字节', type: 'number' },
          ],
          rows: items,
          onRowClick: (row) => onObject(row.id),
          onRowSelect: (row) => onSelectRow?.('instances', row),
          selectedRowId,
          rowActions: (row) => h('button', {
            type: 'button', className: 'hp-action',
            onClick: (event) => { event.stopPropagation(); onPath(row.id) },
          }, 'GC 路径'),
          empty: '没有对象',
        })),
        h('div', { style: { ...S.row, marginTop: 8 } },
          h(Btn, { onClick: () => setPage((value) => Math.max(0, value - 1)), disabled: page === 0 }, '上一页'),
          h('span', { style: S.muted }, `第 ${page + 1} 页`),
          h(Btn, { onClick: () => setPage((value) => value + 1), disabled: (page + 1) * 200 >= total }, '下一页')))
    }

    function ObjectDetail({ dumpId, objectId, onObject, onPath, onClassPaths, onReferrers, onDomTree }) {
      const result = useFetch(dumpId && objectId !== null
        ? `${API}/object?dump_id=${encodeURIComponent(dumpId)}&id=${objectId}`
        : null, { cache: true })
      if (objectId === null) return h('div', { style: S.muted }, '请选择对象')
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      if (result.data === null) return h('div', { style: S.muted }, '加载中…')
      const data = result.data
      const retained = data.retained
      const isClass = data.kind === 'class'
      return h('div', null,
        h('div', { style: S.row },
          h('span', { style: { ...S.mono, fontWeight: 500 } }, data.className ?? data.class?.name ?? hexId(objectId)),
          h('span', { style: S.muted }, `${data.kind} · ${data.heap ?? ''}`)),
        h('div', { style: { ...S.cards, marginTop: 8 } }, [
          card('Shallow', formatBytes(retained?.shallow ?? data.size), 'var(--dsw-alias-state-idle-primary)'),
          card('Retained', formatBytes(retained?.retained), 'var(--dsw-alias-state-success-primary)'),
          card('支配子节点', retained?.children ?? 0, 'var(--dsw-alias-brand-primary)'),
        ]),
        h('div', { style: { ...S.row, marginBottom: 8 } },
          h(Btn, { onClick: () => onPath(objectId) }, 'GC 路径'),
          h(Btn, { onClick: () => onReferrers(objectId) }, '引用查询'),
          h(Btn, { onClick: () => onDomTree(objectId) }, '支配子树'),
          isClass ? h(Btn, { onClick: () => onClassPaths({ id: objectId, name: data.class?.name, kind: 'class' }) }, '类 GC 路径') : null),
        retained?.dominator
          ? h('div', { style: S.hint },
            '直接支配者：',
            h('button', { type: 'button', className: 'hp-link', onClick: () => onObject(retained.dominator.id) },
              `${retained.dominator.className} @ ${hexId(retained.dominator.id)}`))
          : null,
        isClass ? classView(data.class, onObject) : instanceView(data, onObject))
    }

    /** Resizable right drawer used for object details. */
    function Drawer({ width, onResizeStart, onClose, onBack, canBack, children }) {
      return h('div', {
        className: 'hp-drawer',
        style: {
          position: 'relative', flex: `0 0 ${width}px`, width, maxWidth: '75%', minWidth: 320,
          display: 'flex', flexDirection: 'column', minHeight: 0,
        },
      },
        h('div', {
          className: 'hp-drawer-handle', onMouseDown: onResizeStart,
          role: 'separator', 'aria-orientation': 'vertical', title: '拖动调整宽度',
        }),
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
          },
        },
          h('span', { style: { fontWeight: 500, fontSize: 12 } }, '对象详情'),
          canBack ? h(Btn, { onClick: onBack, ghost: true, title: '返回上一个对象' }, '←') : null,
          h('span', { style: { flex: 1 } }),
          h(Btn, { onClick: onClose, ghost: true, title: '关闭详情' }, '×')),
        h('div', { style: { flex: 1, overflow: 'auto', padding: 10, minHeight: 0 } }, children))
    }

    function classView(info, onObject) {
      if (info === undefined) return null
      return h('div', null,
        h(Section, { title: '类信息' }, h('div', { style: S.pre }, [
          `id: ${hexId(info.id)}`,
          `super: ${info.superName ?? '—'}`,
          `instanceSize: ${info.instanceSize}`,
          `count: ${info.count}  bytes: ${info.bytes}`,
        ].join('\n'))),
        h(Section, { title: `静态字段 (${info.statics?.length ?? 0})` }, h(Table, {
          columns: [
            { key: 'name', title: '字段', render: (row) => h('span', { style: S.mono }, row.name) },
            { key: 'typeName', title: '类型' },
            { key: 'value', title: '值', render: (row) => valueCell(row.value, onObject) },
          ],
          rows: info.statics ?? [],
        })),
        h(Section, { title: `实例字段 (${info.fields?.length ?? 0})` }, h(Table, {
          columns: [
            { key: 'name', title: '字段', render: (row) => h('span', { style: S.mono }, row.name) },
            { key: 'typeName', title: '类型' },
          ],
          rows: info.fields ?? [],
        })))
    }

    function instanceView(data, onObject) {
      if (data.kind === 'instance') {
        return h('div', null,
          data.string !== undefined && data.string !== null
            ? h(Section, { title: data.stringBinary ? 'String（二进制内容）' : 'String' },
              h('div', { style: S.pre }, data.string))
            : null,
          h(Section, { title: `字段 (${data.fields?.length ?? 0})` }, h(Table, {
            columns: [
              { key: 'name', title: '字段', render: (row) => h('span', { style: S.mono }, row.weak ? `${row.name} (weak)` : row.name) },
              { key: 'type', title: '类型' },
              { key: 'value', title: '值', render: (row) => valueCell(row.value, onObject) },
            ],
            rows: data.fields ?? [],
          })))
      }
      if (data.kind === 'objectArray') {
        return h(Section, { title: `元素 (${data.length})` }, h(Table, {
          columns: [
            { key: 'index', title: '#', render: (row) => row.index, align: 'right' },
            { key: 'value', title: '值', render: (row) => valueCell(row.value, onObject) },
          ],
          rows: (data.elements ?? []).map((value, index) => ({ index, value })),
        }))
      }
      if (data.kind === 'primitiveArray') {
        return h(Section, { title: `${data.elementType}[] (${data.length})` },
          h('div', { style: S.pre }, (data.values ?? []).join(', ')))
      }
      if (data.string !== undefined && data.string !== null) {
        return h(Section, { title: 'String' }, h('div', { style: S.pre }, data.string))
      }
      return h('div', { style: S.muted }, '没有可显示的字段')
    }

    function valueCell(value, onObject) {
      if (value !== null && typeof value === 'object' && typeof value.id === 'number') {
        return h('button', {
          type: 'button', className: 'hp-link',
          onClick: () => onObject(value.id),
        }, `${value.name ?? value.kind ?? 'object'} @ ${hexId(value.id)}`)
      }
      if (typeof value === 'string') return h('span', { style: { ...S.mono, whiteSpace: 'pre-wrap' } }, value)
      return h('span', { style: S.mono }, String(value))
    }

    function PathTab({ dumpId, objectId, onBack }) {
      const [weak, setWeak] = useState(false)
      const [allPaths, setAllPaths] = useState(false)
      const [excludeClasses, setExcludeClasses] = useState('')
      const [excludeFields, setExcludeFields] = useState('')
      const query = new URLSearchParams({
        dump_id: dumpId ?? '',
        id: String(objectId ?? ''),
      })
      if (weak) query.set('weak', '1')
      if (allPaths) query.set('all', '1')
      if (excludeClasses.trim() !== '') query.set('exclude_classes', excludeClasses.trim())
      if (excludeFields.trim() !== '') query.set('exclude_fields', excludeFields.trim())
      const result = useFetch(dumpId && objectId !== null
        ? `${API}/path?${query}`
        : null, { cache: true })
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      const data = result.data
      const paths = data?.paths?.length > 0
        ? data.paths
        : (data?.found === true ? [{ path: data.path, distance: data.distance }] : [])
      return h('div', null,
        h('div', { style: S.row },
          h(Btn, { onClick: onBack }, '← 返回'),
          h('span', { style: S.muted }, objectId === null ? '' : hexId(objectId)),
          h('label', { style: { ...S.muted, display: 'flex', gap: 4, alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: weak, onChange: (event) => setWeak(event.target.checked) }),
            '包含弱引用'),
          h('label', { style: { ...S.muted, display: 'flex', gap: 4, alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: allPaths, onChange: (event) => setAllPaths(event.target.checked) }),
            '全部路径')),
        h('div', { style: S.row },
          h('input', {
            className: 'hp-input', style: { ...S.input, minWidth: 180 }, value: excludeClasses,
            placeholder: '排除类，逗号分隔', 'aria-label': '排除类',
            onChange: (event) => setExcludeClasses(event.target.value),
          }),
          h('input', {
            className: 'hp-input', style: { ...S.input, minWidth: 180 }, value: excludeFields,
            placeholder: '排除字段，逗号分隔', 'aria-label': '排除字段',
            onChange: (event) => setExcludeFields(event.target.value),
          }),
          h('span', { style: S.hint },
            `${paths.length} 条路径${data?.truncated ? ' · 已截断' : ''}`)),
        data === null
          ? h('div', { style: S.muted }, '加载中…')
          : data.found === false
            ? h('div', { style: S.muted }, '在强引用视图中不可达（可尝试包含弱引用，或移除排除条件）')
            : h('div', null,
              h('div', { style: S.hint }, `距离 ${paths[0]?.distance ?? data.distance} 跳`),
              paths.map((item, pathIndex) => h(Section, {
                key: pathIndex,
                title: `路径 ${pathIndex + 1} · ${item.distance} 跳`,
              }, h('div', { style: S.chain }, (item.path ?? []).map((step, index) => h('div', {
                key: `${step.id}-${index}`, style: S.chainLine,
              }, `${index === 0 ? '' : '↳ '}${step.className}${step.id === 0 ? '' : ` @ ${hexId(step.id)}`}${step.via ? `  —(${step.via})→` : ''}`)))))))
    }

    function ClassPathsTab({ dumpId, classInfo, onBack, onObject, treeCommand, onTreeChange, weakRequest, onStateChange }) {
      const PAGE_SIZE = 10
      const UNREACHABLE_SIZE = 50
      const [weak, setWeak] = useState(false)
      const [mode, setMode] = useState('tree')
      const [highlightKey, setHighlightKey] = useState(null)
      const [highlightCount, setHighlightCount] = useState(0)
      const [collapsed, setCollapsed] = useState(() => new Set())
      const [page, setPage] = useState(0)
      const [showUnreachable, setShowUnreachable] = useState(true)
      const [unreachablePage, setUnreachablePage] = useState(0)
      useEffect(() => {
        if (weakRequest === null || weakRequest === undefined) return
        if (typeof weakRequest.weak === 'boolean') setWeak(weakRequest.weak)
      }, [weakRequest])
      const result = useFetch(dumpId && classInfo
        ? `${API}/classpaths?dump_id=${encodeURIComponent(dumpId)}&class_id=${classInfo.id}&kind=${classInfo.kind ?? 'class'}&page=${page}&size=${PAGE_SIZE}${weak ? '&weak=1' : ''}`
        : null, { cache: true })
      const data = result.data
      useEffect(() => {
        if (mode !== 'tree' || data === null) {
          setHighlightKey(null)
          setHighlightCount(0)
          return
        }
        const groups = data.groups ?? []
        if (groups.length === 0) {
          setHighlightKey(null)
          setHighlightCount(0)
          return
        }
        let best = groups[0]
        for (const group of groups) {
          if ((group.count ?? 0) > (best.count ?? 0)) best = group
        }
        const steps = best.steps ?? []
        if (steps.length === 0) {
          setHighlightKey(null)
          setHighlightCount(0)
          return
        }
        const prefixes = []
        let prefix = ''
        for (const step of steps) {
          const part = `${step.className}\u0000${step.via ?? ''}`
          prefix = prefix === '' ? part : `${prefix}\u0000${part}`
          prefixes.push(prefix)
        }
        setHighlightKey(prefix)
        setHighlightCount(best.count ?? 0)
        setCollapsed((current) => {
          const next = new Set(current)
          for (const value of prefixes) next.delete(value)
          return next
        })
      }, [data, mode])
      useEffect(() => {
        onStateChange?.({
          weak,
          page,
          groupCount: data?.groupCount ?? 0,
          reachable: data?.reachable ?? 0,
          unreachable: data?.unreachable ?? 0,
          showUnreachable,
          unreachablePage,
          highlightCount,
        })
      }, [onStateChange, weak, page, data?.groupCount, data?.reachable, data?.unreachable, showUnreachable, unreachablePage, highlightCount])
      const treeCommandRef = useRef(null)
      useEffect(() => {
        setPage(0)
        setUnreachablePage(0)
        setCollapsed(new Set())
      }, [classInfo, weak])
      useEffect(() => {
        onTreeChange?.([...collapsed])
      }, [collapsed, onTreeChange])
      useEffect(() => {
        if (treeCommand === null || treeCommand === undefined) return
        if (treeCommand.view !== 'classpaths') return
        if (data === null) return
        if (treeCommandRef.current === treeCommand) return
        let key = typeof treeCommand.key === 'string' ? treeCommand.key : null
        if (key === null && Number.isSafeInteger(treeCommand.index)) {
          const rows = flattenClassPathTree(data.groups ?? [], collapsed)
          key = rows[treeCommand.index]?.key ?? null
        }
        treeCommandRef.current = treeCommand
        if (key === null) return
        setCollapsed((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }, [treeCommand, data])
      if (classInfo === null) return h('div', { style: S.muted }, '请选择类')
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      const treeRows = data === null ? [] : flattenClassPathTree(data.groups ?? [], collapsed)
      const unreachableItems = data?.unreachableItems ?? []
      const unreachableSlice = unreachableItems.slice(
        unreachablePage * UNREACHABLE_SIZE,
        (unreachablePage + 1) * UNREACHABLE_SIZE,
      )
      const groupPages = Math.max(1, Math.ceil((data?.groupCount ?? 0) / PAGE_SIZE))
      const unreachablePages = Math.max(1, Math.ceil(unreachableItems.length / UNREACHABLE_SIZE))
      const toggleNode = (key) => setCollapsed((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      return h('div', null,
        h('div', { style: S.row },
          h(Btn, { onClick: onBack }, '← 返回'),
          h('span', { style: { ...S.mono, fontWeight: 500 } }, classInfo.name),
          h('label', { style: { ...S.muted, display: 'flex', gap: 4, alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: weak, onChange: (event) => setWeak(event.target.checked) }),
            '包含弱引用'),
          h('div', { className: 'hp-segmented', role: 'group', 'aria-label': '类路径视图' },
            h('button', {
              type: 'button', className: `hp-segment${mode === 'tree' ? ' hp-segment-active' : ''}`,
              'aria-pressed': mode === 'tree',
              onClick: () => setMode('tree'),
            }, '树形'),
            h('button', {
              type: 'button', className: `hp-segment${mode === 'text' ? ' hp-segment-active' : ''}`,
              'aria-pressed': mode === 'text',
              onClick: () => setMode('text'),
            }, '文本')),
          mode === 'tree' && highlightCount > 0
            ? h('span', { className: 'hp-highlight-legend', title: '自动高亮当前页按完整路径分组后实例最多的单条 GC 路径' },
              h('span', { className: 'hp-highlight-swatch', 'aria-hidden': true }),
              `当前页最大单链 ${highlightCount} 个`)
            : null),
        data === null
          ? h('div', { style: S.muted }, '加载中…')
          : h('div', null,
            h('div', { style: S.hint },
              `${data.totalObjects} 个对象 · 可达 ${data.reachable} · 不可达 ${data.unreachable} · ${data.groupCount} 组`
              + (data.sampled ? ' · 已采样' : '')),
            mode === 'tree'
              ? h('div', { className: 'hp-tree' }, treeRows.map((row) => {
                const tone = row.depth === 0
                  ? 'var(--dsw-alias-brand-primary)'
                  : row.depth === 1
                    ? 'var(--dsw-alias-state-success-primary)'
                    : row.depth === 2
                      ? 'var(--dsw-alias-state-warn-primary)'
                      : 'var(--dsw-alias-label-secondary)'
                const highlighted = highlightKey !== null
                  && (row.key === highlightKey || highlightKey.startsWith(`${row.key}\u0000`))
                return h('div', {
                  key: row.key,
                  className: `hp-tree-row hp-tree-row-depth-${Math.min(row.depth, 3)}${highlighted ? ' hp-tree-row-highlight' : ''}`,
                },
                  row.depth > 0
                    ? h('span', { className: 'hp-tree-indents', 'aria-hidden': true },
                      Array.from({ length: row.depth }, (_, index) => h('span', { key: index, className: 'hp-tree-indent' })))
                    : null,
                  h('button', {
                    type: 'button', className: 'hp-tree-caret', disabled: !row.hasChildren,
                    'aria-label': row.hasChildren ? (collapsed.has(row.key) ? '展开节点' : '折叠节点') : undefined,
                    onClick: () => toggleNode(row.key),
                  }, row.hasChildren ? (collapsed.has(row.key) ? '▸' : '▾') : '·'),
                  h('span', { className: 'hp-tree-dot', style: { background: tone }, 'aria-hidden': true }),
                  h('span', { className: 'hp-tree-name' }, row.className),
                  row.via ? h('span', { className: 'hp-tree-via' }, `— ${row.via} →`) : null,
                  h('span', { className: 'hp-tree-count' }, `${row.count} 个对象`))
              }))
              : (data.groups ?? []).map((group, index) => h('div', { key: index, style: { marginBottom: 10 } },
                h('div', { style: S.muted }, `${group.count} 个对象 · shallow ${formatBytes(group.shallow)}`),
                h('div', { style: S.chain }, (group.steps ?? []).map((step, stepIndex) => h('div', {
                  key: stepIndex, style: S.chainLine,
                }, `${stepIndex === 0 ? '' : '↳ '}${step.className}${step.via ? `  —(${step.via})→` : ''}`))))),
            h('div', { style: { ...S.row, marginTop: 8 } },
              h(Btn, { onClick: () => setPage((value) => Math.max(0, value - 1)), disabled: page === 0 }, '上一页'),
              h('span', { style: S.muted }, `第 ${page + 1} / ${groupPages} 页`),
              h(Btn, { onClick: () => setPage((value) => value + 1), disabled: !data.hasMore }, '下一页'),
              h('span', { style: S.muted }, `本页 ${data.groups?.length ?? 0} 组`)),
            h('div', { style: { marginTop: 14, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } },
              h('div', { style: S.row },
                h('span', { style: { fontWeight: 500 } }, `不可达对象 · ${data.unreachable}`),
                h(Btn, { ghost: true, onClick: () => setShowUnreachable((value) => !value) },
                  showUnreachable ? '收起' : '展开'),
                h('span', { style: S.hint },
                  data.unreachable === 0
                    ? '没有不可达对象'
                    : '这些对象没有强/弱 GC Root 路径，不会出现在上面的树里；只能作为对象查看。')),
              showUnreachable && data.unreachable > 0
                ? (unreachableItems.length === 0
                  ? h('div', { style: S.muted }, '引擎没有返回不可达对象明细。')
                  : h('div', null,
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 } },
                      unreachableSlice.map((item) => h('div', {
                        key: item.id,
                        style: { ...S.row, padding: '2px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
                      },
                        h('span', { style: { ...S.mono, minWidth: 100 } }, hexId(item.id)),
                        h('span', { style: { ...S.muted, minWidth: 80 } }, item.shallow === null ? '—' : formatBytes(item.shallow)),
                        h('button', {
                          type: 'button', className: 'hp-action hp-action-quiet',
                          onClick: () => onObject(item.id),
                        }, '查看')))),
                    h('div', { style: { ...S.row, marginTop: 6 } },
                      h(Btn, { onClick: () => setUnreachablePage((value) => Math.max(0, value - 1)), disabled: unreachablePage === 0 }, '上一页'),
                      h('span', { style: S.muted }, `第 ${unreachablePage + 1} / ${unreachablePages} 页`),
                      h(Btn, { onClick: () => setUnreachablePage((value) => value + 1), disabled: unreachablePage + 1 >= unreachablePages }, '下一页'))))
                : null)
          ))
    }

    /** Merge GC-root path groups into one indented prefix tree. */
    function flattenClassPathTree(groups, collapsed) {
      const root = { children: new Map() }
      for (const group of groups) {
        let node = root
        for (const step of group.steps ?? []) {
          const key = `${step.className}\u0000${step.via ?? ''}`
          let child = node.children.get(key)
          if (child === undefined) {
            child = { className: step.className, via: step.via ?? null, count: 0, children: new Map() }
            node.children.set(key, child)
          }
          child.count += group.count ?? 0
          node = child
        }
      }
      const rows = []
      const walk = (node, depth, prefix) => {
        for (const [key, child] of node.children) {
          const rowKey = prefix === '' ? key : `${prefix}\u0000${key}`
          rows.push({
            key: rowKey,
            depth,
            className: child.className,
            via: child.via,
            count: child.count,
            hasChildren: child.children.size > 0,
          })
          if (!collapsed.has(rowKey)) walk(child, depth + 1, rowKey)
        }
      }
      walk(root, 0, '')
      return rows
    }

    function DiffTab({ dumps, initialBase, initialOther }) {
      const [base, setBase] = useState(initialBase ?? '')
      const [other, setOther] = useState(initialOther ?? '')
      useEffect(() => {
        if (base === '' && dumps.length > 0) setBase(dumps[0].dump_id)
        if (other === '' && dumps.length > 1) setOther(dumps[1].dump_id)
      }, [dumps, base, other])
      const result = useFetch(base && other && base !== other
        ? `${API}/diff?base=${encodeURIComponent(base)}&other=${encodeURIComponent(other)}`
        : null)
      return h('div', null,
        h('div', { style: S.row },
          h('span', { style: S.muted }, '基线'),
          h('select', { className: 'hp-select', style: S.select, value: base, onChange: (event) => setBase(event.target.value) },
            dumps.map((dump) => h('option', { key: dump.dump_id, value: dump.dump_id }, dump.dump_id))),
          h('span', { style: S.muted }, '对比'),
          h('select', { className: 'hp-select', style: S.select, value: other, onChange: (event) => setOther(event.target.value) },
            dumps.map((dump) => h('option', { key: dump.dump_id, value: dump.dump_id }, dump.dump_id)))),
        result.error !== null ? h('div', { style: S.error }, result.error) : null,
        result.data === null
          ? h('div', { style: S.muted }, '选择两个 dump 后显示差分')
          : h('div', null,
            h(Section, { title: '计数变化' }, h(Table, {
              columns: [
                { key: 'name', title: '指标' },
                { key: 'base', title: '基线', align: 'right' },
                { key: 'other', title: '对比', align: 'right' },
                { key: 'delta', title: 'Δ', align: 'right', render: (row) => (row.delta > 0 ? `+${row.delta}` : row.delta) },
              ],
              rows: Object.entries(result.data.counts ?? {}).map(([name, value]) => ({ name, ...value })),
            })),
            h(Section, { title: '增长最多的类' }, h(Table, {
              columns: [
                { key: 'name', title: '类', render: (row) => h('span', { style: S.mono }, row.name) },
                { key: 'delta_instances', title: 'Δ 实例', align: 'right' },
                { key: 'delta_bytes', title: 'Δ 字节', align: 'right', render: (row) => formatBytes(row.delta_bytes) },
              ],
              rows: result.data.top_growth ?? [],
              empty: '没有增长',
            })),
            h(Section, { title: '新增类' }, h(Table, {
              columns: [
                { key: 'name', title: '类', render: (row) => h('span', { style: S.mono }, row.name) },
                { key: 'other_instances', title: '实例', align: 'right' },
                { key: 'other_bytes', title: '字节', align: 'right', render: (row) => formatBytes(row.other_bytes) },
              ],
              rows: (result.data.new_classes ?? []).slice(0, 10),
              empty: '没有新增类',
            })))
      )
    }

    function StringsTab({ dumpId, onObject, onSelectRow, onFiltersChange, initialFilters, selectedRowId, initialPage, onViewChange }) {
      const [readable, setReadable] = useState(true)
      const [page, setPage] = useState(initialPage ?? 0)
      const { filters, applied, set, key } = useFilters({ idPrefix: '', query: '', minLength: '', ...(initialFilters ?? {}) })
      const firstResetRef = useRef(true)
      useEffect(() => {
        if (firstResetRef.current) { firstResetRef.current = false; return }
        setPage(0)
      }, [key, readable])
      useEffect(() => { onFiltersChange?.('strings', applied) }, [applied, onFiltersChange])
      useEffect(() => { onViewChange?.('strings', { page }) }, [page, onViewChange])
      const params = new URLSearchParams({ dump_id: dumpId ?? '', page: String(page), size: '100' })
      if (applied.idPrefix !== '') params.set('id_prefix', applied.idPrefix)
      if (applied.query !== '') params.set('query', applied.query)
      if (applied.minLength !== '' && Number.isFinite(Number(applied.minLength))) params.set('min_length', String(Number(applied.minLength)))
      if (readable) params.set('readable', '1')
      const result = useFetch(dumpId ? `${API}/strings?${params}` : null)
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      const items = result.data?.items ?? []
      const total = result.data?.total ?? 0
      return h('div', null,
        h('div', { style: S.row },
          h('label', { style: { ...S.muted, display: 'flex', gap: 4, alignItems: 'center' } },
            h('input', {
              type: 'checkbox', checked: readable,
              onChange: (event) => setReadable(event.target.checked),
            }),
            '只看可读文本'),
          h('span', { style: S.muted }, result.loading ? '加载中…' : `${total.toLocaleString()} 条`)),
        h(Section, { title: '字符串' }, h(Table, {
          columns: [
            { key: 'id', title: '对象', render: (row) => h('span', { style: S.mono }, hexId(row.id)) },
            { key: 'length', title: '长度', align: 'right' },
            {
              key: 'text', title: '内容', strong: true,
              render: (row) => h('span', { style: { ...S.mono, whiteSpace: 'pre-wrap' } }, row.binary ? `${row.text} [binary]` : row.text),
            },
          ],
          filters: [
            { value: filters.idPrefix, onChange: (value) => set('idPrefix', value), placeholder: '搜索 ID' },
            { value: filters.minLength, onChange: (value) => set('minLength', value), placeholder: '最小长度', type: 'number' },
            { value: filters.query, onChange: (value) => set('query', value), placeholder: '搜索内容' },
          ],
          rows: items,
          onRowClick: (row) => onObject(row.id),
          onRowSelect: (row) => onSelectRow?.('strings', row),
          selectedRowId,
          empty: '没有匹配的字符串',
        })),
        h('div', { style: { ...S.row, marginTop: 8 } },
          h(Btn, { onClick: () => setPage((value) => Math.max(0, value - 1)), disabled: page === 0 }, '上一页'),
          h('span', { style: S.muted }, `第 ${page + 1} 页`),
          h(Btn, { onClick: () => setPage((value) => value + 1), disabled: (page + 1) * 100 >= total }, '下一页')))
    }

    function RootsTab({ dumpId, onObject, onSelectRow, onFiltersChange, initialFilters, selectedRowId, initialPage, onViewChange }) {
      const [page, setPage] = useState(initialPage ?? 0)
      const { filters, applied, set, key } = useFilters({ idPrefix: '', type: '', query: '', heap: '', ...(initialFilters ?? {}) })
      const firstResetRef = useRef(true)
      useEffect(() => {
        if (firstResetRef.current) { firstResetRef.current = false; return }
        setPage(0)
      }, [key])
      useEffect(() => { onFiltersChange?.('roots', applied) }, [applied, onFiltersChange])
      useEffect(() => { onViewChange?.('roots', { page }) }, [page, onViewChange])
      const params = new URLSearchParams({ dump_id: dumpId ?? '', page: String(page), size: '100' })
      if (applied.idPrefix !== '') params.set('id_prefix', applied.idPrefix)
      if (applied.type !== '') params.set('type', applied.type)
      if (applied.query !== '') params.set('query', applied.query)
      if (applied.heap !== '') params.set('heap', applied.heap)
      const result = useFetch(dumpId ? `${API}/roots?${params}` : null)
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      const items = result.data?.items ?? []
      const total = result.data?.total ?? 0
      return h('div', null,
        h('div', { style: S.row },
          h('span', { style: S.muted }, result.loading ? '加载中…' : `${total.toLocaleString()} 个根`)),
        h(Section, { title: 'GC Roots' }, h(Table, {
          columns: [
            { key: 'id', title: '对象', render: (row) => h('span', { style: S.mono }, hexId(row.id)) },
            { key: 'type', title: '根类型' },
            { key: 'className', title: '类' },
            { key: 'heap', title: '堆' },
          ],
          filters: [
            { value: filters.idPrefix, onChange: (value) => set('idPrefix', value), placeholder: '搜索 ID' },
            { value: filters.type, onChange: (value) => set('type', value), placeholder: '搜索根类型' },
            { value: filters.query, onChange: (value) => set('query', value), placeholder: '搜索类名' },
            { value: filters.heap, onChange: (value) => set('heap', value), placeholder: '搜索堆' },
          ],
          rows: items,
          onRowClick: (row) => onObject(row.id),
          onRowSelect: (row) => onSelectRow?.('roots', row),
          selectedRowId,
          empty: '没有匹配的根',
        })),
        h('div', { style: { ...S.row, marginTop: 8 } },
          h(Btn, { onClick: () => setPage((value) => Math.max(0, value - 1)), disabled: page === 0 }, '上一页'),
          h('span', { style: S.muted }, `第 ${page + 1} 页`),
          h(Btn, { onClick: () => setPage((value) => value + 1), disabled: (page + 1) * 100 >= total }, '下一页')))
    }

    function ReferrersTab({ dumpId, objectId, onObject, onBack, onSelectRow, selectedRowId }) {
      const [page, setPage] = useState(0)
      const [type, setType] = useState('all')
      const [field, setField] = useState('')
      const [direction, setDirection] = useState('in')
      const result = useFetch(dumpId && objectId !== null
        ? `${API}/references?dump_id=${encodeURIComponent(dumpId)}&id=${objectId}&direction=${direction}&page=${page}&size=100&type=${encodeURIComponent(type)}&field=${encodeURIComponent(field)}`
        : null, { cache: true })
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      const data = result.data
      const items = data?.items ?? []
      const total = data?.total
      const hasMore = data?.truncated === true || data?.hasMore === true || (typeof total === 'number' && page * 100 + items.length < total)
      return h('div', null,
        h('div', { style: S.row },
          h(Btn, { onClick: onBack }, '← 返回'),
          h('span', { style: S.muted }, objectId === null ? '' : `${direction === 'in' ? '谁引用' : '引用了谁'} ${hexId(objectId)}`),
          h('select', {
            className: 'hp-select', style: S.select, value: direction,
            onChange: (event) => { setPage(0); setDirection(event.target.value) },
          },
            h('option', { value: 'in' }, '入引用 Inbound'),
            h('option', { value: 'out' }, '出引用 Outbound')),
          h('select', {
            className: 'hp-select', style: S.select, value: type,
            onChange: (event) => { setPage(0); setType(event.target.value) },
          },
            h('option', { value: 'all' }, '全部引用'),
            h('option', { value: 'strong' }, '强引用'),
            h('option', { value: 'weak' }, '弱引用'),
            h('option', { value: 'soft' }, '软引用'),
            h('option', { value: 'phantom' }, '虚引用'),
            h('option', { value: 'final' }, 'Finalizer/Cleaner')),
          h('input', {
            className: 'hp-input', style: { ...S.input, minWidth: 120 }, value: field,
            placeholder: '字段名过滤', 'aria-label': '引用字段过滤',
            onChange: (event) => { setPage(0); setField(event.target.value) },
          })),
        data === null
          ? h('div', { style: S.muted }, '加载中…')
          : h('div', null,
            h('div', { style: S.hint },
              `第 ${page + 1} 页 · ${items.length} 条${total === null || total === undefined ? '（未扫描完）' : ` / ${total}`}${data.truncated ? ' · 已截断' : ''} · 扫描 ${data.tookMs ?? 0} ms`),
            h(Section, { title: direction === 'in' ? '引用者' : '引用的对象' }, h(Table, {
              columns: [
                { key: 'id', title: direction === 'in' ? '引用者' : '目标对象', render: (row) => h('span', { style: S.mono }, hexId(row.id)) },
                { key: 'className', title: '类' },
                { key: 'field', title: '字段/下标', render: (row) => row.via ?? row.field ?? null },
                { key: 'type', title: '类型', render: (row) => h('span', { className: 'hp-ref-type' }, row.type ?? 'strong') },
              ],
              rows: items,
              onRowClick: (row) => onObject(row.id),
              onRowSelect: (row) => onSelectRow?.('referrers', row),
              selectedRowId,
              empty: direction === 'in' ? '没有找到引用者' : '没有找到出引用',
            })),
            h('div', { style: { ...S.row, marginTop: 8 } },
              h(Btn, { onClick: () => setPage((value) => Math.max(0, value - 1)), disabled: page === 0 }, '上一页'),
              h('span', { style: S.muted }, `第 ${page + 1} 页`),
              h(Btn, { onClick: () => setPage((value) => value + 1), disabled: !hasMore }, '下一页'))))
    }

    function DomTreeTab({ dumpId, rootId, onObject, treeCommand, onTreeChange, retainedSet, retainedSetLoading, onRetainedSet }) {
      const [root, setRoot] = useState(rootId ?? 0)
      const [filter, setFilter] = useState('')
      const [expanded, setExpanded] = useState(() => new Set())
      const retainedClasses = useFetch(dumpId
        ? `${API}/retained-classes?dump_id=${encodeURIComponent(dumpId)}&limit=12`
        : null, { cache: true })
      useEffect(() => { setRoot(rootId ?? 0) }, [rootId])
      useEffect(() => { setExpanded(new Set()) }, [root, dumpId])
      useEffect(() => { onTreeChange?.([...expanded]) }, [expanded, onTreeChange])
      useEffect(() => {
        if (treeCommand === null || treeCommand === undefined) return
        if (treeCommand.view === 'classpaths') return
        const id = Number(treeCommand.id)
        if (!Number.isSafeInteger(id) || id < 0) return
        setExpanded((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [treeCommand])
      const toggleNode = (id) => {
        setExpanded((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
      const result = useFetch(dumpId
        ? `${API}/domtree?dump_id=${encodeURIComponent(dumpId)}&parent=${root}&offset=0&limit=100`
        : null, { cache: true })
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      const data = result.data
      const items = (data?.items ?? []).filter((node) => nodeMatches(node, filter))
      const retainedClassRows = Array.isArray(retainedClasses.data)
        ? retainedClasses.data
        : (retainedClasses.data?.items ?? [])
      return h('div', null,
        h('div', { style: S.row },
          h(Btn, { onClick: () => setRoot(0) }, '回到根'),
          root === 0 ? null : h(Btn, { onClick: () => onObject(root) }, '返回对象详情'),
          h('span', { style: S.muted }, `当前：${data?.parent?.className ?? '—'}`),
          h('div', { className: 'hp-filter', style: { flex: '0 1 220px', minWidth: 160 } },
            h(SearchIcon),
            h('input', {
              className: 'hp-filter-input',
              style: { ...S.input, minWidth: 140, padding: '4px 8px 4px 19px' },
              value: filter,
              placeholder: '搜索类名/ID',
              'aria-label': '搜索支配树类名或 ID',
              onChange: (event) => setFilter(event.target.value),
            })),
          h('span', { style: S.muted }, `${data?.total ?? 0} 个子节点`)),
        retainedClassRows.length === 0 ? null : h(Section, { title: 'Top Retained 类' }, h(Table, {
          columns: [
            { key: 'className', title: '类', render: (row) => h('span', { style: S.mono }, row.className) },
            { key: 'count', title: '对象数', align: 'right' },
            { key: 'retained', title: 'Retained 总和', align: 'right', render: (row) => formatBytes(row.retained) },
          ],
          rows: retainedClassRows,
          onRowClick: (row) => onObject(row.topObjectId),
          empty: '没有 retained 类',
        })),
        retainedSetLoading
          ? h('div', { style: S.muted }, '正在计算 Retained Set…')
          : retainedSet === null
            ? null
            : h(Section, { title: `Retained Set · 根对象 ${hexId(retainedSet.sourceId)}` },
              h('div', { style: S.hint },
                `${retainedSet.totalObjects} 个对象 · shallow ${formatBytes(retainedSet.shallow)}`
                + (retainedSet.truncated ? ' · 已截断' : '')),
              h(Table, {
                columns: [
                  { key: 'className', title: '类', render: (row) => h('span', { style: S.mono }, row.className) },
                  { key: 'count', title: '对象数', align: 'right' },
                  { key: 'retained', title: 'Retained 总和', align: 'right', render: (row) => formatBytes(row.retained) },
                ],
                rows: (retainedSet.classes ?? []).slice(0, 10),
              })),
        data === null
          ? h('div', { style: S.muted }, '加载中…')
          : h('div', { style: { marginTop: 8 } },
            items.map((node) => h(DomNode, {
              key: node.id, dumpId, node, depth: 0, onObject, filter,
              expanded, onToggle: toggleNode, onRetainedSet,
            }))))
    }

    function nodeMatches(node, filter) {
      if (filter === '') return true
      const needle = filter.trim().toLowerCase()
      if (needle === '') return true
      return String(node.className).toLowerCase().includes(needle) || hexId(node.id).toLowerCase().includes(needle)
    }

    function DomNode({ dumpId, node, depth, onObject, filter, expanded, onToggle, onRetainedSet }) {
      const open = expanded.has(node.id)
      const [offset, setOffset] = useState(0)
      const children = useFetch(open && dumpId
        ? `${API}/domtree?dump_id=${encodeURIComponent(dumpId)}&parent=${node.id}&offset=${offset}&limit=100`
        : null, { cache: true })
      const tone = depth === 0
        ? 'var(--dsw-alias-brand-primary)'
        : depth === 1
          ? 'var(--dsw-alias-state-success-primary)'
          : depth === 2
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-secondary)'
      return h('div', { className: 'hp-tree' },
        h('div', {
          className: `hp-tree-row hp-tree-row-depth-${Math.min(depth, 3)}`,
          role: 'treeitem',
          'aria-expanded': node.children === 0 ? undefined : open,
        },
          depth > 0
            ? h('span', { className: 'hp-tree-indents', 'aria-hidden': true },
              Array.from({ length: depth }, (_, index) => h('span', { key: index, className: 'hp-tree-indent' })))
            : null,
          h('button', {
            type: 'button', className: 'hp-tree-caret', disabled: node.children === 0,
            'aria-label': node.children === 0 ? undefined : open ? '折叠节点' : '展开节点',
            onClick: () => onToggle(node.id),
          }, node.children === 0 ? '·' : open ? '▾' : '▸'),
          h('span', { className: 'hp-tree-dot', style: { background: tone }, 'aria-hidden': true }),
          h('button', {
            type: 'button', className: 'hp-tree-name hp-tree-name-button',
            title: '查看对象详情',
            onClick: () => onObject(node.id),
          }, node.className),
          h('span', { className: 'hp-tree-id' }, hexId(node.id)),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button', className: 'hp-action',
            title: '计算该对象支配的 Retained Set',
            onClick: (event) => { event.stopPropagation(); onRetainedSet?.(node.id) },
          }, 'Retained Set'),
          h('span', { className: 'hp-tree-metric' }, `retained ${formatBytes(node.retained)}`),
          h('span', { className: 'hp-tree-metric' }, `shallow ${formatBytes(node.shallow)}`)),
        open ? h('div', null,
          children.error !== null ? h('div', { style: S.error }, children.error) : null,
          children.data === null ? h('div', { style: { ...S.muted, paddingLeft: (depth + 1) * 14 + 22 } }, '加载中…') : null,
          (children.data?.items ?? []).filter((child) => nodeMatches(child, filter)).map((child) => h(DomNode, {
            key: child.id, dumpId, node: child, depth: depth + 1, onObject, filter, expanded, onToggle, onRetainedSet,
          })),
          children.data !== null && children.data.total > offset + 100
            ? h('button', {
              type: 'button',
              className: 'hp-action hp-action-quiet',
              style: { marginLeft: (depth + 1) * 14 + 22, marginTop: 4 },
              onClick: () => setOffset((value) => value + 100),
            }, `显示更多（共 ${children.data.total}）`)
            : null)
          : null)
    }

    /** Plain text of a message content block list. */
    function textOfContent(content) {
      return (content ?? [])
        .map((block) => (block !== null && typeof block === 'object' && block.type === 'text' ? block.text : ''))
        .filter((text) => text !== '')
        .join('\n')
    }

    /** Plain text plus a compact tool marker from assistant blocks. */
    function textOfAssistant(blocks) {
      return (blocks ?? [])
        .map((block) => {
          if (block === null || typeof block !== 'object') return ''
          if (block.kind === 'text') return block.text
          if (block.kind === 'tool-call') return `[${block.name}]`
          return ''
        })
        .filter((text) => text !== '')
        .join('\n')
    }

    /** Bottom conversation panel: transcript plus a composer that drives the session input. */
    function ChatPanel({ open, height, onToggle, onResizeStart, useChat, useInput, inputActions, dumpId, dumpFile, draftCommand }) {
      if (typeof useChat !== 'function' || typeof useInput !== 'function') {
        return h('div', { style: { ...S.chat, ...S.chatCollapsed } }, '当前会话不支持对话面板')
      }
      const nodes = useChat((snapshot) => snapshot.legacy.nodes)
      const partial = useChat((snapshot) => snapshot.legacy.partial)
      const draft = useInput((state) => state.draft) ?? ''
      const [text, setText] = useState('')
      const [attachDump, setAttachDump] = useState(true)
      const [notice, setNotice] = useState('')
      const scroller = useRef(null)

      useEffect(() => {
        if (draftCommand === null || draftCommand === undefined) return
        if (typeof draftCommand.text !== 'string') return
        setText(draftCommand.text)
      }, [draftCommand])

      useEffect(() => {
        if (scroller.current !== null) scroller.current.scrollTop = scroller.current.scrollHeight
      }, [nodes, partial])

      const rows = []
      for (const node of (nodes ?? []).slice(-40)) {
        if (node.kind === 'user' || node.kind === 'steering') {
          rows.push({ key: `u${node.seq}`, role: 'user', text: textOfContent(node.content) })
        } else if (node.kind === 'assistant') {
          rows.push({ key: `a${node.seq}`, role: 'assistant', text: textOfAssistant(node.blocks) })
        } else if (node.kind === 'tool-result') {
          const body = textOfContent(node.content).slice(0, 200)
          rows.push({ key: `t${node.seq}`, role: 'tool', text: `${node.name}${body === '' ? '' : `: ${body}`}` })
        } else if (node.kind === 'turn-error') {
          rows.push({ key: `e${node.seq}`, role: 'error', text: node.message })
        }
      }

      function send() {
        const message = text.trim()
        if (message === '') return
        if (inputActions === undefined || typeof inputActions.insertText !== 'function') {
          setNotice('当前会话输入不可用')
          return
        }
        try {
          const prefix = attachDump && dumpId !== null && dumpId !== undefined
            ? `[当前 hprof: ${dumpId}${dumpFile === undefined || dumpFile === null ? '' : `, ${dumpFile}`}]\n`
            : ''
          const span = inputActions.captureInsertion()
          const inserted = inputActions.insertText(prefix + message, span)
          if (inserted === false) {
            setNotice('主输入框正在提交，请稍后再试')
            return
          }
          inputActions.submit()
          setText('')
          setNotice('')
        } catch (cause) {
          setNotice(String(cause?.message ?? cause))
        }
      }

      return h('div', { style: { ...S.chat, ...(open ? { height } : S.chatCollapsed) } },
        open ? h('div', { className: 'hp-chat-handle', onMouseDown: onResizeStart, title: '拖动调整高度' }) : null,
        h('div', { className: 'hp-chat-head', style: S.chatHeader },
          h(Btn, { onClick: onToggle, ghost: true }, open ? '▾ 对话' : '▸ 对话'),
          open ? h('span', { className: 'hp-chat-dot', 'aria-hidden': true }) : null,
          h('span', { style: S.muted }, open ? '直接在当前会话里提问' : '展开对话'),
          h('span', { style: { flex: 1 } }),
          open && dumpId !== null && dumpId !== undefined
            ? h('label', { style: { ...S.muted, display: 'flex', gap: 4, alignItems: 'center' } },
              h('input', {
                type: 'checkbox', checked: attachDump,
                onChange: (event) => setAttachDump(event.target.checked),
              }),
              '带上当前 dump')
            : null,
          open && draft !== '' ? h('span', { style: S.hint }, '发送会追加到主输入框') : null),
        open ? h('div', { ref: scroller, style: S.chatLog },
          rows.length === 0 ? h('div', { style: S.muted }, '还没有对话。输入问题后回车发送。') : null,
          rows.map((row) => h('div', {
            key: row.key,
            style: row.role === 'user' ? S.chatUser : row.role === 'assistant' ? S.chatAssistant : row.role === 'error' ? S.chatError : S.chatTool,
          }, row.text)),
          partial !== null && partial !== undefined ? h('div', { style: S.chatAssistant }, '正在回复…') : null) : null,
        open ? h('div', { style: S.chatComposer },
          h('textarea', {
            className: 'hp-chat-input',
            style: S.chatInput,
            value: text,
            rows: 2,
            placeholder: '问点关于这份 hprof 的问题，Enter 发送，Shift+Enter 换行',
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && event.shiftKey === false) {
                event.preventDefault()
                send()
              }
            },
          }),
          h(Btn, { primary: true, onClick: send, disabled: text.trim() === '' }, '发送'),
          notice === '' ? null : h('span', { style: S.error }, notice)) : null)
    }

    /** Fixed Chat selection used by the workspace's embedded Conversation. */
    function FixedChatConversationView(viewProps) {
      return h(React.Fragment, null, viewProps.renderSlot('conversation.session', { view: 'chat' }))
    }

    /** Full Conversation content bound to the frame's current Session. */
    function HprofConversation(props) {
      if (typeof props.renderFactorySlot !== 'function') {
        return h('div', { style: { ...S.muted, padding: 16 } }, '当前部署不支持嵌入会话')
      }
      const session = props.useSession((value) => value)
      const conversation = props.useConversation((value) => value)
      if (session === undefined || session === null) {
        return h('div', { style: { ...S.muted, padding: 16 } }, '正在加载会话…')
      }
      const active = (conversation?.activeTargets?.size ?? 0) > 0
        || (!session.blank && !session.awaitingFirstTurn)
        || session.running
      const phase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
      return props.renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase, hero: phase === 'blank' },
        { slots: { views: FixedChatConversationView } },
      )
    }

    /** Workspace: HPROF analysis on the left, the full Conversation on the right. */
    function HprofWorkspace(props) {
      const { renderSlot, SessionProvider, close } = props
      const containerRef = useRef(null)
      const [split, setSplit] = useState(() => {
        try {
          const stored = Number(localStorage.getItem('hprof.workspaceSplit'))
          return stored >= 25 && stored <= 70 ? stored : 38
        } catch {
          return 38
        }
      })

      function startSplit(event) {
        event.preventDefault()
        const width = containerRef.current?.getBoundingClientRect().width ?? 1200
        const startX = event.clientX
        const start = split
        let latest = start
        const move = (moveEvent) => {
          latest = Math.min(70, Math.max(25, start + ((startX - moveEvent.clientX) / width) * 100))
          setSplit(latest)
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          try {
            localStorage.setItem('hprof.workspaceSplit', String(latest))
          } catch {
            // Storage can be unavailable in a restricted browser; the live split still works.
          }
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }

      return h('div', {
        ref: containerRef,
        style: { height: '100%', display: 'flex', minHeight: 0, background: 'var(--dsw-alias-bg-base)' },
      },
        h('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex' } },
          h(HprofTab, { hideChat: true, onCloseWorkspace: typeof close === 'function' ? close : undefined })),
        h('div', {
          className: 'hp-workspace-handle',
          onMouseDown: startSplit,
          role: 'separator',
          'aria-orientation': 'vertical',
          title: '拖动调整对话宽度',
        }),
        h('div', {
          style: {
            flex: `0 0 ${split}%`, minWidth: 320, minHeight: 0, display: 'flex', flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        },
          h('div', { className: 'hp-chat-head', style: S.header },
            h('span', { className: 'hp-chat-dot', 'aria-hidden': true }),
            h('span', { style: S.title }, '对话'),
            h('span', { style: S.muted }, '与当前会话共享消息')),
          typeof SessionProvider === 'function'
            ? h(SessionProvider, {
              empty: () => h('div', { style: { ...S.muted, padding: 16 } }, '打开或选择一个会话后在这里对话'),
              children: typeof renderSlot === 'function' ? renderSlot('hprof.conversation', {}) : null,
            })
            : h('div', { style: { ...S.muted, padding: 16 } }, '当前部署不支持嵌入会话')))
    }

    /** Sidebar glyph for the HPROF workspace entry. */
    function HprofPanelIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', {
          d: 'M4 6h3.5M4 9h2.5M10 5.5l1.8 2.5L10 10.5',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    function LeaksTab({ dumpId, onClass, onClassPaths }) {
      const [nonce, setNonce] = useState(0)
      const result = useFetch(dumpId ? `${API}/leaks?dump_id=${encodeURIComponent(dumpId)}&limit=8&_=${nonce}` : null, { cache: true })
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      const data = result.data
      const suspects = data?.suspects ?? []
      return h('div', null,
        h('div', { style: S.row },
          h(Btn, { onClick: () => setNonce((value) => value + 1), disabled: result.loading }, result.loading ? '分析中…' : '重新分析'),
          h('span', { style: S.hint },
            '按最大聚合根容器、native retained、hidden 和 released wrapper 排序；分析可能需几秒。')),
        data === null
          ? h('div', { style: S.muted }, '自动分析中…')
          : suspects.length === 0
            ? h('div', { style: S.muted }, '没有发现明显嫌疑。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              suspects.map((suspect, index) => h('div', {
                key: `${suspect.classId}-${index}`,
                className: 'hp-suspect-card',
              },
                h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                  h('div', { style: { ...S.row, gap: 8 } },
                    h('span', { className: 'hp-suspect-rank' }, `#${index + 1}`),
                    h('span', { style: { ...S.mono, fontSize: 13 } }, suspect.className)),
                  h('span', { className: 'hp-suspect-score' }, `score ${suspect.score}`)),
                h('div', { style: { ...S.hint, marginTop: 4 } },
                  `${suspect.totalObjects} 对象 · 强可达 ${suspect.reachable} · 不可达 ${suspect.unreachable}`
                  + ` · native retained ${suspect.native?.retained ?? 0} / released ${suspect.native?.released ?? 0}`
                  + ` · hidden ${suspect.hidden ?? 0}`),
                suspect.reasons.length > 0
                  ? h('div', { style: { ...S.row, gap: 5, marginTop: 2 } },
                    suspect.reasons.map((reason, reasonIndex) => h('span', {
                      key: reasonIndex, className: 'hp-suspect-reason',
                    }, reason)))
                  : null,
                suspect.topPath === null
                  ? null
                  : h('div', { style: { marginTop: 6 } },
                    h('div', { style: S.hint }, `Top container: ${suspect.topPath.count} 个`),
                    h('div', { style: S.chain },
                      suspect.topPath.chain.split(' | ').map((step, stepIndex) => h('div', {
                        key: stepIndex, style: S.chainLine,
                      }, step)))),
                suspect.topPaths?.length > 1
                  ? h('div', { style: { marginTop: 6 } },
                    h('div', { style: S.hint }, '其他容器路径'),
                    suspect.topPaths.slice(1, 3).map((path, pathIndex) => h('div', {
                      key: pathIndex, style: { marginTop: 4 },
                    },
                      h('div', { className: 'hp-suspect-reason' }, `${path.count} 个`),
                      h('div', { style: S.chain },
                        path.chain.split(' | ').map((step, stepIndex) => h('div', {
                          key: stepIndex, style: S.chainLine,
                        }, step))))))
                  : null,
                h('div', { style: { ...S.row, marginTop: 6 } },
                  h(Btn, { onClick: () => onClass({ id: suspect.classId, name: suspect.className, kind: 'class' }) }, '查看类'),
                  h(Btn, {
                    onClick: () => onClassPaths({ id: suspect.classId, name: suspect.className, kind: 'class' }),
                  }, 'GC 路径'))))))
    }

    function FindingsTab({ dumpId, currentObjectId, currentClassInfo, onObject, onClass }) {
      const [items, setItems] = useState([])
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [targetKind, setTargetKind] = useState('object')
      const [targetId, setTargetId] = useState('')
      const [title, setTitle] = useState('')
      const [note, setNote] = useState('')
      const [severity, setSeverity] = useState('info')
      const [tags, setTags] = useState('')
      const [filterSeverity, setFilterSeverity] = useState('all')
      const [filterText, setFilterText] = useState('')
      const [targetIds, setTargetIds] = useState('')
      const [targetField, setTargetField] = useState('')
      const [editingId, setEditingId] = useState(null)
      const [editTitle, setEditTitle] = useState('')
      const [editNote, setEditNote] = useState('')
      const [editSeverity, setEditSeverity] = useState('info')
      const [editTags, setEditTags] = useState('')

      const load = useCallback(async () => {
        if (dumpId === null || dumpId === undefined) {
          setItems([])
          return
        }
        setLoading(true)
        setError('')
        try {
          const data = await api(`/findings?dump_id=${encodeURIComponent(dumpId)}`)
          setItems(data?.findings ?? [])
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setLoading(false)
        }
      }, [dumpId])

      useEffect(() => { void load() }, [load])

      useEffect(() => {
        if (currentObjectId !== null && currentObjectId !== undefined) {
          setTargetKind('object')
          setTargetId(String(currentObjectId))
        } else if (currentClassInfo !== null && currentClassInfo !== undefined) {
          setTargetKind('class')
          setTargetId(String(currentClassInfo.id))
        }
      }, [currentObjectId, currentClassInfo])

      async function createFinding() {
        if (title.trim() === '') {
          setError('请输入 finding 标题')
          return
        }
        const id = Number(targetId)
        if ((targetKind === 'object' || targetKind === 'class' || targetKind === 'field')
          && (!Number.isSafeInteger(id) || id < 0)) {
          setError('目标 id 不合法')
          return
        }
        let target
        if (targetKind === 'path') {
          const ids = targetIds.split(',').map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value >= 0)
          if (ids.length === 0) {
            setError('path target 需要至少一个 id')
            return
          }
          target = { kind: 'path', ids }
        } else if (targetKind === 'field') {
          const field = targetField.trim()
          if (field === '') {
            setError('field target 需要字段名')
            return
          }
          target = { kind: 'field', id, field }
        } else if (targetKind === 'dump') {
          target = { kind: 'dump' }
        } else {
          target = {
            kind: targetKind,
            id,
            ...(targetKind === 'class' && currentClassInfo?.name ? { label: currentClassInfo.name } : {}),
          }
        }
        setError('')
        try {
          await api('/findings', {
            method: 'POST',
            body: {
              dump_id: dumpId,
              target,
              title: title.trim(),
              note,
              severity,
              author: 'user',
              tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
            },
          })
          setTitle('')
          setNote('')
          setTags('')
          await load()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }

      async function deleteFinding(id) {
        setError('')
        try {
          await api('/findings/delete', { method: 'POST', body: { dump_id: dumpId, id } })
          if (editingId === id) setEditingId(null)
          await load()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }

      function startEdit(finding) {
        setEditingId(finding.id)
        setEditTitle(finding.title)
        setEditNote(finding.note ?? '')
        setEditSeverity(finding.severity)
        setEditTags((finding.tags ?? []).join(', '))
        setError('')
      }

      async function saveEdit(id) {
        if (editTitle.trim() === '') {
          setError('标题不能为空')
          return
        }
        setError('')
        try {
          await api('/findings/update', {
            method: 'POST',
            body: {
              dump_id: dumpId,
              id,
              title: editTitle.trim(),
              note: editNote,
              severity: editSeverity,
              tags: editTags.split(',').map((tag) => tag.trim()).filter(Boolean),
            },
          })
          setEditingId(null)
          await load()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }

      const visibleItems = items.filter((finding) => {
        if (filterSeverity !== 'all' && finding.severity !== filterSeverity) return false
        const needle = filterText.trim().toLowerCase()
        if (needle === '') return true
        const haystack = `${finding.title}\n${finding.note}\n${(finding.tags ?? []).join(' ')}`.toLowerCase()
        return haystack.includes(needle)
      })

      const severityTone = {
        info: 'var(--dsw-alias-brand-primary)',
        warn: 'var(--dsw-alias-state-warn-primary)',
        error: 'var(--dsw-alias-state-error-primary)',
      }

      return h('div', null,
        h(Section, {
          title: 'Findings',
          actions: h('div', { style: S.row },
            h('select', {
              className: 'hp-select', style: S.select, value: filterSeverity,
              title: '按 severity 过滤',
              onChange: (event) => setFilterSeverity(event.target.value),
            },
              h('option', { value: 'all' }, '全部'),
              h('option', { value: 'info' }, 'info'),
              h('option', { value: 'warn' }, 'warn'),
              h('option', { value: 'error' }, 'error')),
            h('input', {
              className: 'hp-input', style: { ...S.input, minWidth: 160 }, value: filterText,
              placeholder: '搜索 title/tag/note',
              onChange: (event) => setFilterText(event.target.value),
            }),
            h(Btn, { ghost: true, onClick: () => { void load() } }, '刷新')),
        },
          h('div', { style: { ...S.row, alignItems: 'flex-start' } },
            h('select', {
              className: 'hp-select', style: S.select, value: targetKind,
              onChange: (event) => setTargetKind(event.target.value),
            },
              h('option', { value: 'object' }, '对象'),
              h('option', { value: 'class' }, '类'),
              h('option', { value: 'path' }, '路径'),
              h('option', { value: 'field' }, '字段'),
              h('option', { value: 'dump' }, '整个 dump')),
            targetKind === 'object' || targetKind === 'class' || targetKind === 'field'
              ? h('input', {
                className: 'hp-input', style: { ...S.input, minWidth: 130 }, value: targetId,
                placeholder: 'object / class id', inputMode: 'numeric',
                onChange: (event) => setTargetId(event.target.value),
              })
              : null,
            targetKind === 'path'
              ? h('input', {
                className: 'hp-input', style: { ...S.input, minWidth: 180 }, value: targetIds,
                placeholder: 'ids，逗号分隔',
                onChange: (event) => setTargetIds(event.target.value),
              })
              : null,
            targetKind === 'field'
              ? h('input', {
                className: 'hp-input', style: { ...S.input, minWidth: 140 }, value: targetField,
                placeholder: '字段名',
                onChange: (event) => setTargetField(event.target.value),
              })
              : null,
            h('input', {
              className: 'hp-input', style: { ...S.input, minWidth: 220, flex: 1 }, value: title,
              placeholder: '标题，例如 “task 5 是空容器”',
              onChange: (event) => setTitle(event.target.value),
            }),
            h('select', {
              className: 'hp-select', style: S.select, value: severity,
              onChange: (event) => setSeverity(event.target.value),
            },
              h('option', { value: 'info' }, 'info'),
              h('option', { value: 'warn' }, 'warn'),
              h('option', { value: 'error' }, 'error')),
            h(Btn, { primary: true, onClick: () => { void createFinding() } }, '记录')),
          h('textarea', {
            className: 'hp-input',
            style: { ...S.chatInput, width: '100%', minHeight: 58, marginTop: 6 },
            value: note, placeholder: '结论/证据（可选）',
            onChange: (event) => setNote(event.target.value),
          }),
          h('div', { style: { ...S.row, marginTop: 6 } },
            h('input', {
              className: 'hp-input', style: { ...S.input, minWidth: 220 }, value: tags,
              placeholder: 'tags，逗号分隔（可选）',
              onChange: (event) => setTags(event.target.value),
            }),
            h('span', { style: S.hint },
              currentObjectId !== null && currentObjectId !== undefined
                ? `当前选中对象 ${hexId(currentObjectId)} 已带入`
                : currentClassInfo !== null && currentClassInfo !== undefined
                  ? `当前类 ${currentClassInfo.name} 已带入`
                  : '先选一个对象/类，或手动填 id')),
          error === '' ? null : h('div', { style: S.error }, error),
          loading ? h('div', { style: S.muted }, '加载中…') : null,
          h('div', { style: S.hint }, `${visibleItems.length} / ${items.length} 条 finding`),
          visibleItems.length === 0
            ? h('div', { style: S.muted },
              items.length === 0
                ? '还没有 finding。记录第一条后，它会按 dump 文件持久化。'
                : '当前 severity 下没有 finding。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              visibleItems.map((finding) => {
                const editing = editingId === finding.id
                return h('div', {
                  key: finding.id,
                  style: { ...S.card, borderLeft: `3px solid ${severityTone[finding.severity] ?? severityTone.info}` },
                },
                  editing
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      h('div', { style: S.row },
                        h('input', {
                          className: 'hp-input', style: { ...S.input, flex: 1 }, value: editTitle,
                          placeholder: '标题',
                          onChange: (event) => setEditTitle(event.target.value),
                        }),
                        h('select', {
                          className: 'hp-select', style: S.select, value: editSeverity,
                          onChange: (event) => setEditSeverity(event.target.value),
                        },
                          h('option', { value: 'info' }, 'info'),
                          h('option', { value: 'warn' }, 'warn'),
                          h('option', { value: 'error' }, 'error'))),
                      h('textarea', {
                        className: 'hp-input',
                        style: { ...S.chatInput, width: '100%', minHeight: 70 },
                        value: editNote, placeholder: '结论/证据',
                        onChange: (event) => setEditNote(event.target.value),
                      }),
                      h('div', { style: S.row },
                        h('input', {
                          className: 'hp-input', style: { ...S.input, flex: 1 }, value: editTags,
                          placeholder: 'tags，逗号分隔',
                          onChange: (event) => setEditTags(event.target.value),
                        }),
                        h(Btn, { primary: true, onClick: () => { void saveEdit(finding.id) } }, '保存'),
                        h(Btn, { ghost: true, onClick: () => setEditingId(null) }, '取消')))
                    : h('div', null,
                      h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                        h('span', { style: { fontWeight: 500, fontSize: 13 } }, finding.title),
                        h('span', { style: { ...S.muted, fontSize: 11 } },
                          `${finding.severity} · ${finding.author} · ${new Date(finding.createdAt).toLocaleString()}`)),
                      h('div', { style: { ...S.hint, marginTop: 4 } },
                        finding.target.kind,
                        finding.target.id !== undefined ? ` ${hexId(finding.target.id)}` : '',
                        finding.target.label !== undefined ? ` · ${finding.target.label}` : ''),
                      finding.note === '' ? null : h('div', { style: { ...S.pre, marginTop: 6 } }, finding.note),
                      h('div', { style: { ...S.row, marginTop: 6 } },
                        finding.target.kind === 'object'
                          ? h('button', {
                            type: 'button', className: 'hp-link',
                            onClick: () => onObject(finding.target.id),
                          }, '查看对象')
                          : finding.target.kind === 'class'
                            ? h('button', {
                              type: 'button', className: 'hp-link',
                              onClick: () => onClass({ id: finding.target.id, kind: 'class', name: finding.target.label ?? `class ${finding.target.id}` }),
                            }, '查看类')
                            : null,
                        h(Btn, { ghost: true, onClick: () => startEdit(finding) }, '编辑'),
                        h(Btn, { danger: true, ghost: true, onClick: () => { void deleteFinding(finding.id) } }, '删除'))))
              }))
        ))
    }

    function HprofTab(props) {
      const hideChat = props.hideChat === true
      const onCloseWorkspace = typeof props.onCloseWorkspace === 'function' ? props.onCloseWorkspace : undefined
      const info = typeof props?.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const paramDumpId = info?.tab?.navigation?.params?.dumpId
      const [dumps, setDumps] = useState([])
      const [dumpsLoaded, setDumpsLoaded] = useState(false)
      const [dumpId, setDumpId] = useState(null)
      const [lastDump, setLastDump] = useState(() => {
        const stored = readLastDumpPath()
        return stored === '' ? null : { path: stored, dumpId: null }
      })
      const [pathInput, setPathInput] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      useEffect(() => {
        if (notice === '') return
        const timer = setTimeout(() => setNotice(''), 6_000)
        return () => clearTimeout(timer)
      }, [notice])
      const [tab, setTab] = useState('overview')
      const [classInfo, setClassInfo] = useState(null)
      const [returnTab, setReturnTab] = useState('classes')
      const [pathObjectId, setPathObjectId] = useState(null)
      const [referrersObjectId, setReferrersObjectId] = useState(null)
      const [drawerObjectId, setDrawerObjectId] = useState(null)
      const [drawerStack, setDrawerStack] = useState([])
      const [domRoot, setDomRoot] = useState(0)
      const [drawerWidth, setDrawerWidth] = useState(() => {
        try {
          const stored = Number(localStorage.getItem('hprof.drawerWidth'))
          return stored >= 320 && stored <= 900 ? stored : 440
        } catch {
          return 440
        }
      })
      const [chatOpen, setChatOpen] = useState(true)
      const [chatHeight, setChatHeight] = useState(() => {
        try {
          const stored = Number(localStorage.getItem('hprof.chatHeight'))
          return stored >= 120 && stored <= 600 ? stored : 200
        } catch {
          return 200
        }
      })
      const [rowSelection, setRowSelection] = useState(null)
      const [tableFilters, setTableFilters] = useState(null)
      const [filterOverride, setFilterOverride] = useState(null)
      const [viewState, setViewState] = useState(null)
      const [viewOverride, setViewOverride] = useState(null)
      const [treeExpanded, setTreeExpanded] = useState([])
      const [classPathCollapsed, setClassPathCollapsed] = useState([])
      const [treeCommand, setTreeCommand] = useState(null)
      const [weakRequest, setWeakRequest] = useState(null)
      const [classPathState, setClassPathState] = useState(null)
      const [retainedSet, setRetainedSet] = useState(null)
      const [retainedSetLoading, setRetainedSetLoading] = useState(false)
      const [syncStatus, setSyncStatus] = useState({ state: 'idle', poll: 'idle', error: '' })
      const [chatDraftCommand, setChatDraftCommand] = useState(null)
      const [mountNonce, setMountNonce] = useState(0)
      const viewStorageRef = useRef(null)
      const clientIdRef = useRef('')
      if (clientIdRef.current === '') {
        clientIdRef.current = `panel-${Math.random().toString(36).slice(2, 10)}`
      }
      const clientId = clientIdRef.current
      const handleRowSelect = useCallback((table, row) => {
        setRowSelection(row === null
          ? null
          : { table, id: row.id ?? null, className: row.className ?? row.name ?? null })
      }, [])
      const handleFiltersChange = useCallback((table, filters) => {
        setTableFilters({ table, ...filters })
        setFilterOverride((current) => (current?.table === table ? null : current))
        writeViewState(viewStorageRef.current, table, { filters })
      }, [])
      const handleViewChange = useCallback((table, view) => {
        setViewState({ table, ...view })
        setViewOverride((current) => (current?.table === table ? null : current))
        writeViewState(viewStorageRef.current, table, view)
      }, [])
      const handleTreeChange = useCallback((expanded) => {
        setTreeExpanded(expanded)
      }, [])
      const handleClassPathTreeChange = useCallback((collapsed) => {
        setClassPathCollapsed(collapsed)
      }, [])
      const handleClassPathState = useCallback((state) => {
        setClassPathState(state)
      }, [])

      useEffect(() => {
        if (paramDumpId !== undefined && paramDumpId !== null) setDumpId(paramDumpId)
      }, [paramDumpId])

      useEffect(() => {
        if (drawerObjectId === null) return
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeDrawer()
          } else if (event.altKey && event.key === 'ArrowLeft') {
            event.preventDefault()
            backObject()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [drawerObjectId, drawerStack])

      const refresh = useCallback(async () => {
        try {
          const data = await api('/dumps')
          setDumps(data?.dumps ?? [])
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setDumpsLoaded(true)
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      useEffect(() => {
        const timer = setInterval(() => { void refresh() }, 5_000)
        return () => clearInterval(timer)
      }, [refresh])

      useEffect(() => {
        const listener = () => { void refresh() }
        dumpInvalidatedListeners.add(listener)
        return () => { dumpInvalidatedListeners.delete(listener) }
      }, [refresh])

      useEffect(() => {
        if (dumps.length === 0) {
          if (dumpId !== null) setDumpId(null)
          return
        }
        const stored = readLastDumpPath()
        const preferred = stored === '' ? undefined : dumps.find((dump) => dump.file === stored)
        if (dumpId === null) {
          setDumpId(preferred?.dump_id ?? dumps[0].dump_id)
          return
        }
        if (!dumps.some((dump) => dump.dump_id === dumpId)) {
          const next = preferred?.dump_id ?? dumps[0].dump_id
          setNotice(`dump ${dumpId} 已关闭，已切换到 ${next}`)
          setDumpId(next)
        }
      }, [dumps, dumpId])

      useEffect(() => {
        if (!dumpsLoaded || autoRestoreDone) return
        autoRestoreDone = true
        if (dumps.length > 0) return
        const stored = readLastDumpPath()
        if (stored === '') return
        setNotice(`正在恢复上次的 dump：${stored}`)
        let active = true
        if (autoRestoreInFlight === null) {
          autoRestoreInFlight = Promise.resolve(openDump(stored)).finally(() => {
            autoRestoreInFlight = null
          })
        }
        void autoRestoreInFlight.then(() => {
          if (active) void refresh()
        })
        return () => {
          active = false
        }
      }, [dumpsLoaded, dumps.length])

      const activeDumpId = dumpsLoaded && dumpId !== null && dumps.some((dump) => dump.dump_id === dumpId)
        ? dumpId
        : null
      const computeRetainedSet = useCallback(async (id) => {
        if (activeDumpId === null) return
        setRetainedSetLoading(true)
        try {
          const result = await api('/retained-set', {
            method: 'POST',
            body: { dump_id: activeDumpId, ids: [id] },
          })
          setRetainedSet({ ...result, sourceId: id })
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setRetainedSetLoading(false)
        }
      }, [activeDumpId])
      viewStorageRef.current = dumps.find((dump) => dump.dump_id === activeDumpId)?.file ?? activeDumpId

      useEffect(() => {
        setRowSelection(null)
        setTableFilters(null)
        setViewState(null)
        setTreeExpanded([])
        setClassPathCollapsed([])
        setClassPathState(null)
        setRetainedSet(null)
        setTreeCommand(null)
      }, [activeDumpId])

      useEffect(() => {
        if (tab !== 'classpaths') setClassPathState(null)
      }, [tab])

      useEffect(() => {
        if (activeDumpId === null) return
        const timer = setTimeout(() => {
          void api('/ui/state', {
            method: 'POST',
            body: {
              dump_id: activeDumpId,
              client_id: clientId,
              state: {
                tab,
                panel: hideChat ? 'workspace' : 'sidebar',
                class_id: classInfo?.id ?? null,
                class_name: classInfo?.name ?? null,
                object_id: drawerObjectId,
                path_object_id: pathObjectId,
                referrers_object_id: referrersObjectId,
                row: rowSelection,
                filters: tableFilters,
                page: viewState?.page ?? null,
                sort: viewState?.sort ?? null,
                tree: {
                  tab: tab === 'classpaths' ? 'classpaths' : 'domtree',
                  expanded: treeExpanded,
                  collapsed: classPathCollapsed,
                },
                classPaths: classPathState,
              },
            },
          }).then(() => {
            setSyncStatus((current) => ({ ...current, state: 'ok', error: '' }))
          }).catch((cause) => {
            setSyncStatus((current) => ({ ...current, state: 'error', error: String(cause?.message ?? cause) }))
          })
        }, 80)
        return () => clearTimeout(timer)
      }, [activeDumpId, tab, classInfo, drawerObjectId, pathObjectId, referrersObjectId, rowSelection, tableFilters, viewState, treeExpanded, classPathCollapsed, classPathState, clientId])

      useEffect(() => {
        if (activeDumpId === null) return
        let alive = true
        let timer
        async function poll() {
          try {
            const data = await api(`/ui/commands?dump_id=${encodeURIComponent(activeDumpId)}&client_id=${encodeURIComponent(clientId)}`)
            setSyncStatus((current) => ({ ...current, poll: 'ok', error: '' }))
            const appliedIds = []
            for (const command of data?.commands ?? []) {
              appliedIds.push(command.id)
              if (!alive) return
              const params = command.params ?? {}
              if (command.action === 'selectTab' && typeof params.tab === 'string' && UI_TABS.has(params.tab)) {
                setTab(params.tab)
                setRowSelection(null)
                setTableFilters(null)
                setViewState(null)
                setTreeExpanded([])
                setClassPathCollapsed([])
                setClassPathState(null)
                setTreeCommand(null)
              } else if (command.action === 'selectRow'
                && typeof params.table === 'string' && ROW_TABS.has(params.table)
                && Number.isSafeInteger(Number(params.id)) && Number(params.id) >= 0) {
                setTab(params.table)
                setRowSelection({
                  table: params.table,
                  id: Number(params.id),
                  className: typeof params.className === 'string' ? params.className : null,
                })
              } else if (command.action === 'setFilters'
                && typeof params.tab === 'string' && FILTER_TABS.has(params.tab)
                && params.filters !== null && typeof params.filters === 'object') {
                setTab(params.tab)
                setFilterOverride({ table: params.tab, filters: params.filters })
                setMountNonce((value) => value + 1)
                setRowSelection(null)
                setTableFilters(null)
              } else if (command.action === 'setPage'
                && typeof params.tab === 'string' && PAGE_TABS.has(params.tab)
                && Number.isSafeInteger(Number(params.page)) && Number(params.page) >= 0) {
                setTab(params.tab)
                setViewOverride({ table: params.tab, page: Number(params.page) })
                setMountNonce((value) => value + 1)
                setRowSelection(null)
              } else if (command.action === 'setSort'
                && params.tab === 'classes' && typeof params.sort === 'string') {
                setTab('classes')
                setViewOverride({ table: 'classes', sort: params.sort })
                setMountNonce((value) => value + 1)
                setRowSelection(null)
              } else if (command.action === 'setWeak' && typeof params.weak === 'boolean') {
                setTab('classpaths')
                setWeakRequest({ weak: params.weak, nonce: Date.now() })
              } else if (command.action === 'toggleNode' && params.view === 'classpaths'
                && (typeof params.key === 'string'
                  || (Number.isSafeInteger(Number(params.index)) && Number(params.index) >= 0))) {
                setTab('classpaths')
                setTreeCommand({
                  view: 'classpaths',
                  key: typeof params.key === 'string' ? params.key : undefined,
                  index: Number.isSafeInteger(Number(params.index)) ? Number(params.index) : undefined,
                  nonce: Date.now(),
                })
              } else if (command.action === 'toggleNode'
                && Number.isSafeInteger(Number(params.id)) && Number(params.id) >= 0) {
                setTab('domtree')
                setTreeCommand({ view: 'domtree', id: Number(params.id), nonce: Date.now() })
              } else if (command.action === 'selectObject') {
                const id = Number(params.id)
                if (Number.isSafeInteger(id) && id >= 0) {
                  setDrawerObjectId(id)
                  setDrawerStack([])
                }
              } else if (command.action === 'selectClass') {
                const id = Number(params.id)
                if (Number.isSafeInteger(id) && id >= 0) {
                  setClassInfo({
                    id,
                    kind: 'class',
                    name: typeof params.name === 'string' ? params.name : `class ${id}`,
                  })
                  setTab('instances')
                }
              } else if (command.action === 'openDump') {
                if (typeof params.path === 'string' && params.path.trim() !== '') await openDump(params.path)
                else if (typeof params.dump_id === 'string') setDumpId(params.dump_id)
              } else if (command.action === 'closeDump') {
                await closeDump()
              } else if (command.action === 'closeDrawer') {
                closeDrawer()
              } else if (command.action === 'refresh') {
                await refresh()
                setMountNonce((value) => value + 1)
                setNotice('已刷新')
              } else if (command.action === 'runReport') {
                await writeReport()
              } else if (command.action === 'draftMessage' && typeof params.text === 'string') {
                setChatOpen(true)
                setChatDraftCommand({ text: params.text, nonce: Date.now() })
                setNotice(hideChat
                  ? '草稿已准备；当前工作区使用嵌入式会话，请在右侧栏 Chat 查看'
                  : '草稿已填入对话输入框')
              } else if (command.action === 'notice') {
                setNotice(String(params.text ?? ''))
              }
            }
            for (const commandId of appliedIds) {
              void api('/ui/ack', {
                method: 'POST',
                body: {
                  dump_id: activeDumpId,
                  client_id: clientId,
                  command_id: commandId,
                  status: 'applied',
                },
              }).catch(() => {})
            }
          } catch (cause) {
            setSyncStatus((current) => ({ ...current, poll: 'error', error: String(cause?.message ?? cause) }))
          }
          if (alive) timer = setTimeout(poll, 1_200)
        }
        timer = setTimeout(poll, 1_200)
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [activeDumpId])

      async function openDump(pathOverride) {
        const target = (typeof pathOverride === 'string' ? pathOverride : pathInput).trim()
        if (target === '') {
          setError('请输入 .hprof 文件路径')
          return
        }
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const opened = await api('/open', { method: 'POST', body: { path: target } })
          clearDetailCache()
          const openedPath = typeof opened.file === 'string' && opened.file !== '' ? opened.file : target
          writeLastDumpPath(openedPath)
          setLastDump({ path: openedPath, dumpId: opened.dump_id })
          await refresh()
          setDumpId(opened.dump_id)
          setTab('overview')
          setClassInfo(null)
          setDrawerObjectId(null)
          setDrawerStack([])
          setPathObjectId(null)
          setReferrersObjectId(null)
          setDomRoot(0)
          setNotice(`已打开 ${String(openedPath).split(/[\\/]/).pop()}（${opened.dump_id}，${formatBytes(opened.file_size_bytes)}，解析 ${opened.parse_ms} ms）`)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      async function closeDump() {
        if (activeDumpId === null) return
        setBusy(true)
        setError('')
        setNotice('')
        try {
          await api('/close', { method: 'POST', body: { dump_id: activeDumpId } })
          clearDetailCache()
          clearLastDumpPath()
          setDumpId(null)
          setClassInfo(null)
          setDrawerObjectId(null)
          setDrawerStack([])
          setPathObjectId(null)
          setReferrersObjectId(null)
          setDomRoot(0)
          await refresh()
          setNotice('已关闭')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      async function writeReport() {
        if (activeDumpId === null) return
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const report = await api('/report', { method: 'POST', body: { dump_id: activeDumpId } })
          setNotice(`报告已写入 ${report.path}`)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      function closeDrawer() {
        setDrawerObjectId(null)
        setDrawerStack([])
      }

      function openClass(row) {
        setClassInfo({ id: row.id, kind: row.kind ?? 'class', name: row.name })
        closeDrawer()
        setTab('instances')
      }

      function openObject(id) {
        setDrawerStack((stack) => (drawerObjectId === null ? stack : [...stack, drawerObjectId]))
        setDrawerObjectId(id)
      }

      function backObject() {
        if (drawerStack.length === 0) {
          closeDrawer()
          return
        }
        const previous = drawerStack[drawerStack.length - 1]
        setDrawerStack(drawerStack.slice(0, -1))
        setDrawerObjectId(previous)
      }

      function openPath(id) {
        setPathObjectId(id)
        setReturnTab(tab)
        closeDrawer()
        setTab('path')
      }

      function openReferrers(id) {
        setReferrersObjectId(id)
        setReturnTab(tab)
        closeDrawer()
        setTab('referrers')
      }

      function openClassPaths(row) {
        setClassInfo({ id: row.id, kind: row.kind ?? 'class', name: row.name })
        closeDrawer()
        setTab('classpaths')
      }

      function openDomTree(id) {
        setDomRoot(id)
        closeDrawer()
        setTab('domtree')
      }

      function startResize(event) {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = drawerWidth
        let latest = startWidth
        const move = (moveEvent) => {
          latest = Math.min(900, Math.max(320, startWidth + (startX - moveEvent.clientX)))
          setDrawerWidth(latest)
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          try {
            localStorage.setItem('hprof.drawerWidth', String(latest))
          } catch {
            // Storage can be unavailable in a restricted browser; the live width still works.
          }
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }

      function startChatResize(event) {
        event.preventDefault()
        const startY = event.clientY
        const startHeight = chatHeight
        let latest = startHeight
        const move = (moveEvent) => {
          latest = Math.min(600, Math.max(120, startHeight + (startY - moveEvent.clientY)))
          setChatHeight(latest)
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          try {
            localStorage.setItem('hprof.chatHeight', String(latest))
          } catch {
            // Storage can be unavailable in a restricted browser; the live height still works.
          }
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }

      const drillDown = tab === 'instances' || tab === 'path'
        || tab === 'classpaths' || tab === 'referrers'
      const tabs = [
        ['overview', '概览'], ['classes', '类'], ['retained', 'Retained'], ['leaks', '泄漏嫌疑'],
        ['strings', '字符串'], ['roots', 'Roots'], ['domtree', '支配树'],
        ['findings', '发现'], ['diff', '差分'],
      ]
      const tabMountKey = `${tab}-${mountNonce}`
      const selectedRowIdFor = (table) => (rowSelection?.table === table ? rowSelection.id : null)
      const initialFiltersFor = (table) => {
        if (filterOverride?.table === table) return filterOverride.filters
        if (tableFilters?.table === table) {
          const { table: ignored, ...values } = tableFilters
          return values
        }
        return readViewState(viewStorageRef.current, table).filters
      }
      const initialPageFor = (table) => {
        if (filterOverride?.table === table) return 0
        if (viewOverride?.table === table) return viewOverride.page
        return readViewState(viewStorageRef.current, table).page
      }
      const initialSortFor = (table) => {
        if (viewOverride?.table === table) return viewOverride.sort
        return readViewState(viewStorageRef.current, table).sort
      }
      const pageTitle = {
        overview: '概览',
        classes: '类',
        retained: 'Retained',
        leaks: '泄漏嫌疑',
        strings: '字符串',
        roots: 'GC Roots',
        domtree: '支配树',
        findings: '发现',
        diff: '差分',
      }[tab] ?? null
      let body
      if (!dumpsLoaded) body = h('div', { style: S.muted }, '正在读取 dump 列表…')
      else if (tab === 'overview') body = h(Overview, { dumpId: activeDumpId, onClass: openClass, onObject: openObject, onSelectRow: handleRowSelect })
      else if (tab === 'classes') body = h(ClassesTab, {
        key: tabMountKey,
        dumpId: activeDumpId, onClass: openClass, onClassPaths: openClassPaths,
        onSelectRow: handleRowSelect, onFiltersChange: handleFiltersChange,
        initialFilters: initialFiltersFor('classes'), selectedRowId: selectedRowIdFor('classes'),
        initialSort: initialSortFor('classes'), onViewChange: handleViewChange,
      })
      else if (tab === 'retained') body = h(RetainedTab, {
        key: tabMountKey,
        dumpId: activeDumpId, onObject: openObject,
        onSelectRow: handleRowSelect, onFiltersChange: handleFiltersChange,
        initialFilters: initialFiltersFor('retained'), selectedRowId: selectedRowIdFor('retained'),
        initialPage: initialPageFor('retained'), onViewChange: handleViewChange,
      })
      else if (tab === 'strings') body = h(StringsTab, {
        key: tabMountKey,
        dumpId: activeDumpId, onObject: openObject,
        onSelectRow: handleRowSelect, onFiltersChange: handleFiltersChange,
        initialFilters: initialFiltersFor('strings'), selectedRowId: selectedRowIdFor('strings'),
        initialPage: initialPageFor('strings'), onViewChange: handleViewChange,
      })
      else if (tab === 'roots') body = h(RootsTab, {
        key: tabMountKey,
        dumpId: activeDumpId, onObject: openObject,
        onSelectRow: handleRowSelect, onFiltersChange: handleFiltersChange,
        initialFilters: initialFiltersFor('roots'), selectedRowId: selectedRowIdFor('roots'),
        initialPage: initialPageFor('roots'), onViewChange: handleViewChange,
      })
      else if (tab === 'leaks') body = h(LeaksTab, {
        dumpId: activeDumpId, onClass: openClass, onClassPaths: openClassPaths,
      })
      else if (tab === 'domtree') body = h(DomTreeTab, {
        dumpId: activeDumpId, rootId: domRoot, onObject: openObject,
        treeCommand, onTreeChange: handleTreeChange,
        retainedSet, retainedSetLoading, onRetainedSet: computeRetainedSet,
      })
      else if (tab === 'findings') body = h(FindingsTab, {
        dumpId: activeDumpId,
        currentObjectId: drawerObjectId,
        currentClassInfo: classInfo,
        onObject: openObject,
        onClass: openClass,
      })
      else if (tab === 'instances') body = h(InstancesTab, {
        key: tabMountKey,
        dumpId: activeDumpId, classInfo, onObject: openObject, onPath: openPath, onBack: () => setTab('classes'),
        onSelectRow: handleRowSelect, onFiltersChange: handleFiltersChange,
        initialFilters: initialFiltersFor('instances'), selectedRowId: selectedRowIdFor('instances'),
        initialPage: initialPageFor('instances'), onViewChange: handleViewChange,
      })
      else if (tab === 'path') body = h(PathTab, { dumpId: activeDumpId, objectId: pathObjectId, onBack: () => setTab(returnTab) })
      else if (tab === 'classpaths') body = h(ClassPathsTab, {
        dumpId: activeDumpId, classInfo, onBack: () => setTab('classes'), onObject: openObject,
        treeCommand, onTreeChange: handleClassPathTreeChange, weakRequest,
        onStateChange: handleClassPathState,
      })
      else if (tab === 'referrers') body = h(ReferrersTab, {
        key: tabMountKey,
        dumpId: activeDumpId, objectId: referrersObjectId, onObject: openObject, onBack: () => setTab(returnTab),
        onSelectRow: handleRowSelect, selectedRowId: selectedRowIdFor('referrers'),
      })
      else if (tab === 'diff') body = h(DiffTab, { dumps, initialBase: dumps[0]?.dump_id, initialOther: dumps[1]?.dump_id })

      return h('div', { style: { height: '100%', minHeight: 360, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        h('div', { className: 'hp-header', style: S.header },
          onCloseWorkspace === undefined ? null : h(Btn, { onClick: onCloseWorkspace, ghost: true }, '← 对话'),
          h('span', { className: 'hp-region-label' },
            h('span', { className: 'hp-analysis-dot', 'aria-hidden': true }),
            '分析'),
          h('span', { style: S.hint }, hideChat ? 'workspace' : 'sidebar'),
          h('span', {
            className: `hp-sync-status${syncStatus.error === '' ? '' : ' hp-sync-status-error'}`,
            title: syncStatus.error === '' ? 'state/command 同步状态' : syncStatus.error,
          }, `state:${syncStatus.state} poll:${syncStatus.poll}`),
          h('select', {
            className: 'hp-select',
            style: S.select, value: activeDumpId ?? '',
            title: 'dump-N 是运行时编号；同一文件重新打开会分配新编号',
            onChange: (event) => {
              const next = event.target.value || null
              setDumpId(next)
              const entry = next === null ? undefined : dumps.find((dump) => dump.dump_id === next)
              if (entry !== undefined && typeof entry.file === 'string' && entry.file !== '') {
                setLastDump({ path: entry.file, dumpId: entry.dump_id })
                writeLastDumpPath(entry.file)
              }
              setClassInfo(null)
              closeDrawer()
              setPathObjectId(null)
              setReferrersObjectId(null)
              setDomRoot(0)
              setTab('overview')
            },
          },
            dumps.length === 0 ? h('option', { value: '' }, '没有打开的 dump') : null,
            dumps.map((dump) => h('option', { key: dump.dump_id, value: dump.dump_id },
              `${String(dump.file ?? '').split(/[\\/]/).pop()} · ${formatBytes(dump.file_size_bytes)} · ${dump.dump_id}`))),
          h('input', {
            className: 'hp-input',
            style: S.input, value: pathInput, placeholder: 'hprof 绝对路径（例如 D:\\dump\\a.hprof）',
            onChange: (event) => setPathInput(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') void openDump() },
          }),
          h(Btn, { primary: true, onClick: () => { void openDump() }, disabled: busy }, busy ? '处理中…' : '打开'),
          h('span', { style: { flex: '1 1 24px' } }),
          h(Btn, { onClick: () => { void refresh() }, disabled: busy }, '刷新'),
          h(Btn, { danger: true, onClick: closeDump, disabled: busy || activeDumpId === null }, '关闭 dump'),
          h(Btn, { onClick: writeReport, disabled: busy || activeDumpId === null }, '报告')),
        h('div', { className: 'hp-tabs', style: S.tabs }, tabs.map(([key, label]) => h('button', {
          key, type: 'button',
          className: (drillDown ? key === 'classes' : tab === key) ? 'hp-tab hp-tab-active' : 'hp-tab',
          onClick: () => {
            setTab(key)
            setRowSelection(null)
            setTableFilters(null)
            setViewState(null)
            setTreeExpanded([])
            setClassPathCollapsed([])
            setClassPathState(null)
            setTreeCommand(null)
            if (key === 'findings') return
            setClassInfo(null)
            closeDrawer()
            setPathObjectId(null)
            setReferrersObjectId(null)
            if (key === 'domtree') setDomRoot(0)
          },
        }, label))),
        h('div', { style: { flex: 1, display: 'flex', minHeight: 0 } },
          h('div', { style: { flex: 1, minWidth: 0, overflow: 'auto', padding: 10 } },
            pageTitle === null
              ? null
              : h('div', { className: 'hp-page-header' }, h('h2', { className: 'hp-page-title' }, pageTitle)),
            error === '' ? null : h('div', { style: { ...S.error, display: 'flex', gap: 8, alignItems: 'flex-start' } },
              h('span', { style: { flex: 1 } }, error),
              h('button', {
                type: 'button', className: 'hp-link', title: '关闭提示',
                onClick: () => setError(''),
              }, '关闭')),
            notice === '' ? null : h('div', { style: { ...S.notice, display: 'flex', gap: 8, alignItems: 'flex-start' } },
              h('span', { style: { flex: 1 } }, notice),
              h('button', {
                type: 'button', className: 'hp-link', title: '关闭提示',
                onClick: () => setNotice(''),
              }, '关闭')),
            dumpsLoaded && dumps.length === 0 && lastDump !== null
              ? h('div', {
                style: { ...S.notice, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
              },
                `上次打开的 dump 已关闭：${lastDump.path}`,
                h(Btn, { onClick: () => { void openDump(lastDump.path) } }, '重新打开'),
                h(Btn, {
                  onClick: () => {
                    clearLastDumpPath()
                    setLastDump(null)
                    setError('')
                  },
                }, '不再恢复'))
              : null,
            body),
          drawerObjectId === null
            ? null
            : h(Drawer, {
              width: drawerWidth,
              onResizeStart: startResize,
              onClose: closeDrawer,
              onBack: backObject,
              canBack: drawerStack.length > 0,
            }, h(ObjectDetail, {
              dumpId: activeDumpId,
              objectId: drawerObjectId,
              onObject: openObject,
              onPath: openPath,
              onReferrers: openReferrers,
              onClassPaths: openClassPaths,
              onDomTree: openDomTree,
            }))),
        hideChat
          ? null
          : h(ChatPanel, {
            open: chatOpen,
            height: chatHeight,
            onToggle: () => setChatOpen((value) => !value),
            onResizeStart: startChatResize,
            useChat: props.useChat,
            useInput: props.useInput,
            inputActions: props.inputActions,
            dumpId: activeDumpId,
            dumpFile: dumps.find((dump) => dump.dump_id === activeDumpId)?.file,
            draftCommand: chatDraftCommand,
          }))
    }

    function RetainedTab({ dumpId, onObject, onSelectRow, onFiltersChange, initialFilters, selectedRowId, initialPage, onViewChange }) {
      const [page, setPage] = useState(initialPage ?? 0)
      const { filters, applied, set, key } = useFilters({ idPrefix: '', query: '', minRetained: '', ...(initialFilters ?? {}) })
      const firstResetRef = useRef(true)
      useEffect(() => {
        if (firstResetRef.current) { firstResetRef.current = false; return }
        setPage(0)
      }, [key])
      useEffect(() => { onFiltersChange?.('retained', applied) }, [applied, onFiltersChange])
      useEffect(() => { onViewChange?.('retained', { page }) }, [page, onViewChange])
      const params = new URLSearchParams({ dump_id: dumpId ?? '', page: String(page), size: '100' })
      if (applied.idPrefix !== '') params.set('id_prefix', applied.idPrefix)
      if (applied.minRetained !== '' && Number.isFinite(Number(applied.minRetained))) params.set('min_retained', String(Number(applied.minRetained)))
      if (applied.query !== '') params.set('query', applied.query)
      const result = useFetch(dumpId ? `${API}/retained?${params}` : null)
      if (result.error !== null) return h('div', { style: S.error }, result.error)
      const items = result.data?.items ?? []
      const total = result.data?.total ?? 0
      return h('div', null,
        h('div', { style: S.row },
          h('span', { style: S.muted }, result.loading ? '加载中…' : `${total.toLocaleString()} 个对象`)),
        h(Section, { title: 'Retained 排行' }, h(Table, {
          columns: [
            { key: 'id', title: '对象', render: (row) => h('span', { style: S.mono }, hexId(row.id)) },
            { key: 'className', title: '类' },
            { key: 'retained', title: 'Retained', align: 'right', render: (row) => formatBytes(row.retained) },
            { key: 'shallow', title: 'Shallow', align: 'right', render: (row) => formatBytes(row.shallow) },
          ],
          filters: [
            { value: filters.idPrefix, onChange: (value) => set('idPrefix', value), placeholder: '搜索 ID' },
            { value: filters.query, onChange: (value) => set('query', value), placeholder: '搜索类名' },
            { value: filters.minRetained, onChange: (value) => set('minRetained', value), placeholder: '最小 Retained', type: 'number' },
            null,
          ],
          rows: items,
          onRowClick: (row) => onObject(row.id),
          onRowSelect: (row) => onSelectRow?.('retained', row),
          selectedRowId,
          empty: '没有数据',
        })),
        h('div', { style: { ...S.row, marginTop: 8 } },
          h(Btn, { onClick: () => setPage((value) => Math.max(0, value - 1)), disabled: page === 0 }, '上一页'),
          h('span', { style: S.muted }, `第 ${page + 1} 页`),
          h(Btn, { onClick: () => setPage((value) => value + 1), disabled: (page + 1) * 100 >= total }, '下一页')))
    }

    /** Composer shortcut that opens the HPROF workspace. */
    function OpenButton({ open }) {
      return h('button', {
        type: 'button',
        className: 'hp-btn',
        style: { fontSize: 11, padding: '2px 7px' },
        title: '打开 HPROF 工作区（左分析 + 右对话）',
        onClick: open,
      }, 'HPROF')
    }

    const TAB_ID = '@local/dsh-hprof-explorer'
    const TAB_KIND = 'hprof'
    const PANEL_ID = 'hprof'

    return {
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'layout'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-hprof-ui', '')
          style.textContent = UI_CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'hprof: styles')

        ctx.on('connection/reset', () => {
          clearDetailCache()
          autoRestoreDone = false
          notifyDumpInvalidated()
        })

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          children: {
            'hprof.conversation': { kind: 'single', scope: 'session-maybe' },
          },
          inject: () => ({ close: () => ctx.layout.selectPanel(null) }),
        }, HprofWorkspace))

        ctx.slots.inject('hprof.conversation', () => ctx.slots.register({
          name: 'hprof.conversation',
        }, HprofConversation))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 10,
          label: () => 'HPROF',
        }, HprofPanelIcon))

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => 'HPROF Explorer',
          guide: [{
            id: 'open',
            order: 20,
            title: () => 'HPROF Explorer',
            description: () => '分析 Android hprof 堆转储',
          }],
        }), 'hprof: tab type')

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, HprofTab))

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'hprof-explorer-open',
          order: 8,
          inject: () => ({ open: () => ctx.layout.selectPanel(PANEL_ID) }),
        }, OpenButton))
      },
    }
  },
})
