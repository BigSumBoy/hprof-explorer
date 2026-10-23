'use strict';

const $ = (sel) => document.querySelector(sel);
const state = {
  summary: null,
  tab: 'overview',
  classSort: 'bytes',
  objectFilter: null,
  objectPage: 0,
  stringPage: 0,
  stringReadable: true,
  rootPage: 0,
  retainedPage: 0,
  filters: {
    classes: { q: '', minCount: '', minBytes: '' },
    objects: { id: '', className: '', heap: '', minSize: '' },
    strings: { id: '', minLength: '', q: '' },
    roots: { id: '', className: '', type: '', heap: '' },
    retained: { id: '', className: '', minRetained: '' },
    tree: { q: '' },
  },
};

const treeState = {
  root: 0,
  returnDetail: null,
  children: new Map(), // parent id -> { items, total }
  expanded: new Set(),
  loading: new Set(),
};

const detailStack = []; // { id, scrollTop } — object detail back navigation

const RECORD_NAMES = {
  1: 'STRING',
  2: 'LOAD_CLASS',
  4: 'STACK_FRAME',
  5: 'STACK_TRACE',
  12: 'HEAP_DUMP',
  28: 'HEAP_DUMP_SEGMENT',
  44: 'HEAP_DUMP_END',
  160: 'ART_CLOCK',
};

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtBytes = (n) => {
  n = Number(n);
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
const fmtId = (n) => `0x${(n >>> 0).toString(16)}`;
const qs = (params) => new URLSearchParams(params).toString();

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setTab(name) {
  if (!$('#drawer').hidden) closeDrawer();
  state.tab = name;
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((el) => el.classList.toggle('active', el.id === `panel-${name}`));
  if (name === 'classes' && !$('#classRows').dataset.loaded) loadClasses();
  if (name === 'strings' && !$('#stringRows').dataset.loaded) loadStrings();
  if (name === 'roots' && !$('#rootRows').dataset.loaded) loadRoots();
  if (name === 'retained' && !$('#retainedRows').dataset.loaded) loadRetained();
  if (name === 'objects' && !state.objectFilter) $('#objectRows').innerHTML = '<tr><td colspan="5"><div class="empty">先到「类直方图」选择一个类，或从对象详情里点引用跳转。</div></td></tr>';
}

function renderSummary(summary) {
  state.summary = summary;
  const file = summary.file.split(/[\\/]/).pop();
  $('#fileLine').textContent = `${file} · ${fmtBytes(summary.fileSize)}`;
  const counts = summary.counts;
  $('#pills').innerHTML = [
    `${fmtInt(counts.classes)} classes`,
    `${fmtInt(counts.instances + counts.objectArrays + counts.primitiveArrays)} objects`,
    `${fmtInt(counts.stringInstances)} strings`,
    `${fmtInt(counts.roots)} roots`,
  ].map((t) => `<span class="pill">${esc(t)}</span>`).join('');

  const cards = [
    ['类', fmtInt(counts.classes), 'LOAD_CLASS / CLASS_DUMP'],
    ['实例对象', fmtInt(counts.instances), `${fmtBytes(summary.bytes.instanceData)} 字段数据`],
    ['对象数组', fmtInt(counts.objectArrays), fmtBytes(summary.bytes.objectArrays)],
    ['基本类型数组', fmtInt(counts.primitiveArrays), fmtBytes(summary.bytes.primitiveArrays)],
    ['字符串', fmtInt(counts.stringInstances), 'java.lang.String'],
    ['GC Roots', fmtInt(counts.roots), '含重复根'],
  ];
  $('#statCards').innerHTML = cards.map(([k, v, s]) => `
    <div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');

  const max = Math.max(1, ...summary.topClasses.map((c) => c.bytes));
  $('#topClassRows').innerHTML = summary.topClasses.map((c) => `
    <tr class="clickable" data-class-kind="${c.kind}" data-class-id="${c.id}" data-class-name="${esc(c.name)}">
      <td class="name">${esc(c.name)}</td>
      <td class="num">${fmtInt(c.count)}</td>
      <td class="num">${fmtBytes(c.bytes)}</td>
      <td class="barcell"><div class="bar"><span style="width:${Math.max(1, (c.bytes / max) * 100).toFixed(1)}%"></span></div></td>
      <td class="go">›</td>
    </tr>`).join('');

  const rootEntries = Object.entries(summary.rootCounts).sort((a, b) => b[1] - a[1]);
  $('#rootSummaryRows').innerHTML = rootEntries.map(([k, v]) => `
    <tr><td>${esc(k)}</td><td class="num">${fmtInt(v)}</td></tr>`).join('');

  $('#topStringList').innerHTML = summary.topStrings.map((s) => `
    <div class="string-item" data-detail-id="${s.id}">
      <span class="len">${fmtInt(s.length)}</span>
      <span class="txt">${esc(s.text.replace(/\s+/g, ' '))}</span>
    </div>`).join('') || '<div class="empty">没有字符串</div>';

  const records = Object.entries(summary.records)
    .map(([tag, n]) => `${RECORD_NAMES[tag] || `0x${Number(tag).toString(16)}`} × ${fmtInt(n)}`)
    .join('，');
  $('#fileMeta').innerHTML = `
    <dt>格式</dt><dd>${esc(summary.version)}</dd>
    <dt>ID 宽度</dt><dd>${summary.idSize} 字节</dd>
    <dt>总大小</dt><dd>${fmtBytes(summary.fileSize)}</dd>
    <dt>dump 时间</dt><dd>${esc(new Date(summary.timestamp).toLocaleString())}</dd>
    <dt>解析耗时</dt><dd>${fmtInt(summary.parseMs)} ms</dd>
    <dt>逻辑堆</dt><dd>${esc(summary.heaps.join(', '))}</dd>
    <dt>记录</dt><dd>${esc(records)}</dd>`;
}

async function loadClasses() {
  const body = $('#classRows');
  body.dataset.loaded = '1';
  body.innerHTML = '<tr><td colspan="5"><div class="empty">加载中…</div></td></tr>';
  try {
    const f = state.filters.classes;
    const data = await api(`/api/classes?${qs({
      q: f.q,
      sort: state.classSort,
      minCount: f.minCount,
      minBytes: f.minBytes,
    })}`);
    const items = data.items.slice(0, 500);
    const max = Math.max(1, ...items.map((c) => c.bytes));
    body.innerHTML = items.map((c) => `
      <tr class="clickable" data-class-kind="${c.kind}" data-class-id="${c.id}" data-class-name="${esc(c.name)}">
        <td class="name">${esc(c.name)}</td>
        <td class="num">${fmtInt(c.count)}</td>
        <td class="num">${fmtBytes(c.bytes)}</td>
        <td class="barcell"><div class="bar"><span style="width:${Math.max(1, (c.bytes / max) * 100).toFixed(1)}%"></span></div></td>
      <td class="go">›</td>
      </tr>`).join('') || '<tr><td colspan="5"><div class="empty">没有匹配的类</div></td></tr>';
    $('#classCount').textContent = `${fmtInt(data.total)} 个类`;
    $('#classNote').textContent = data.total > items.length ? `仅显示前 ${items.length} 条，继续输入以缩小范围。` : '';
  } catch (error) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty">${esc(error.message)}</div></td></tr>`;
  }
}

function openObjects(kind, id, name) {
  state.objectFilter = { kind, id, name };
  state.objectPage = 0;
  state.filters.objects = { id: '', className: '', heap: '', minSize: '' };
  document.querySelectorAll('[data-filter^="objects."]').forEach((input) => { input.value = ''; });
  setTab('objects');
  $('#objectCrumb').innerHTML = `${esc(name)} <span class="sub">${kind === 'primitive' ? '基本类型数组' : '类'}</span>`;
  const pathButton = $('#objectClassPaths');
  pathButton.hidden = false;
  pathButton.dataset.kind = kind;
  pathButton.dataset.id = id;
  pathButton.dataset.name = name;
  loadObjects();
}

async function loadObjects() {
  if (!state.objectFilter) return;
  const { kind, id } = state.objectFilter;
  const body = $('#objectRows');
  body.innerHTML = '<tr><td colspan="5"><div class="empty">加载中…</div></td></tr>';
  try {
    const f = state.filters.objects;
    const data = await api(`/api/instances?${qs({
      kind,
      id,
      page: state.objectPage,
      size: 50,
      fid: f.id,
      className: f.className,
      heap: f.heap,
      minSize: f.minSize,
    })}`);
    body.innerHTML = data.items.map((o) => `
      <tr class="clickable" data-detail-id="${o.id}">
        <td class="name id">${fmtId(o.id)}</td>
        <td class="name">${esc(o.className)}</td>
        <td>${esc(o.heap)}</td>
        <td class="num">${fmtBytes(o.size)}</td>
        <td class="go">›</td>
      </tr>`).join('') || '<tr><td colspan="5"><div class="empty">没有对象</div></td></tr>';
    renderPager($('#objectPager'), data, (page) => { state.objectPage = page; loadObjects(); });
  } catch (error) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty">${esc(error.message)}</div></td></tr>`;
  }
}

