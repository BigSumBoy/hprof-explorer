/**
 * Model-facing UI action catalog.
 *
 * These are projections of the existing `ui.command` service operation. The
 * low-level API stays available; this catalog gives a model a flat, typed way
 * to call the same commands without reading client source.
 */

export const UI_MANIFEST = {
  version: 1,
  state_fields: [
    'dump_id', 'panel', 'client_id', 'tab', 'class_id', 'class_name',
    'object_id', 'path_object_id', 'referrers_object_id', 'row', 'filters',
    'page', 'sort', 'tree',
  ],
  actions: [
    {
      name: 'state',
      kind: 'read',
      description: 'Read live panel state, including panels and available actions.',
      params: { dump_id: 'string?', client_id: 'string?' },
      example: { action: 'state' },
    },
    {
      name: 'manifest',
      kind: 'read',
      description: 'Return this UI action catalog.',
      params: {},
      example: { action: 'manifest' },
    },
    {
      name: 'showClassPaths',
      kind: 'command',
      description: 'Select a class and open its GC-root paths. Unreachable objects are shown on the same page.',
      params: { class_id: 'number', class_name: 'string?', weak: 'boolean?', dump_id: 'string?', client_id: 'string?' },
      expands: ['selectClass', 'selectTab classpaths', 'setWeak?'],
      example: { action: 'showClassPaths', class_id: 1877222656, class_name: 'android.view.SurfaceControl', weak: true },
    },
    {
      name: 'showUnreachable',
      kind: 'command',
      description: 'Select a class and open its GC-root page where the unreachable object list is visible.',
      params: { class_id: 'number', class_name: 'string?', weak: 'boolean?', dump_id: 'string?', client_id: 'string?' },
      expands: ['selectClass', 'selectTab classpaths', 'setWeak?'],
      example: { action: 'showUnreachable', class_id: 1877222656, weak: true },
    },
    {
      name: 'selectTab',
      kind: 'command',
      description: 'Switch the analysis tab.',
      params: { tab: 'string', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'selectTab', tab: 'classes' },
    },
    {
      name: 'selectClass',
      kind: 'command',
      description: 'Open a class instance list.',
      params: { class_id: 'number', class_name: 'string?', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'selectClass', class_id: 1877222656, class_name: 'android.view.SurfaceControl' },
    },
    {
      name: 'selectObject',
      kind: 'command',
      description: 'Open an object drawer.',
      params: { object_id: 'number', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'selectObject', object_id: 82738040 },
    },
    {
      name: 'selectRow',
      kind: 'command',
      description: 'Select a row in the active table.',
      params: { table: 'classes|instances|retained|strings|roots|referrers', row_id: 'number', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'selectRow', table: 'classes', row_id: 1877222656 },
    },
    {
      name: 'setFilters',
      kind: 'command',
      description: 'Replace filters for a filterable tab. Inspect state.filters for the current keys.',
      params: { tab: 'classes|instances|strings|roots|retained', filters: 'object', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'setFilters', tab: 'classes', filters: { query: 'Surface' } },
    },
    {
      name: 'setPage',
      kind: 'command',
      description: 'Set a zero-based page for a paged tab.',
      params: { tab: 'instances|strings|roots|retained', page: 'number', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'setPage', tab: 'roots', page: 1 },
    },
    {
      name: 'setSort',
      kind: 'command',
      description: 'Set class table sort order.',
      params: { sort: 'bytes|count|name', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'setSort', sort: 'count' },
    },
    {
      name: 'toggleDominatorNode',
      kind: 'command',
      description: 'Expand or collapse one node in the dominator tree.',
      params: { node_id: 'number', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'toggleDominatorNode', node_id: 204821672 },
    },
    {
      name: 'toggleClassPathNode',
      kind: 'command',
      description: 'Expand or collapse one visible class-path tree row. Prefer node_index over opaque keys.',
      params: { node_index: 'number?', node_key: 'string?', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'toggleClassPathNode', node_index: 0 },
    },
    {
      name: 'setWeak',
      kind: 'command',
      description: 'Set the weak-reference switch on the class-path view.',
      params: { weak: 'boolean', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'setWeak', weak: true },
    },
    {
      name: 'draftMessage',
      kind: 'command',
      description: 'Fill the bottom Chat composer without sending.',
      params: { text: 'string', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'draftMessage', text: 'Summarize the SurfaceControl findings.' },
    },
    {
      name: 'refresh',
      kind: 'command',
      description: 'Refresh the dump list and reload the active tab.',
      params: { dump_id: 'string?', client_id: 'string?' },
      example: { action: 'refresh' },
    },
    {
      name: 'runReport',
      kind: 'command',
      description: 'Generate a Markdown report including findings.',
      params: { dump_id: 'string?', client_id: 'string?' },
      example: { action: 'runReport' },
    },
    {
      name: 'closeDump',
      kind: 'command',
      description: 'Close the active dump.',
      params: { dump_id: 'string?', client_id: 'string?' },
      example: { action: 'closeDump' },
    },
    {
      name: 'closeDrawer',
      kind: 'command',
      description: 'Close the object drawer.',
      params: { dump_id: 'string?', client_id: 'string?' },
      example: { action: 'closeDrawer' },
    },
    {
      name: 'openDump',
      kind: 'command',
      description: 'Open a dump path, or select an already-open dump id.',
      params: { path: 'string?', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'openDump', path: 'D:/dump/a.hprof' },
    },
    {
      name: 'notice',
      kind: 'command',
      description: 'Show a short notice in the panel.',
      params: { text: 'string', dump_id: 'string?', client_id: 'string?' },
      example: { action: 'notice', text: 'Selected SurfaceControl' },
    },
  ],
}
