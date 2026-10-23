import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadHprof } from './hprof.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const dataDir = path.join(here, '..', 'data');

function defaultHprof() {
  try {
    const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.hprof'));
    if (files.length === 1) return path.join(dataDir, files[0]);
    if (files.length > 1) {
      console.error(`multiple .hprof files in ${dataDir}; pass --hprof explicitly`);
      process.exit(1);
    }
  } catch {
    // data/ is optional
  }
  return null;
}

function parseArgs(argv) {
  const out = { port: 8787, host: '127.0.0.1', hprof: null, stats: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hprof') out.hprof = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--stats') out.stats = true;
    else if (!out.hprof && !a.startsWith('-')) out.hprof = a;
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.hprof) args.hprof = defaultHprof();
if (!args.hprof) {
  console.error('usage: node src/server.mjs --hprof <dump.hprof> [--port 8787] [--host 127.0.0.1]');
  process.exit(1);
}

console.log(`loading ${args.hprof} ...`);
const t0 = Date.now();
const idx = loadHprof(args.hprof);
console.log(
  `parsed in ${Date.now() - t0} ms: ${idx.counts.classes} classes, ${idx.counts.instances} instances, ` +
  `${idx.counts.objectArrays} object arrays, ${idx.counts.primitiveArrays} primitive arrays, ` +
  `${idx.counts.roots} roots`,
);
const ta = Date.now();
idx.analyze();
console.log(
  `dominators in ${Date.now() - ta} ms: ${idx.graphStats.nodes} nodes, ${idx.graphStats.edges} edges, ` +
  `${idx.graphStats.reachable} reachable`,
);

let summary = null;
function getSummary() {
  if (!summary) summary = idx.summary();
  return summary;
}

if (args.stats) {
  console.log(JSON.stringify(getSummary(), null, 2));
  process.exit(0);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function intParam(url, name, fallback, min = 0) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep) && file !== path.join(publicDir, 'index.html')) {
    sendError(res, 403, 'forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendError(res, 404, 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true });

    if (pathname === '/api/summary') {
      const full = getSummary();
      const { classes, ...rest } = full;
      return sendJson(res, 200, { ...rest, classCount: classes.length, analysis: idx.graphStats, analyzeMs: idx.analyzeMs });
    }

    if (pathname === '/api/classes') {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const sort = url.searchParams.get('sort') ?? 'bytes';
      const minCount = Number(url.searchParams.get('minCount')) || 0;
      const minBytes = Number(url.searchParams.get('minBytes')) || 0;
      let list = getSummary().classes;
      if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
      if (minCount) list = list.filter((c) => c.count >= minCount);
      if (minBytes) list = list.filter((c) => c.bytes >= minBytes);
      list = list.slice();
      if (sort === 'count') list.sort((a, b) => b.count - a.count);
      else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
      else list.sort((a, b) => b.bytes - a.bytes);
      return sendJson(res, 200, { total: list.length, items: list.slice(0, 5000) });
    }

    if (pathname === '/api/instances') {
      const kind = url.searchParams.get('kind') === 'primitive' ? 'primitive' : 'class';
      const id = intParam(url, 'id', -1, 0);
      const page = intParam(url, 'page', 0, 0);
      const size = Math.min(intParam(url, 'size', 50, 1), 500);
      if (id < 0) return sendError(res, 400, 'missing id');
      const filters = {
        id: url.searchParams.get('fid') ?? '',
        className: url.searchParams.get('className') ?? '',
        heap: url.searchParams.get('heap') ?? '',
        minSize: url.searchParams.get('minSize') ?? '',
      };
      return sendJson(res, 200, idx.instances(kind, id, page, size, filters));
    }

    if (pathname === '/api/object') {
      const id = intParam(url, 'id', -1, 0);
      if (id < 0) return sendError(res, 400, 'missing id');
      const detail = idx.objectDetail(id);
      return sendJson(res, 200, { ...detail, retained: idx.retainedInfo(id) });
    }

    if (pathname === '/api/domtree') {
      const parent = intParam(url, 'parent', 0, 0);
      const offset = intParam(url, 'offset', 0, 0);
      const limit = Math.min(intParam(url, 'limit', 100, 1), 500);
      const tree = idx.domTree(parent, offset, limit);
      if (!tree) return sendError(res, 404, 'unknown dominator node');
      return sendJson(res, 200, tree);
    }

    if (pathname === '/api/classpaths') {
      const kind = url.searchParams.get('kind') === 'primitive' ? 'primitive' : 'class';
      const id = intParam(url, 'id', -1, 0);
      const limit = Math.min(intParam(url, 'limit', 20000, 1), 50000);
      const weak = url.searchParams.get('weak') === '1';
      if (id < 0) return sendError(res, 400, 'missing id');
      const result = idx.classPaths(kind, id, limit, 100, weak);
      if (!result) return sendError(res, 503, 'analysis not ready');
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/retained') {
      const page = intParam(url, 'page', 0, 0);
      const size = Math.min(intParam(url, 'size', 50, 1), 200);
      const filters = {
        id: url.searchParams.get('fid') ?? '',
        className: url.searchParams.get('className') ?? '',
        minRetained: url.searchParams.get('minRetained') ?? '',
      };
      return sendJson(res, 200, idx.retainedPage(page, size, filters));
    }

    if (pathname === '/api/path') {
      const id = intParam(url, 'id', -1, 0);
      const weak = url.searchParams.get('weak') === '1';
      if (id < 0) return sendError(res, 400, 'missing id');
      return sendJson(res, 200, idx.pathToRoot(id, weak));
    }

    if (pathname === '/api/referrers') {
      const id = intParam(url, 'id', -1, 0);
      if (id < 0) return sendError(res, 400, 'missing id');
      return sendJson(res, 200, idx.referrers(id));
    }

    if (pathname === '/api/strings') {
      const page = intParam(url, 'page', 0, 0);
      const size = Math.min(intParam(url, 'size', 50, 1), 200);
      const q = url.searchParams.get('q') ?? '';
      const readable = url.searchParams.get('readable') === '1';
      const id = url.searchParams.get('fid') ?? '';
      const minLength = url.searchParams.get('minLength') ?? '';
      return sendJson(res, 200, idx.stringsPage(page, size, { q, readable, id, minLength }));
    }

    if (pathname === '/api/roots') {
      const page = intParam(url, 'page', 0, 0);
      const size = Math.min(intParam(url, 'size', 50, 1), 200);
      const filters = {
        id: url.searchParams.get('fid') ?? '',
        className: url.searchParams.get('className') ?? '',
        type: url.searchParams.get('type') ?? '',
        heap: url.searchParams.get('heap') ?? '',
      };
      return sendJson(res, 200, idx.rootsPage(page, size, filters));
    }

    if (pathname.startsWith('/api/')) return sendError(res, 404, 'unknown api');
    return serveStatic(res, pathname);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`port ${args.port} is already in use; pass --port <n> or stop the other process`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(args.port, args.host, () => {
  console.log(`HPROF Explorer: http://${args.host}:${args.port}`);
  console.log(`file: ${args.hprof}`);
});