async function loadStrings() {
  const body = $('#stringRows');
  body.dataset.loaded = '1';
  body.innerHTML = '<tr><td colspan="4"><div class="empty">加载中…</div></td></tr>';
  try {
    const f = state.filters.strings;
    const data = await api(`/api/strings?${qs({
      page: state.stringPage,
      size: 50,
      q: f.q,
      fid: f.id,
      minLength: f.minLength,
      readable: state.stringReadable ? '1' : '',
    })}`);
    body.innerHTML = data.items.map((s) => `
      <tr class="clickable" data-detail-id="${s.id}">
        <td class="name id">${fmtId(s.id)}</td>
        <td class="num">${fmtInt(s.length)}</td>
        <td class="name">${esc(s.text.replace(/\s+/g, ' '))}${s.binary ? '<span class="badge">binary</span>' : ''}</td>
        <td class="go">›</td>
      </tr>`).join('') || '<tr><td colspan="4"><div class="empty">没有匹配的字符串</div></td></tr>';
    $('#stringCount').textContent = `${fmtInt(data.total)} 个字符串`;
    renderPager($('#stringPager'), data, (page) => { state.stringPage = page; loadStrings(); });
  } catch (error) {
    body.innerHTML = `<tr><td colspan="4"><div class="empty">${esc(error.message)}</div></td></tr>`;
  }
}

async function loadRetained() {
  const body = $('#retainedRows');
  body.dataset.loaded = '1';
  body.innerHTML = '<tr><td colspan="7"><div class="empty">加载中…</div></td></tr>';
  try {
    const f = state.filters.retained;
    const data = await api(`/api/retained?${qs({
      page: state.retainedPage,
      size: 50,
      fid: f.id,
      className: f.className,
      minRetained: f.minRetained,
    })}`);
    const max = Math.max(1, ...data.items.map((i) => i.retained));
    body.innerHTML = data.items.map((o, i) => `
      <tr class="clickable" data-detail-id="${o.id}">
        <td class="num">${state.retainedPage * 50 + i + 1}</td>
        <td class="name id">${fmtId(o.id)}</td>
        <td class="name">${esc(o.className || '—')}</td>
        <td class="num">${fmtBytes(o.shallow)}</td>
        <td class="num">${fmtBytes(o.retained)}</td>
        <td class="barcell"><div class="bar"><span style="width:${Math.max(1, (o.retained / max) * 100).toFixed(1)}%"></span></div></td>
        <td class="go">›</td>
      </tr>`).join('') || '<tr><td colspan="7"><div class="empty">没有支配数据</div></td></tr>';
    $('#retainedCount').textContent = `前 ${fmtInt(data.total)} 名`;
    renderPager($('#retainedPager'), data, (page) => { state.retainedPage = page; loadRetained(); });
  } catch (error) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty">${esc(error.message)}</div></td></tr>`;
  }
}

async function loadTreeRoot(rootId = 0, reset = true) {
  treeState.root = rootId;
  if (reset) {
    treeState.children.clear();
    treeState.expanded.clear();
  }
  await fetchTreeChildren(rootId, false);
  const entry = treeState.children.get(rootId);
  const parent = entry?.parent;
  $('#treeCrumb').innerHTML = rootId === 0
    ? '支配树 <span class="sub">从 GC Roots / Classes 开始</span>'
    : `支配树 <span class="sub">根：${esc(parent?.className || 'object')} @${fmtId(rootId)}</span>`;
  $('#treeBack').hidden = rootId === 0;
  $('#treeReturnDetail').hidden = !treeState.returnDetail;
  renderTree();
}

function openTree(rootId, returnDetail = null) {
  treeState.returnDetail = returnDetail;
  setTab('domtree');
  loadTreeRoot(rootId);
}

const classPathState = { kind: 'class', id: 0, className: '', weak: false, mode: 'tree', data: null };

async function openClassPaths(kind, id, className) {
  classPathState.kind = kind;
  classPathState.id = id;
  classPathState.className = className;
  classPathState.weak = false;
  classPathState.mode = 'tree';
  classPathState.data = null;
  $('#classPathsWeak').checked = false;
  $('#classPathTitle').textContent = className;
  $('#classPathModal').hidden = false;
  $('#modalOverlay').hidden = false;
  updateClassPathMode();
  await loadClassPaths();
}

async function loadClassPaths() {
  $('#classPathSub').textContent = '加载中…';
  $('#classPathBody').innerHTML = '<div class="empty">正在计算最短 GC Root 路径…</div>';
  try {
    const data = await api(`/api/classpaths?${qs({
      kind: classPathState.kind,
      id: classPathState.id,
      weak: classPathState.weak ? '1' : '',
    })}`);
    classPathState.data = data;
    renderClassPaths(data);
  } catch (error) {
    $('#classPathBody').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function closeClassPaths() {
  $('#classPathModal').hidden = true;
  $('#modalOverlay').hidden = true;
}

function updateClassPathMode() {
  $('#classPathModeTree').classList.toggle('active', classPathState.mode === 'tree');
  $('#classPathModeText').classList.toggle('active', classPathState.mode === 'text');
}

function renderClassPaths(data) {
  const notes = [];
  if (data.sampled) notes.push(`对象过多，仅分析前 ${fmtInt(data.scanned)} 个`);
  if (data.unreachable) notes.push(`${fmtInt(data.unreachable)} 个${data.includeWeak ? '' : '强引用'}不可达`);
  if (data.groupCount > data.groups.length) notes.push(`仅展示前 ${data.groups.length} 组`);
  if (data.includeWeak) notes.push('包含弱引用');
  $('#classPathSub').textContent = [
    `${fmtInt(data.totalObjects)} 个对象`,
    `${fmtInt(data.reachable)} 可达`,
    `${fmtInt(data.groupCount)} 组最短路径`,
    ...notes,
  ].join(' · ');
  if (!data.groups.length) {
    $('#classPathBody').innerHTML = '<div class="empty">没有可达对象（可能都是垃圾对象）</div>';
    return;
  }
  $('#classPathBody').innerHTML = classPathState.mode === 'tree'
    ? renderPathTree(data.groups)
    : renderPathGroups(data.groups);
}

function renderPathGroups(groups) {
  return groups.map((group) => `
    <div class="path-group">
      <div class="path-group-head"><b>${fmtInt(group.count)}</b> 个对象 · Shallow ${fmtBytes(group.shallow)}</div>
      <div class="path-chain">${group.steps.map((step, index) => `
        ${index > 0 ? `<span class="chain-via">—${esc(step.via || '?')}→</span>` : ''}
        <span class="chain-node">${esc(step.className)}</span>`).join('')}
      </div>
      <div class="path-samples">示例：${group.samples.map((s) => `<span class="ref" data-sample-id="${s.id}">${fmtId(s.id)}</span>`).join(' ')}</div>
    </div>`).join('');
}

function renderPathTree(groups) {
  const root = { className: '<root>', via: null, count: 0, children: new Map() };
  for (const group of groups) {
    let node = root;
    node.count += group.count;
    for (let i = 1; i < group.steps.length; i++) {
      const step = group.steps[i];
      const key = `${step.className}\u0001${step.via ?? ''}`;
      let child = node.children.get(key);
      if (!child) {
        child = { className: step.className, via: step.via, count: 0, children: new Map() };
        node.children.set(key, child);
      }
      child.count += group.count;
      node = child;
    }
  }
  const renderNode = (node, depth) => {
    const children = [...node.children.values()].sort((a, b) => b.count - a.count);
    return `<div class="pt-line" style="padding-left:${depth * 18}px">
        ${node.via ? `<span class="chain-via">—${esc(node.via)}→</span>` : ''}
        <span class="chain-node">${esc(node.className)}</span>
        <span class="pt-count">${fmtInt(node.count)}</span>
      </div>${children.map((child) => renderNode(child, depth + 1)).join('')}`;
  };
  return `<div class="path-tree">${renderNode(root, 0)}</div>`;
}

async function fetchTreeChildren(parentId, append) {
  if (treeState.loading.has(parentId)) return;
  treeState.loading.add(parentId);
  try {
    const entry = treeState.children.get(parentId);
    const offset = append && entry ? entry.items.length : 0;
    const data = await api(`/api/domtree?${qs({ parent: parentId, offset, limit: 100 })}`);
    if (append && entry) {
      entry.items.push(...data.items);
      entry.total = data.total;
    } else {
      treeState.children.set(parentId, { items: data.items, total: data.total, parent: data.parent });
    }
  } finally {
    treeState.loading.delete(parentId);
  }
}

async function toggleTree(id) {
  if (treeState.expanded.has(id)) {
    treeState.expanded.delete(id);
  } else {
    if (!treeState.children.has(id)) await fetchTreeChildren(id, false);
    treeState.expanded.add(id);
  }
  renderTree();
}

function renderTree() {
  const body = $('#treeRows');
  const q = (state.filters.tree.q ?? '').trim().toLowerCase();
  const raw = q.startsWith('0x') ? q.slice(2) : q;
  const matches = (item) => {
    if (!q) return true;
    return item.className.toLowerCase().includes(q)
      || (item.id >>> 0).toString(16).startsWith(raw)
      || String(item.id).startsWith(q);
  };
  const rows = [];
  const walk = (parentId, depth) => {
    const entry = treeState.children.get(parentId);
    if (!entry) return;
    for (const item of entry.items) {
      if (!matches(item)) continue;
      const hasChildren = item.children > 0;
      const open = treeState.expanded.has(item.id);
      const pad = 10 + depth * 18;
      rows.push(`
        <tr class="clickable tree-row" data-detail-id="${item.id}">
          <td class="tree-name" style="padding-left:${pad}px">
            ${hasChildren
              ? `<button class="expander" data-expand="${item.id}" title="${open ? '收起' : '展开'}">${open ? '▾' : '▸'}</button>`
              : '<span class="expander placeholder"></span>'}
            <span class="tree-class">${esc(item.className || '—')}</span>
            <span class="tree-id">${fmtId(item.id)}</span>
          </td>
          <td class="num">${fmtBytes(item.shallow)}</td>
          <td class="num">${fmtBytes(item.retained)}</td>
          <td class="num">${fmtInt(item.children)}</td>
          <td class="go">›</td>
        </tr>`);
      if (open) walk(item.id, depth + 1);
    }
    if (entry.total > entry.items.length) {
      rows.push(`<tr class="tree-more"><td colspan="5"><button class="button" data-more="${parentId}">显示更多（还有 ${fmtInt(entry.total - entry.items.length)} 个）</button></td></tr>`);
    }
  };
  walk(treeState.root, 0);
  body.innerHTML = rows.join('') || '<tr><td colspan="5"><div class="empty">没有支配数据</div></td></tr>';
}

async function loadRoots() {
  const body = $('#rootRows');
  body.dataset.loaded = '1';
  body.innerHTML = '<tr><td colspan="5"><div class="empty">加载中…</div></td></tr>';
  try {
    const f = state.filters.roots;
    const data = await api(`/api/roots?${qs({
      page: state.rootPage,
      size: 50,
      fid: f.id,
      className: f.className,
      type: f.type,
      heap: f.heap,
    })}`);
    body.innerHTML = data.items.map((r) => `
      <tr class="clickable" data-detail-id="${r.id}">
        <td class="name id">${fmtId(r.id)}</td>
        <td class="name">${esc(r.className || '—')}</td>
        <td><span class="chip root">${esc(r.type)}</span></td>
        <td>${esc(r.heap)}</td>
        <td class="go">›</td>
      </tr>`).join('') || '<tr><td colspan="5"><div class="empty">没有根</div></td></tr>';
    renderPager($('#rootPager'), data, (page) => { state.rootPage = page; loadRoots(); });
  } catch (error) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty">${esc(error.message)}</div></td></tr>`;
  }
}

function renderPager(el, data, go) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  el.innerHTML = '';
  const prev = document.createElement('button');
  prev.textContent = '上一页';
  prev.disabled = data.page <= 0;
  prev.onclick = () => go(data.page - 1);
  const next = document.createElement('button');
  next.textContent = '下一页';
  next.disabled = data.page + 1 >= pages;
  next.onclick = () => go(data.page + 1);
  const label = document.createElement('span');
  label.textContent = `第 ${data.page + 1} / ${pages} 页 · ${fmtInt(data.total)} 项`;
  el.append(prev, label, next);
}

function valueCell(value) {
  if (value === null || value === undefined) return '<span class="muted">null</span>';
  if (typeof value === 'object' && value.id != null) {
    const preview = value.preview ? ` “${esc(value.preview)}”` : '';
    return `<span class="ref" data-detail-id="${value.id}">${esc(value.name || '?')} <small>@${fmtId(value.id)}</small></span>${preview}`;
  }
  if (typeof value === 'string') return `<span class="ref">${esc(value)}</span>`;
  return esc(String(value));
}

async function openDetail(id, options = {}) {
  const drawer = $('#drawer');
  const overlay = $('#overlay');
  const wasOpen = !drawer.hidden;
  const push = options.push !== false;
  if (!wasOpen) {
    detailStack.length = 0;
  } else if (options.saveScroll !== false) {
    const current = detailStack[detailStack.length - 1];
    if (current) current.scrollTop = $('#drawerBody').scrollTop;
  }
  if ((!wasOpen || push) && detailStack[detailStack.length - 1]?.id !== id) {
    detailStack.push({ id, scrollTop: 0 });
  }
  drawer.hidden = false;
  overlay.hidden = false;
  $('#drawerKind').textContent = '加载中';
  $('#drawerTitle').textContent = fmtId(id);
  $('#drawerSub').textContent = '';
  $('#drawerBody').innerHTML = '<div class="empty">加载中…</div>';
  updateDetailBack();
  try {
    const detail = await api(`/api/object?id=${id}`);
    renderDetail(detail);
    updateDetailBack();
    if (options.withPath) findPath(id);
    if (options.restoreScroll) {
      const current = detailStack[detailStack.length - 1];
      $('#drawerBody').scrollTop = current?.scrollTop ?? 0;
    }
  } catch (error) {
    $('#drawerBody').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function updateDetailBack() {
  const button = $('#drawerBack');
  if (!button) return;
  const canGoBack = detailStack.length > 1;
  button.textContent = canGoBack ? '← 返回' : '← 关闭';
  button.title = canGoBack ? '返回上一级（Alt+←）' : '关闭（Esc）';
}

function goBackDetail() {
  if (detailStack.length > 1) {
    detailStack.pop();
    const previous = detailStack[detailStack.length - 1];
    openDetail(previous.id, { push: false, saveScroll: false, restoreScroll: true });
  } else {
    closeDrawer();
  }
}

function renderDetail(detail) {
  const isClass = detail.kind === 'class';
  const cls = isClass ? detail.class : null;
  $('#drawerKind').textContent = isClass ? 'class' : detail.kind;
  $('#drawerTitle').textContent = isClass ? cls.name : (detail.className || fmtId(detail.id));
  const bits = [`id ${fmtId(detail.id)}`];
  if (!isClass) {
    bits.push(`heap ${detail.heap}`, `${fmtBytes(detail.size)}`);
    if (detail.isRoot && detail.isRoot.length) bits.push(`root ${detail.isRoot.join('/')}`);
  }
  $('#drawerSub').textContent = bits.join(' · ');

  const parts = [];
  if (detail.retained) {
    parts.push(`
      <div class="section"><h3>大小</h3>
        <dl class="kv">
          <dt>Shallow size</dt><dd>${fmtBytes(detail.retained.shallow)}</dd>
          <dt>Retained size</dt><dd>${fmtBytes(detail.retained.retained)}</dd>
          <dt>直接支配者</dt><dd>${detail.retained.dominator
            ? `<span class="ref" data-detail-id="${detail.retained.dominator.id}">${esc(detail.retained.dominator.className)} @${fmtId(detail.retained.dominator.id)}</span>`
            : '—（根对象或不可达）'}</dd>
        </dl>
      </div>`);
  }
  if (isClass) {
    parts.push(`
      <div class="section"><h3>类信息</h3>
        <dl class="kv">
          <dt>类名</dt><dd>${esc(cls.name)}</dd>
          <dt>父类</dt><dd>${cls.superName ? `<span class="ref" data-detail-id="${cls.superId}">${esc(cls.superName)}</span>` : '—'}</dd>
          <dt>实例大小</dt><dd>${fmtBytes(cls.instanceSize)}</dd>
          <dt>实例 / 字节</dt><dd>${fmtInt(cls.count)} / ${fmtBytes(cls.bytes)}</dd>
          <dt>class loader</dt><dd>${cls.loaderId ? `<span class="ref" data-detail-id="${cls.loaderId}">${fmtId(cls.loaderId)}</span>` : '—'}</dd>
        </dl>
      </div>`);
    parts.push(`<div class="section"><h3>GC Root 分析</h3>
      <button class="button" id="classPathsBtn" type="button">分析该类所有对象的 GC Root 路径</button>
      </div>`);
    parts.push(`<div class="section"><h3>声明的实例字段（${cls.fields.length}）</h3>
      <table class="field-table"><thead><tr><th>字段</th><th>类型</th></tr></thead><tbody>
      ${cls.fields.map((f) => `<tr><td class="fname">${esc(f.name)}</td><td class="ftype">${esc(f.typeName)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">无</td></tr>'}
      </tbody></table></div>`);
    parts.push(`<div class="section"><h3>静态字段（${cls.statics.length}）</h3>
      <table class="field-table"><thead><tr><th>字段</th><th>类型</th><th>值</th></tr></thead><tbody>
      ${cls.statics.map((s) => `<tr><td class="fname">${esc(s.name)}</td><td class="ftype">${esc(s.typeName)}</td><td class="fval">${valueCell(s.value)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">无</td></tr>'}
      </tbody></table></div>`);
  } else if (detail.kind === 'instance') {
    if (detail.string !== undefined) {
      const text = detail.string.length > 20000 ? `${detail.string.slice(0, 20000)}\n…（已截断）` : detail.string;
      parts.push(`<div class="section"><h3>字符串内容（${fmtInt(detail.string.length)} 字符）</h3>
        ${detail.stringBinary ? '<div class="muted" style="margin-bottom:8px">这段内容包含大量控制字符 / 非字符，可能是二进制数据而不是正常文本。</div>' : ''}
        <pre class="text">${esc(text)}</pre></div>`);
    }
    parts.push(`<div class="section"><h3>字段（${detail.fields.length}）</h3>
      <table class="field-table"><thead><tr><th>字段</th><th>类型</th><th>值</th></tr></thead><tbody>
      ${detail.fields.map((f) => `<tr><td class="fname">${esc(f.name)}${f.weak ? '<span class="badge">weak</span>' : ''}</td><td class="ftype">${esc(f.type)}</td><td class="fval">${valueCell(f.value)}</td></tr>`).join('')}
      </tbody></table></div>`);
  } else if (detail.kind === 'objectArray') {
    const items = detail.elements.map((v, i) => `<tr><td class="ftype">[${i}]</td><td class="fval">${valueCell(v)}</td></tr>`).join('');
    parts.push(`<div class="section"><h3>数组元素（长度 ${fmtInt(detail.length)}）</h3>
      <table class="field-table"><tbody>${items || '<tr><td class="muted">空数组</td></tr>'}</tbody></table>
      ${detail.truncated ? '<div class="muted">仅显示前 500 个元素</div>' : ''}</div>`);
  } else if (detail.kind === 'primitiveArray') {
    parts.push(`<div class="section"><h3>${esc(detail.elementType)}（长度 ${fmtInt(detail.length)}）</h3>
      <div class="values">${detail.values.map((v, i) => `<div title="${i}">${esc(String(v))}</div>`).join('')}</div>
      ${detail.truncated ? '<div class="muted">仅显示前 200 个元素</div>' : ''}</div>`);
  }

  parts.push(`
    <div class="section">
      <h3>引用与路径</h3>
      <button class="button primary" id="findRefs">查找引用它的对象</button>
      <button class="button" id="findPath" style="margin-left:8px">最短 GC 路径</button>
      <label class="check" style="margin-left:8px"><input id="includeWeak" type="checkbox"> 包含弱引用</label>
      <button class="button" id="showSubtree" style="margin-left:8px">查看支配子树</button>
      <div id="refBox"></div>
      <div id="pathBox"></div>
    </div>`);

  $('#drawerBody').innerHTML = parts.join('');
  $('#findRefs').onclick = () => findReferrers(detail.id);
  $('#findPath').onclick = () => findPath(detail.id);
  $('#showSubtree').onclick = () => openTree(detail.id, detail.id);
  const classPathsBtn = $('#classPathsBtn');
  if (classPathsBtn) classPathsBtn.onclick = () => openClassPaths('class', detail.id, detail.class.name);
}

async function findPath(id) {
  const box = $('#pathBox');
  const weak = $('#includeWeak')?.checked === true;
  box.innerHTML = '<div class="muted" style="margin-top:8px">计算引用链…</div>';
  try {
    const data = await api(`/api/path?${qs({ id, weak: weak ? '1' : '' })}`);
    if (!data.found) {
      box.innerHTML = `<div class="muted" style="margin-top:8px">该对象${weak ? '' : '在强引用下'}不可达（没有到 GC Root 的引用链）${weak ? '' : '；可勾选“包含弱引用”再试'}。</div>`;
      return;
    }
    box.innerHTML = `<div class="muted" style="margin:8px 0">最短 ${fmtInt(data.distance)} 跳 · ${data.path.length} 个节点${weak ? ' · 包含弱引用' : ''}</div>
      <table class="field-table path-table"><thead><tr><th>对象</th><th>类</th><th>经由</th></tr></thead><tbody>
      ${data.path.map((s) => `<tr>
        <td class="fval"><span class="ref" data-detail-id="${s.id}">${fmtId(s.id)}</span></td>
        <td class="fname">${esc(s.className || '—')}</td>
        <td class="ftype">${esc(s.via || '—')}</td>
      </tr>`).join('')}
      </tbody></table>`;
  } catch (error) {
    box.innerHTML = `<div class="muted" style="margin-top:8px">${esc(error.message)}</div>`;
  }
}

async function findReferrers(id) {
  const box = $('#refBox');
  box.innerHTML = '<div class="muted" style="margin-top:8px">扫描中（可能几秒）…</div>';
  try {
    const data = await api(`/api/referrers?id=${id}`);
    if (!data.items.length) {
      box.innerHTML = '<div class="muted" style="margin-top:8px">没有找到引用（可能是根对象或扫描被截断）。</div>';
      return;
    }
    box.innerHTML = `<div class="muted" style="margin:8px 0">${fmtInt(data.items.length)} 个引用${data.truncated ? '（已截断）' : ''}，耗时 ${fmtInt(data.tookMs)} ms</div>
      <table class="field-table"><thead><tr><th>引用者</th><th>类</th><th>位置</th></tr></thead><tbody>
      ${data.items.map((r) => `<tr><td class="fval"><span class="ref" data-detail-id="${r.id}">${fmtId(r.id)}</span></td><td class="fname">${esc(r.className || '—')}</td><td class="ftype">${esc(r.field)}</td></tr>`).join('')}
      </tbody></table>`;
  } catch (error) {
    box.innerHTML = `<div class="muted" style="margin-top:8px">${esc(error.message)}</div>`;
  }
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#overlay').hidden = true;
  detailStack.length = 0;
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) {
    setTab(tab.dataset.tab);
    if (tab.dataset.tab === 'domtree' && !treeState.children.has(treeState.root)) loadTreeRoot(treeState.root);
    return;
  }

  const expander = event.target.closest('[data-expand]');
  if (expander) {
    event.preventDefault();
    event.stopPropagation();
    toggleTree(Number(expander.dataset.expand));
    return;
  }

  const more = event.target.closest('[data-more]');
  if (more) {
    event.preventDefault();
    event.stopPropagation();
    const parentId = Number(more.dataset.more);
    fetchTreeChildren(parentId, true).then(renderTree);
    return;
  }

  const sample = event.target.closest('[data-sample-id]');
  if (sample) {
    event.preventDefault();
    closeClassPaths();
    openDetail(Number(sample.dataset.sampleId));
    return;
  }

  const classRow = event.target.closest('tr[data-class-id]');
  if (classRow) {
    openObjects(classRow.dataset.classKind, Number(classRow.dataset.classId), classRow.dataset.className);
    return;
  }

  const ref = event.target.closest('[data-detail-id]');
  if (ref) {
    event.preventDefault();
    openDetail(Number(ref.dataset.detailId));
  }
});

$('#closeDrawer').onclick = closeDrawer;
$('#drawerBack').onclick = goBackDetail;
$('#overlay').onclick = closeDrawer;
$('#closeClassPath').onclick = closeClassPaths;
$('#modalOverlay').onclick = closeClassPaths;
$('#classPathsWeak').addEventListener('change', (event) => {
  classPathState.weak = event.target.checked;
  loadClassPaths();
});
$('#classPathModeTree').onclick = () => {
  classPathState.mode = 'tree';
  updateClassPathMode();
  if (classPathState.data) renderClassPaths(classPathState.data);
};
$('#classPathModeText').onclick = () => {
  classPathState.mode = 'text';
  updateClassPathMode();
  if (classPathState.data) renderClassPaths(classPathState.data);
};
$('#objectClassPaths').onclick = () => {
  const button = $('#objectClassPaths');
  if (!button.dataset.id) return;
  openClassPaths(button.dataset.kind, Number(button.dataset.id), button.dataset.name);
};
$('#allClasses').onclick = (e) => { e.preventDefault(); setTab('classes'); };
$('#allStrings').onclick = (e) => { e.preventDefault(); setTab('strings'); };
$('#backToClasses').onclick = (e) => { e.preventDefault(); setTab('classes'); };
$('#treeCollapse').onclick = () => { treeState.expanded.clear(); renderTree(); };
$('#treeBack').onclick = () => loadTreeRoot(0);
$('#treeReturnDetail').onclick = () => {
  const id = treeState.returnDetail;
  if (!id) return;
  treeState.returnDetail = null;
  $('#treeReturnDetail').hidden = true;
  openDetail(id);
};

document.addEventListener('keydown', (event) => {
  if (!$('#classPathModal').hidden) {
    if (event.key === 'Escape') closeClassPaths();
    return;
  }
  const drawerOpen = !$('#drawer').hidden;
  if (!drawerOpen) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (event.key === 'Escape') {
    closeDrawer();
    return;
  }
  if (!typing && event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    goBackDetail();
  }
});

(function initDrawerResizer() {
  const root = document.documentElement;
  const saved = Number(localStorage.getItem('hprof.drawerWidth'));
  if (Number.isFinite(saved) && saved >= 360) root.style.setProperty('--drawer-w', `${Math.round(saved)}px`);
  const handle = $('#drawerResizer');
  let startX = 0;
  let startW = 0;
  let dragging = false;
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startW = $('#drawer').getBoundingClientRect().width;
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* synthetic pointers */ }
    document.body.classList.add('col-resizing');
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const width = Math.min(Math.max(startW + startX - event.clientX, 360), window.innerWidth * 0.92);
    root.style.setProperty('--drawer-w', `${Math.round(width)}px`);
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('col-resizing');
    const width = parseFloat(getComputedStyle(root).getPropertyValue('--drawer-w'));
    if (Number.isFinite(width) && width >= 360) localStorage.setItem('hprof.drawerWidth', String(Math.round(width)));
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('dblclick', () => {
    root.style.removeProperty('--drawer-w');
    localStorage.removeItem('hprof.drawerWidth');
  });
})();

$('#classSort').addEventListener('change', (event) => {
  state.classSort = event.target.value;
  loadClasses();
});

const filterReloads = {
  classes: () => loadClasses(),
  objects: () => { state.objectPage = 0; loadObjects(); },
  strings: () => { state.stringPage = 0; loadStrings(); },
  roots: () => { state.rootPage = 0; loadRoots(); },
  retained: () => { state.retainedPage = 0; loadRetained(); },
};
const filterTimers = new Map();
document.querySelectorAll('[data-filter]').forEach((input) => {
  const [table, field] = input.dataset.filter.split('.');
  input.addEventListener('input', () => {
    state.filters[table][field] = input.value;
    clearTimeout(filterTimers.get(table));
    filterTimers.set(table, setTimeout(filterReloads[table], 180));
  });
});
$('#treeFilter').addEventListener('input', (event) => {
  state.filters.tree.q = event.target.value;
  renderTree();
});
$('#stringReadable').addEventListener('change', (event) => {
  state.stringReadable = event.target.checked;
  state.stringPage = 0;
  loadStrings();
});

(async function init() {
  try {
    const summary = await api('/api/summary');
    renderSummary(summary);
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab) setTab(tab);
    else setTab('overview');
    const openId = Number(params.get('id'));
    if (Number.isFinite(openId) && openId > 0) openDetail(openId, { withPath: params.get('path') === '1' });
    const cid = Number(params.get('cid'));
    if (params.get('kind') && Number.isFinite(cid) && cid >= 0) {
      openObjects(params.get('kind') === 'primitive' ? 'primitive' : 'class', cid, params.get('cname') || `class ${cid}`);
    }
    const rootId = Number(params.get('root'));
    if (Number.isFinite(rootId) && rootId > 0) openTree(rootId);
    else if (state.tab === 'domtree' && !treeState.children.has(0)) loadTreeRoot(0);
  } catch (error) {
    $('#fileLine').textContent = `加载失败：${error.message}`;
  }
})();

