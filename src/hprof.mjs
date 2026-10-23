// Minimal, dependency-free reader for Android/ART hprof dumps (JAVA PROFILE 1.0.3, 4-byte IDs).
// It indexes strings, classes, instances and arrays, and decodes fields on demand so a
// multi-hundred-MB dump stays usable in Node without materializing every field value.
import fs from 'node:fs';

const RECORD = {
  STRING: 0x01,
  LOAD_CLASS: 0x02,
  STACK_FRAME: 0x04,
  STACK_TRACE: 0x05,
  HEAP_DUMP: 0x0c,
  HEAP_DUMP_SEGMENT: 0x1c,
  HEAP_DUMP_END: 0x2c,
  ART_CLOCK: 0xa0,
};

const HEAP = {
  ROOT_UNKNOWN: 0xff,
  ROOT_JNI_GLOBAL: 0x01,
  ROOT_JNI_LOCAL: 0x02,
  ROOT_JAVA_FRAME: 0x03,
  ROOT_NATIVE_STACK: 0x04,
  ROOT_STICKY_CLASS: 0x05,
  ROOT_THREAD_BLOCK: 0x06,
  ROOT_MONITOR_USED: 0x07,
  ROOT_THREAD_OBJECT: 0x08,
  CLASS_DUMP: 0x20,
  INSTANCE_DUMP: 0x21,
  OBJECT_ARRAY_DUMP: 0x22,
  PRIMITIVE_ARRAY_DUMP: 0x23,
  HEAP_DUMP_INFO: 0xfe,
  ROOT_INTERNED_STRING: 0x89,
  ROOT_DEBUGGER: 0x8b,
  ROOT_VM_INTERNAL: 0x8d,
  ROOT_JNI_MONITOR: 0x8e,
};

const ROOT_NAMES = {
  0xff: 'UNKNOWN',
  0x01: 'JNI_GLOBAL',
  0x02: 'JNI_LOCAL',
  0x03: 'JAVA_FRAME',
  0x04: 'NATIVE_STACK',
  0x05: 'STICKY_CLASS',
  0x06: 'THREAD_BLOCK',
  0x07: 'MONITOR_USED',
  0x08: 'THREAD_OBJECT',
  0x89: 'INTERNED_STRING',
  0x8b: 'DEBUGGER',
  0x8d: 'VM_INTERNAL',
  0x8e: 'JNI_MONITOR',
};

const TYPE_SIZE = { 2: 4, 4: 1, 5: 2, 6: 4, 7: 8, 8: 1, 9: 2, 10: 4, 11: 8 };
const TYPE_NAME = {
  2: 'object',
  4: 'boolean',
  5: 'char',
  6: 'float',
  7: 'double',
  8: 'byte',
  9: 'short',
  10: 'int',
  11: 'long',
};

// Reference.referent must not keep the referent alive; MAT excludes these by default.
const WEAK_REFERENCE_CLASSES = new Set([
  'java.lang.ref.Reference',
  'java.lang.ref.WeakReference',
  'java.lang.ref.SoftReference',
  'java.lang.ref.PhantomReference',
]);

function primName(type) {
  return `${TYPE_NAME[type] ?? `type${type}`}[]`;
}

/** Decode Java modified UTF-8, where U+0000 is C0 80 and surrogates are encoded separately. */
function decodeMutf8(buf, start, end) {
  let out = '';
  let i = start;
  while (i < end) {
    const b = buf[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if ((b & 0xe0) === 0xc0) {
      const b2 = buf[i++] & 0x3f;
      out += String.fromCharCode(((b & 0x1f) << 6) | b2);
    } else if ((b & 0xf0) === 0xe0) {
      const b2 = buf[i++] & 0x3f;
      const b3 = buf[i++] & 0x3f;
      out += String.fromCharCode(((b & 0x0f) << 12) | (b2 << 6) | b3);
    } else {
      out += '\ufffd';
    }
  }
  return out;
}

function hex(n) {
  return `0x${(n >>> 0).toString(16)}`;
}

function idMatches(oid, term) {
  const t = String(term).trim().toLowerCase();
  if (!t) return true;
  const hexText = (oid >>> 0).toString(16);
  const decText = String(oid >>> 0);
  const raw = t.startsWith('0x') ? t.slice(2) : t;
  return hexText.startsWith(raw) || decText.startsWith(t);
}

/** Heuristic: binary payloads stored in a String (ICU data, encrypted blobs) are not text. */
function isBinaryText(text) {
  if (text.length < 8) return false;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0xfffd || c === 0xfffe || c === 0xffff) {
      bad++;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else bad++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      bad++;
    } else if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f) {
      bad++;
    }
  }
  return bad / text.length > 0.02;
}

export class HprofIndex {
  constructor(buf, file) {
    this.buf = buf;
    this.file = file;
    this.fileSize = buf.length;
    this.strings = new Map(); // id -> string
    this.loadClassNames = new Map(); // class id -> name string id
    this.classes = new Map(); // class id -> class info
    this.objects = new Map(); // object id -> record offset
    this.members = new Map(); // "c:<classId>" or "p:<type>" -> object id array
    this.classAgg = new Map(); // key -> { kind, id, count, bytes }
    this.roots = []; // { id, type }
    this.rootMask = new Map(); // id -> Set of root types
    this.heapRanges = []; // { start, end, heap }
    this.counts = { strings: 0, classes: 0, instances: 0, objectArrays: 0, primitiveArrays: 0, roots: 0 };
    this.bytes = { instanceData: 0, objectArrays: 0, primitiveArrays: 0 };
    this.recordCounts = {};
    this.version = null;
    this.timestamp = 0;
    this.idSize = 0;
    this.heapNames = new Set();
    this.parseMs = 0;
  }

  parse() {
    const started = Date.now();
    const buf = this.buf;
    const magic = buf.toString('latin1', 0, 19);
    if (!magic.startsWith('JAVA PROFILE')) throw new Error(`not an hprof file (magic: ${JSON.stringify(magic)})`);
    this.version = magic.replace(/\0+$/, '');
    let p = 19;
    this.idSize = buf.readUInt32BE(p);
    p += 4;
    if (this.idSize !== 4) throw new Error(`unsupported identifier size ${this.idSize} (ART writes 4)`);
    const hi = buf.readUInt32BE(p);
    const lo = buf.readUInt32BE(p + 4);
    p += 8;
    this.timestamp = hi * 2 ** 32 + lo;

    while (p + 9 <= buf.length) {
      const tag = buf[p];
      const len = buf.readUInt32BE(p + 5);
      const body = p + 9;
      const end = body + len;
      if (end > buf.length) throw new Error(`truncated record at ${hex(p)}: tag ${hex(tag)} len ${len}`);
      this.recordCounts[tag] = (this.recordCounts[tag] ?? 0) + 1;

      switch (tag) {
        case RECORD.STRING: {
          const id = buf.readUInt32BE(body);
          this.strings.set(id, decodeMutf8(buf, body + 4, end));
          this.counts.strings++;
          break;
        }
        case RECORD.LOAD_CLASS: {
          const classId = buf.readUInt32BE(body + 4);
          const nameId = buf.readUInt32BE(body + 12);
          this.loadClassNames.set(classId, nameId);
          break;
        }
        case RECORD.HEAP_DUMP:
        case RECORD.HEAP_DUMP_SEGMENT:
          this.parseHeapSegment(body, end);
          break;
        default:
          break;
      }
      p = end;
    }

    this.finalize();
    this.parseMs = Date.now() - started;
    return this;
  }

  parseHeapSegment(start, end) {
    const buf = this.buf;
    let p = start;
    let heap = 'unknown';
    let rangeStart = p;
    const closeRange = (at) => {
      if (at > rangeStart) this.heapRanges.push({ start: rangeStart, end: at, heap });
    };

    while (p < end) {
      const tag = buf[p];
      switch (tag) {
        case HEAP.HEAP_DUMP_INFO: {
          closeRange(p);
          const heapId = buf.readUInt32BE(p + 1);
          const nameId = buf.readUInt32BE(p + 5);
          heap = this.strings.get(nameId) ?? `heap:${String.fromCharCode(heapId)}`;
          this.heapNames.add(heap);
          rangeStart = p;
          p += 9;
          break;
        }
        // ---- roots ----
        case HEAP.ROOT_UNKNOWN:
        case HEAP.ROOT_STICKY_CLASS:
        case HEAP.ROOT_MONITOR_USED:
        case HEAP.ROOT_INTERNED_STRING:
        case HEAP.ROOT_DEBUGGER:
        case HEAP.ROOT_VM_INTERNAL: {
          const id = buf.readUInt32BE(p + 1);
          this.addRoot(id, tag);
          p += 5;
          break;
        }
        case HEAP.ROOT_JNI_GLOBAL: {
          const id = buf.readUInt32BE(p + 1);
          this.addRoot(id, tag);
          p += 9;
          break;
        }
        case HEAP.ROOT_JNI_LOCAL:
        case HEAP.ROOT_JAVA_FRAME:
        case HEAP.ROOT_JNI_MONITOR: {
          const id = buf.readUInt32BE(p + 1);
          this.addRoot(id, tag);
          p += 13;
          break;
        }
        case HEAP.ROOT_NATIVE_STACK:
        case HEAP.ROOT_THREAD_BLOCK: {
          const id = buf.readUInt32BE(p + 1);
          this.addRoot(id, tag);
          p += 9;
          break;
        }
        case HEAP.ROOT_THREAD_OBJECT: {
          const id = buf.readUInt32BE(p + 1);
          this.addRoot(id, tag);
          p += 13;
          break;
        }
        // ---- objects ----
        case HEAP.CLASS_DUMP:
          p = this.parseClassDump(p);
          break;
        case HEAP.INSTANCE_DUMP: {
          const id = buf.readUInt32BE(p + 1);
          const classId = buf.readUInt32BE(p + 9);
          const dataLen = buf.readUInt32BE(p + 13);
          this.objects.set(id, p);
          this.addMember(`c:${classId}`, id);
          this.counts.instances++;
          this.bytes.instanceData += dataLen;
          this.bumpClass(`c:${classId}`, dataLen);
          p += 17 + dataLen;
          break;
        }
        case HEAP.OBJECT_ARRAY_DUMP: {
          const id = buf.readUInt32BE(p + 1);
          const length = buf.readUInt32BE(p + 9);
          const classId = buf.readUInt32BE(p + 13);
          this.objects.set(id, p);
          this.addMember(`c:${classId}`, id);
          this.counts.objectArrays++;
          const bytes = length * 4;
          this.bytes.objectArrays += bytes;
          this.bumpClass(`c:${classId}`, bytes);
          p += 17 + bytes;
          break;
        }
        case HEAP.PRIMITIVE_ARRAY_DUMP: {
          const id = buf.readUInt32BE(p + 1);
          const length = buf.readUInt32BE(p + 9);
          const type = buf[p + 13];
          const size = TYPE_SIZE[type] ?? 0;
          this.objects.set(id, p);
          this.addMember(`p:${type}`, id);
          this.counts.primitiveArrays++;
          const bytes = length * size;
          this.bytes.primitiveArrays += bytes;
          this.bumpClass(`p:${type}`, bytes);
          p += 14 + bytes;
          break;
        }
        default:
          throw new Error(`unknown heap subrecord ${hex(tag)} at ${hex(p)}`);
      }
    }
    closeRange(end);
  }

  parseClassDump(p) {
    const buf = this.buf;
    const id = buf.readUInt32BE(p + 1);
    const offset = p;
    p += 5;
    p += 4; // stack trace serial
    const superId = buf.readUInt32BE(p);
    p += 4;
    const loaderId = buf.readUInt32BE(p);
    p += 4;
    p += 16; // signers, protection domain, two reserved ids
    const instanceSize = buf.readUInt32BE(p);
    p += 4;

    const cpCount = buf.readUInt16BE(p);
    p += 2;
    for (let i = 0; i < cpCount; i++) {
      p += 2;
      const type = buf[p];
      p += 1;
      p += TYPE_SIZE[type] ?? 0;
    }

    const staticCount = buf.readUInt16BE(p);
    p += 2;
    const statics = [];
    for (let i = 0; i < staticCount; i++) {
      const nameId = buf.readUInt32BE(p);
      p += 4;
      const type = buf[p];
      p += 1;
      const [value, next] = this.readValue(p, type);
      p = next;
      statics.push({ name: this.strings.get(nameId) ?? `field@${hex(nameId)}`, type, typeName: TYPE_NAME[type], value });
    }

    const fieldCount = buf.readUInt16BE(p);
    p += 2;
    const fields = [];
    for (let i = 0; i < fieldCount; i++) {
      const nameId = buf.readUInt32BE(p);
      p += 4;
      const type = buf[p];
      p += 1;
      fields.push({ name: this.strings.get(nameId) ?? `field@${hex(nameId)}`, type, typeName: TYPE_NAME[type] });
    }

    this.classes.set(id, {
      id,
      name: null,
      superId,
      loaderId,
      instanceSize,
      fields,
      statics,
      offset,
    });
    this.counts.classes++;
    return p;
  }

  readValue(p, type) {
    const buf = this.buf;
    switch (type) {
      case 2: {
        const v = buf.readUInt32BE(p);
        return [v === 0 ? null : v, p + 4];
      }
      case 4:
        return [buf[p] !== 0, p + 1];
      case 5:
        return [buf.readUInt16BE(p), p + 2];
      case 6:
        return [buf.readFloatBE(p), p + 4];
      case 7:
        return [buf.readDoubleBE(p), p + 8];
      case 8:
        return [buf.readInt8(p), p + 1];
      case 9:
        return [buf.readInt16BE(p), p + 2];
      case 10:
        return [buf.readInt32BE(p), p + 4];
      case 11:
        return [buf.readBigInt64BE(p), p + 8];
      default:
        throw new Error(`unsupported field type ${type}`);
    }
  }

  addRoot(id, tag) {
    const name = ROOT_NAMES[tag] ?? `ROOT_${hex(tag)}`;
    this.roots.push({ id, type: name });
    let set = this.rootMask.get(id);
    if (!set) this.rootMask.set(id, (set = new Set()));
    set.add(name);
    this.counts.roots++;
  }

  addMember(key, id) {
    let arr = this.members.get(key);
    if (!arr) this.members.set(key, (arr = []));
    arr.push(id);
  }

  bumpClass(key, bytes) {
    let agg = this.classAgg.get(key);
    if (!agg) this.classAgg.set(key, (agg = { key, count: 0, bytes: 0 }));
    agg.count++;
    agg.bytes += bytes;
  }

  className(classId) {
    const info = this.classes.get(classId);
    if (info?.name) return info.name;
    const nameId = this.loadClassNames.get(classId);
    const name = nameId != null ? this.strings.get(nameId) : null;
    return name ?? (classId ? `class@${hex(classId)}` : '<unknown>');
  }

  finalize() {
    for (const info of this.classes.values()) {
      info.name = this.className(info.id);
    }
    for (const [key, agg] of this.classAgg) {
      const [kind, raw] = key.split(':');
      const id = Number(raw);
      agg.kind = kind === 'p' ? 'primitive' : 'class';
      agg.id = id;
      agg.name = kind === 'p' ? primName(id) : this.className(id);
    }
    // String instances are java.lang.String objects.
    const stringClassIds = [];
    for (const [cid, info] of this.classes) {
      if (info.name === 'java.lang.String') stringClassIds.push(cid);
    }
    this.stringIds = [];
    for (const cid of stringClassIds) {
      const ids = this.members.get(`c:${cid}`);
      if (ids) for (const id of ids) this.stringIds.push(id);
    }
  }

  heapOf(offset) {
    const ranges = this.heapRanges;
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid];
      if (offset < r.start) hi = mid - 1;
      else if (offset >= r.end) lo = mid + 1;
      else return r.heap;
    }
    return 'unknown';
  }

  objectKind(id) {
    if (this.classes.has(id)) return 'class';
    const off = this.objects.get(id);
    if (off == null) return null;
    switch (this.buf[off]) {
      case HEAP.INSTANCE_DUMP:
        return 'instance';
      case HEAP.OBJECT_ARRAY_DUMP:
        return 'objectArray';
      case HEAP.PRIMITIVE_ARRAY_DUMP:
        return 'primitiveArray';
      default:
        return null;
    }
  }

  objectClassId(id) {
    const off = this.objects.get(id);
    if (off == null) return null;
    const tag = this.buf[off];
    if (tag === HEAP.INSTANCE_DUMP) {
      return this.buf.readUInt32BE(off + 9);
    }
    if (tag === HEAP.OBJECT_ARRAY_DUMP) {
      return this.buf.readUInt32BE(off + 13);
    }
    if (tag === HEAP.PRIMITIVE_ARRAY_DUMP) {
      return null;
    }
    return null;
  }

  objectClassName(id) {
    if (this.classes.has(id)) return this.className(id);
    const off = this.objects.get(id);
    if (off == null) return null;
    const tag = this.buf[off];
    if (tag === HEAP.PRIMITIVE_ARRAY_DUMP) return primName(this.buf[off + 13]);
    return this.className(this.objectClassId(id));
  }

  objectSize(id) {
    const off = this.objects.get(id);
    if (off == null) return 0;
    const buf = this.buf;
    const tag = buf[off];
    if (tag === HEAP.INSTANCE_DUMP) return buf.readUInt32BE(off + 13);
    if (tag === HEAP.OBJECT_ARRAY_DUMP) return buf.readUInt32BE(off + 9) * 4;
    if (tag === HEAP.PRIMITIVE_ARRAY_DUMP) {
      const len = buf.readUInt32BE(off + 9);
      const type = buf[off + 13];
      return len * (TYPE_SIZE[type] ?? 0);
    }
    return 0;
  }

  instanceFields(id) {
    const off = this.objects.get(id);
    if (off == null || this.buf[off] !== HEAP.INSTANCE_DUMP) return [];
    const buf = this.buf;
    let p = off + 17;
    const dataEnd = p + buf.readUInt32BE(off + 13);
    let classId = buf.readUInt32BE(off + 9);
    const out = [];
    const seen = new Set();
    while (classId && !seen.has(classId)) {
      seen.add(classId);
      const cls = this.classes.get(classId);
      if (!cls) break;
      for (const f of cls.fields) {
        if (p >= dataEnd) break;
        const [value, next] = this.readValue(p, f.type);
        p = next;
        const weak = f.type === 2 && WEAK_REFERENCE_CLASSES.has(cls.name) && f.name === 'referent';
        out.push({ name: f.name, type: f.typeName, value, refId: f.type === 2 && value != null ? value : undefined, weak });
      }
      classId = cls.superId;
    }
    return out;
  }

  arrayInfo(id) {
    const off = this.objects.get(id);
    if (off == null) return null;
    const buf = this.buf;
    const tag = buf[off];
    if (tag === HEAP.OBJECT_ARRAY_DUMP) {
      return {
        kind: 'object',
        length: buf.readUInt32BE(off + 9),
        classId: buf.readUInt32BE(off + 13),
        elements: (i) => buf.readUInt32BE(off + 17 + i * 4),
      };
    }
    if (tag === HEAP.PRIMITIVE_ARRAY_DUMP) {
      const length = buf.readUInt32BE(off + 9);
      const type = buf[off + 13];
      return {
        kind: 'primitive',
        length,
        type,
        typeName: TYPE_NAME[type],
        read: (i) => this.readPrimitive(off + 14, type, i),
      };
    }
    if (tag === HEAP.INSTANCE_DUMP) {
      const s = this.readString(id);
      if (s != null) return { kind: 'string', length: s.length, text: s };
    }
    return null;
  }

  readPrimitive(base, type, index) {
    const buf = this.buf;
    const size = TYPE_SIZE[type];
    const p = base + index * size;
    switch (type) {
      case 4:
        return buf[p] !== 0;
      case 5:
        return buf.readUInt16BE(p);
      case 6:
        return buf.readFloatBE(p);
      case 7:
        return buf.readDoubleBE(p);
      case 8:
        return buf.readInt8(p);
      case 9:
        return buf.readInt16BE(p);
      case 10:
        return buf.readInt32BE(p);
      case 11:
        return buf.readBigInt64BE(p);
      default:
        return null;
    }
  }

  readString(id) {
    const fields = this.instanceFields(id);
    const valueField = fields.find((f) => f.name === 'value' && f.refId != null);
    if (!valueField) return '';
    const arrId = valueField.refId;
    const info = this.arrayInfo(arrId);
    if (!info || info.kind !== 'primitive') return '';
    const len = info.length;
    let out = '';
    if (info.type === 8) {
      for (let i = 0; i < len; i++) out += String.fromCharCode(info.read(i) & 0xff);
    } else if (info.type === 5) {
      for (let i = 0; i < len; i++) out += String.fromCharCode(info.read(i));
    } else {
      return `<unexpected string storage: ${info.typeName}>`;
    }
    return out;
  }

  resolveValue(field) {
    if (field.type !== 'object') return field.value;
    if (field.value == null) return null;
    return this.describeRef(field.value);
  }

  describeRef(id) {
    if (id == null) return null;
    const kind = this.objectKind(id);
    if (!kind) return { id, kind: 'unknown', name: null };
    const name = this.objectClassName(id);
    const desc = { id, kind, name };
    if (kind === 'instance' && name === 'java.lang.String') {
      const text = this.readString(id);
      desc.preview = text != null ? text.slice(0, 120) : null;
    }
    return desc;
  }

  summary() {
    const classes = [...this.classAgg.values()]
      .map((c) => ({ kind: c.kind, id: c.id, name: c.name, count: c.count, bytes: c.bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    const rootCounts = {};
    for (const r of this.roots) rootCounts[r.type] = (rootCounts[r.type] ?? 0) + 1;
    return {
      file: this.file,
      fileSize: this.fileSize,
      version: this.version,
      idSize: this.idSize,
      timestamp: this.timestamp,
      parseMs: this.parseMs,
      counts: {
        ...this.counts,
        stringInstances: this.stringIds.length,
      },
      bytes: this.bytes,
      heaps: [...this.heapNames],
      rootCounts,
      records: this.recordCounts,
      classes,
      topClasses: classes.slice(0, 25),
      topStrings: this.topStrings(30),
    };
  }

  topStrings(limit) {
    const out = this.allStrings().filter((s) => !s.binary).slice(0, limit);
    return out.map((s) => ({ id: s.id, length: s.length, text: s.text.slice(0, 200) }));
  }

  allStrings() {
    if (this._allStrings) return this._allStrings;
    const list = [];
    for (const id of this.stringIds) {
      const text = this.readString(id);
      if (text == null) continue;
      list.push({ id, length: text.length, text, binary: isBinaryText(text) });
    }
    list.sort((a, b) => b.length - a.length);
    this._allStrings = list;
    return list;
  }

  classDetail(classId) {
    const info = this.classes.get(classId);
    if (!info) return null;
    return {
      id: info.id,
      name: info.name,
      instanceSize: info.instanceSize,
      superId: info.superId,
      superName: info.superId ? this.className(info.superId) : null,
      loaderId: info.loaderId,
      fields: info.fields,
      statics: info.statics.map((s) => ({
        ...s,
        value: s.type === 2 && s.value != null ? this.describeRef(s.value) : this.normalizeScalar(s.value),
      })),
      count: this.classAgg.get(`c:${classId}`)?.count ?? 0,
      bytes: this.classAgg.get(`c:${classId}`)?.bytes ?? 0,
    };
  }

  objectDetail(id) {
    if (this.classes.has(id)) {
      return { kind: 'class', id, class: this.classDetail(id) };
    }
    const off = this.objects.get(id);
    if (off == null) return { kind: 'unknown', id };
    const tag = this.buf[off];
    const base = {
      id,
      className: this.objectClassName(id),
      heap: this.heapOf(off),
      size: this.objectSize(id),
      isRoot: [...(this.rootMask.get(id) ?? [])],
    };
    if (tag === HEAP.INSTANCE_DUMP) {
      const fields = this.instanceFields(id).map((f) => ({
        name: f.name,
        type: f.type,
        value: f.type === 'object' ? this.describeRef(f.value) : this.formatScalar(f),
        weak: f.weak === true,
      }));
      const isString = base.className === 'java.lang.String';
      const string = isString ? this.readString(id) : undefined;
      return {
        ...base,
        kind: 'instance',
        fields,
        string,
        stringBinary: string != null ? isBinaryText(string) : undefined,
      };
    }
    if (tag === HEAP.OBJECT_ARRAY_DUMP) {
      const arr = this.arrayInfo(id);
      const n = Math.min(arr.length, 500);
      const elements = [];
      for (let i = 0; i < n; i++) elements.push(this.describeRef(arr.elements(i)));
      return { ...base, kind: 'objectArray', length: arr.length, elements, truncated: arr.length > n };
    }
    if (tag === HEAP.PRIMITIVE_ARRAY_DUMP) {
      const arr = this.arrayInfo(id);
      const n = Math.min(arr.length, 200);
      const values = [];
      for (let i = 0; i < n; i++) {
        const raw = arr.read(i);
        values.push(arr.type === 5 ? String.fromCharCode(raw) : this.normalizeScalar(raw));
      }
      return {
        ...base,
        kind: 'primitiveArray',
        length: arr.length,
        elementType: arr.typeName,
        values,
        truncated: arr.length > n,
      };
    }
    return { ...base, kind: 'unknown' };
  }

  formatScalar(field) {
    if (field.type === 'char') return String.fromCharCode(field.value);
    return this.normalizeScalar(field.value);
  }

  normalizeScalar(v) {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 1e4) / 1e4;
    return v;
  }

  instances(kind, id, page, pageSize, filters = {}) {
    const key = kind === 'primitive' ? `p:${id}` : `c:${id}`;
    const ids = this.members.get(key) ?? [];
    const classNameFilter = (filters.className ?? '').trim().toLowerCase();
    const heapFilter = (filters.heap ?? '').trim().toLowerCase();
    const minSize = Number(filters.minSize) || 0;
    const idFilter = filters.id ?? '';
    const filtered = [];
    for (const oid of ids) {
      if (!idMatches(oid, idFilter)) continue;
      const className = this.objectClassName(oid);
      if (classNameFilter && !className.toLowerCase().includes(classNameFilter)) continue;
      const heap = this.heapOf(this.objects.get(oid));
      if (heapFilter && !heap.toLowerCase().includes(heapFilter)) continue;
      const size = this.objectSize(oid);
      if (minSize && size < minSize) continue;
      filtered.push({ oid, className, heap, size });
    }
    const start = page * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    return {
      total: filtered.length,
      page,
      pageSize,
      items: slice.map((o) => ({
        id: o.oid,
        className: o.className,
        heap: o.heap,
        size: o.size,
      })),
    };
  }

  stringsPage(page, pageSize, options = {}) {
    const q = (options.q ?? '').toLowerCase();
    const readableOnly = options.readable === true;
    const minLength = Number(options.minLength) || 0;
    const idFilter = options.id ?? '';
    let list = this.allStrings();
    if (readableOnly) list = list.filter((s) => !s.binary);
    if (q) list = list.filter((s) => s.text.toLowerCase().includes(q));
    if (minLength) list = list.filter((s) => s.length >= minLength);
    if (idFilter) list = list.filter((s) => idMatches(s.id, idFilter));
    const start = page * pageSize;
    return {
      total: list.length,
      page,
      pageSize,
      items: list.slice(start, start + pageSize).map((s) => ({
        id: s.id,
        length: s.length,
        text: s.text.slice(0, 160),
        binary: s.binary,
      })),
    };
  }

  rootsPage(page, pageSize, filters = {}) {
    const idFilter = filters.id ?? '';
    const classNameFilter = (filters.className ?? '').toLowerCase();
    const typeFilter = (filters.type ?? '').toLowerCase();
    const heapFilter = (filters.heap ?? '').toLowerCase();
    const seen = new Set();
    const items = [];
    for (const r of this.roots) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (!idMatches(r.id, idFilter)) continue;
      const className = this.objectClassName(r.id);
      if (classNameFilter && !String(className).toLowerCase().includes(classNameFilter)) continue;
      if (typeFilter && !r.type.toLowerCase().includes(typeFilter)) continue;
      const heap = this.heapOf(this.objects.get(r.id) ?? 0);
      if (heapFilter && !heap.toLowerCase().includes(heapFilter)) continue;
      items.push({ id: r.id, type: r.type, className, heap });
    }
    const start = page * pageSize;
    return { total: items.length, page, pageSize, items: items.slice(start, start + pageSize) };
  }

  referrers(target, limit = 200, maxMs = 3000) {
    const started = Date.now();
    const out = [];
    let truncated = false;
    const className = (id) => this.objectClassName(id);
    for (const [id, off] of this.objects) {
      if (out.length >= limit || Date.now() - started > maxMs) {
        truncated = true;
        break;
      }
      if (id === target) continue;
      const tag = this.buf[off];
      if (tag === HEAP.INSTANCE_DUMP) {
        const fields = this.instanceFields(id);
        for (const f of fields) {
          if (f.type !== 'object' || f.value !== target) continue;
          out.push({ id, className: className(id), field: f.name });
        }
      } else if (tag === HEAP.OBJECT_ARRAY_DUMP) {
        const len = this.buf.readUInt32BE(off + 9);
        for (let i = 0; i < len; i++) {
          if (this.buf.readUInt32BE(off + 17 + i * 4) === target) {
            out.push({ id, className: className(id), field: `[${i}]` });
          }
        }
      }
    }
    for (const cls of this.classes.values()) {
      for (const s of cls.statics) {
        if (s.type === 2 && s.value === target) out.push({ id: cls.id, className: cls.name, field: `static ${s.name}` });
      }
    }
    return { target, items: out, truncated, tookMs: Date.now() - started };
  }

  /**
   * Build the object graph and compute immediate dominators / retained sizes.
   * Nodes are instances, arrays and class objects; the artificial node 0 is the
   * super-root connected to every GC root and every class object.
   */
  analyze() {
    const started = Date.now();
    const { objects, classes } = this;
    const idToNode = new Map();
    const ids = [0];
    for (const id of classes.keys()) {
      idToNode.set(id, ids.length);
      ids.push(id);
    }
    for (const id of objects.keys()) {
      if (idToNode.has(id)) continue;
      idToNode.set(id, ids.length);
      ids.push(id);
    }
    const N = ids.length;
    const nodeId = Uint32Array.from(ids);
    const shallow = new Float64Array(N);
    for (let v = 1; v < N; v++) {
      const id = nodeId[v];
      if (objects.has(id)) shallow[v] = this.objectSize(id);
    }

    const refsOf = (v, cb) => {
      const id = nodeId[v];
      const off = objects.get(id);
      if (off == null) {
        const cls = classes.get(id);
        if (!cls) return;
        if (cls.superId) cb(cls.superId, 'super');
        if (cls.loaderId) cb(cls.loaderId, 'classLoader');
        for (const s of cls.statics) {
          if (s.type === 2 && s.value != null) cb(s.value, `static ${s.name}`);
        }
        return;
      }
      const tag = this.buf[off];
      if (tag === HEAP.INSTANCE_DUMP) {
        let p = off + 17;
        const end = p + this.buf.readUInt32BE(off + 13);
        let classId = this.buf.readUInt32BE(off + 9);
        let depth = 0;
        while (classId && depth++ < 64) {
          const cls = classes.get(classId);
          if (!cls) break;
          for (const f of cls.fields) {
            if (p >= end) break;
            const [value, next] = this.readValue(p, f.type);
            p = next;
            if (f.type === 2 && value != null) {
              if (!(WEAK_REFERENCE_CLASSES.has(cls.name) && f.name === 'referent')) cb(value, f.name);
            }
          }
          classId = cls.superId;
        }
      } else if (tag === HEAP.OBJECT_ARRAY_DUMP) {
        const len = this.buf.readUInt32BE(off + 9);
        for (let i = 0; i < len; i++) {
          const value = this.buf.readUInt32BE(off + 17 + i * 4);
          if (value) cb(value, `[${i}]`);
        }
      }
    };

    const start = new Uint32Array(N + 1);
    for (let v = 1; v < N; v++) refsOf(v, () => start[v + 1]++);

    const rootNodes = new Set();
    for (const r of this.roots) {
      const idx = idToNode.get(r.id);
      if (idx != null) rootNodes.add(idx);
    }
    for (const cls of classes.keys()) rootNodes.add(idToNode.get(cls));
    start[1] += rootNodes.size;
    for (let i = 1; i <= N; i++) start[i] += start[i - 1];

    const E = start[N];
    const edgeTarget = new Uint32Array(E);
    const cursor = start.slice(0, N);
    for (let v = 1; v < N; v++) {
      refsOf(v, (refId) => {
        const t = idToNode.get(refId);
        if (t != null && cursor[v] < start[v + 1]) edgeTarget[cursor[v]++] = t;
      });
    }
    for (const idx of rootNodes) edgeTarget[cursor[0]++] = idx;

    // Shortest path tree from the super-root, used by the "all objects of a class" GC-root paths view.
    const bfsDist = new Int32Array(N).fill(-1);
    const bfsParent = new Int32Array(N).fill(-1);
    const bfsQueue = new Int32Array(N);
    let bfsHead = 0;
    let bfsTail = 0;
    bfsDist[0] = 0;
    bfsParent[0] = 0;
    bfsQueue[bfsTail++] = 0;
    while (bfsHead < bfsTail) {
      const v = bfsQueue[bfsHead++];
      for (let e = start[v]; e < start[v + 1]; e++) {
        const t = edgeTarget[e];
        if (bfsDist[t] !== -1) continue;
        bfsDist[t] = bfsDist[v] + 1;
        bfsParent[t] = v;
        bfsQueue[bfsTail++] = t;
      }
    }

    // Weak/soft/phantom referent edges: excluded from dominators/retained, but kept
    // for the opt-in "include weak references" path view.
    const weakEdges = [];
    for (let v = 1; v < N; v++) {
      const id = nodeId[v];
      const off = objects.get(id);
      if (off == null || this.buf[off] !== HEAP.INSTANCE_DUMP) continue;
      let p = off + 17;
      const end = p + this.buf.readUInt32BE(off + 13);
      let classId = this.buf.readUInt32BE(off + 9);
      let depth = 0;
      while (classId && depth++ < 64) {
        const cls = classes.get(classId);
        if (!cls) break;
        for (const f of cls.fields) {
          if (p >= end) break;
          const [value, next] = this.readValue(p, f.type);
          p = next;
          if (f.type !== 2 || value == null) continue;
          if (WEAK_REFERENCE_CLASSES.has(cls.name) && f.name === 'referent') {
            const t = idToNode.get(value);
            if (t != null) weakEdges.push([v, t]);
          }
        }
        classId = cls.superId;
      }
    }

    const allStart = new Uint32Array(N + 1);
    for (let v = 0; v < N; v++) allStart[v + 1] = start[v + 1] - start[v];
    for (const [s] of weakEdges) allStart[s + 1]++;
    for (let i = 1; i <= N; i++) allStart[i] += allStart[i - 1];
    const allTarget = new Uint32Array(allStart[N]);
    const allCursor = allStart.slice(0, N);
    for (let v = 0; v < N; v++) {
      for (let e = start[v]; e < start[v + 1]; e++) allTarget[allCursor[v]++] = edgeTarget[e];
    }
    for (const [s, t] of weakEdges) allTarget[allCursor[s]++] = t;

    const allDist = new Int32Array(N).fill(-1);
    const allParent = new Int32Array(N).fill(-1);
    const allQueue = new Int32Array(N);
    let allHead = 0;
    let allTail = 0;
    allDist[0] = 0;
    allParent[0] = 0;
    allQueue[allTail++] = 0;
    while (allHead < allTail) {
      const v = allQueue[allHead++];
      for (let e = allStart[v]; e < allStart[v + 1]; e++) {
        const t = allTarget[e];
        if (allDist[t] !== -1) continue;
        allDist[t] = allDist[v] + 1;
        allParent[t] = v;
        allQueue[allTail++] = t;
      }
    }

    const revStart = new Uint32Array(N + 1);
    for (let e = 0; e < E; e++) revStart[edgeTarget[e] + 1]++;
    for (let i = 1; i <= N; i++) revStart[i] += revStart[i - 1];
    const revSource = new Uint32Array(E);
    const revCursor = revStart.slice(0, N);
    for (let s = 0; s < N; s++) {
      for (let e = start[s]; e < start[s + 1]; e++) {
        const t = edgeTarget[e];
        revSource[revCursor[t]++] = s;
      }
    }

    // DFS from the super-root: dfn/vertex/parent feed Lengauer-Tarjan below.
    const visited = new Uint8Array(N);
    const dfn = new Int32Array(N);
    const vertex = new Int32Array(N + 1);
    const parent = new Int32Array(N).fill(-1);
    const stackV = new Int32Array(N);
    const stackI = new Int32Array(N);
    let sp = 0;
    let n = 0;
    stackV[0] = 0;
    stackI[0] = start[0];
    visited[0] = 1;
    dfn[0] = ++n;
    vertex[n] = 0;
    parent[0] = 0;
    while (sp >= 0) {
      const v = stackV[sp];
      if (stackI[sp] < start[v + 1]) {
        const e = edgeTarget[stackI[sp]++];
        if (!visited[e]) {
          visited[e] = 1;
          parent[e] = v;
          dfn[e] = ++n;
          vertex[n] = e;
          sp++;
          stackV[sp] = e;
          stackI[sp] = start[e];
        }
      } else {
        sp--;
      }
    }
    const dfsMs = Date.now() - started;

    // Lengauer-Tarjan dominators (iterative eval with path compression).
    const semi = new Int32Array(N);
    const label = new Int32Array(N);
    const ancestor = new Int32Array(N).fill(-1);
    const idom = new Int32Array(N).fill(-1);
    const bucketHead = new Int32Array(N).fill(-1);
    const bucketNext = new Int32Array(N).fill(-1);
    for (let i = 1; i <= n; i++) {
      const v = vertex[i];
      semi[v] = i;
      label[v] = v;
    }
    idom[0] = 0;
    const pathBuf = new Int32Array(N);
    const evalNode = (v) => {
      if (ancestor[v] === -1) return label[v];
      let x = v;
      let top = 0;
      while (ancestor[x] !== -1 && ancestor[ancestor[x]] !== -1) {
        pathBuf[top++] = x;
        x = ancestor[x];
      }
      for (let i = top - 1; i >= 0; i--) {
        const y = pathBuf[i];
        const a = ancestor[y];
        if (semi[label[a]] < semi[label[y]]) label[y] = label[a];
        ancestor[y] = ancestor[a];
      }
      return label[v];
    };
    for (let i = n; i >= 2; i--) {
      const w = vertex[i];
      for (let e = revStart[w]; e < revStart[w + 1]; e++) {
        const v = revSource[e];
        if (dfn[v] === 0) continue;
        const u = evalNode(v);
        if (semi[u] < semi[w]) semi[w] = semi[u];
      }
      const s = vertex[semi[w]];
      bucketNext[w] = bucketHead[s];
      bucketHead[s] = w;
      ancestor[w] = parent[w];
      const p = parent[w];
      let v = bucketHead[p];
      while (v !== -1) {
        const next = bucketNext[v];
        const u = evalNode(v);
        idom[v] = semi[u] < semi[v] ? u : p;
        v = next;
      }
      bucketHead[p] = -1;
    }
    for (let i = 2; i <= n; i++) {
      const w = vertex[i];
      if (idom[w] !== vertex[semi[w]]) idom[w] = idom[idom[w]];
    }
    const domMs = Date.now() - started - dfsMs;

    const retained = new Float64Array(shallow);
    for (let i = n; i >= 2; i--) {
      const w = vertex[i];
      const p = idom[w];
      if (p >= 0) retained[p] += retained[w];
    }

    const domChildHead = new Int32Array(N).fill(-1);
    const domNext = new Int32Array(N).fill(-1);
    const domChildCount = new Int32Array(N);
    for (let i = 2; i <= n; i++) {
      const v = vertex[i];
      const p = idom[v];
      if (p < 0) continue;
      domNext[v] = domChildHead[p];
      domChildHead[p] = v;
      domChildCount[p]++;
    }

    const ranked = [];
    for (let i = 2; i <= n; i++) {
      const v = vertex[i];
      if (retained[v] > 0) ranked.push(v);
    }
    ranked.sort((a, b) => retained[b] - retained[a]);
    const sortMs = Date.now() - started - dfsMs - domMs;

    this.nodeId = nodeId;
    this.nodeIndex = idToNode;
    this.shallow = shallow;
    this.retained = retained;
    this.idom = idom;
    this.bfsDist = bfsDist;
    this.bfsParent = bfsParent;
    this.allBfsDist = allDist;
    this.allBfsParent = allParent;
    this.weakEdgeCount = weakEdges.length;
    this.domChildHead = domChildHead;
    this.domNext = domNext;
    this.domChildCount = domChildCount;
    this.revStart = revStart;
    this.revSource = revSource;
    this.rootNodes = rootNodes;
    this.topRetained = ranked.slice(0, 500);
    this.analyzeMs = Date.now() - started;
    this.graphStats = { nodes: N, edges: E, reachable: n, dfsMs, domMs, sortMs };
    return this;
  }

  retainedInfo(id) {
    if (!this.nodeIndex) return null;
    const v = this.nodeIndex.get(id);
    if (v == null) return null;
    const parent = this.idom[v];
    return {
      shallow: this.shallow[v],
      retained: this.retained[v],
      children: this.domChildCount ? this.domChildCount[v] : 0,
      dominator: parent > 0 ? { id: this.nodeId[parent], className: this.objectClassName(this.nodeId[parent]) } : null,
    };
  }

  domTree(parentId, offset, limit) {
    if (!this.domChildHead) return null;
    let p;
    if (parentId === 0) {
      p = 0;
    } else {
      p = this.nodeIndex.get(parentId);
      if (p == null) return null;
    }
    const children = [];
    for (let v = this.domChildHead[p]; v !== -1; v = this.domNext[v]) children.push(v);
    children.sort((a, b) => this.retained[b] - this.retained[a]);
    const slice = children.slice(offset, offset + limit);
    return {
      parent: p === 0
        ? { id: 0, className: '<root>', retained: this.retained[0], children: this.domChildCount[0] }
        : { id: this.nodeId[p], className: this.objectClassName(this.nodeId[p]), retained: this.retained[p], children: this.domChildCount[p] },
      total: children.length,
      offset,
      limit,
      items: slice.map((v) => ({
        id: this.nodeId[v],
        className: this.objectClassName(this.nodeId[v]),
        shallow: this.shallow[v],
        retained: this.retained[v],
        children: this.domChildCount[v],
      })),
    };
  }

  retainedPage(page, pageSize, filters = {}) {
    if (!this.topRetained) return { total: 0, page, pageSize, items: [] };
    const idFilter = filters.id ?? '';
    const classNameFilter = (filters.className ?? '').toLowerCase();
    const minRetained = Number(filters.minRetained) || 0;
    const list = [];
    for (const v of this.topRetained) {
      const id = this.nodeId[v];
      if (!idMatches(id, idFilter)) continue;
      const className = this.objectClassName(id);
      if (classNameFilter && !className.toLowerCase().includes(classNameFilter)) continue;
      if (minRetained && this.retained[v] < minRetained) continue;
      list.push({ id, className, shallow: this.shallow[v], retained: this.retained[v] });
    }
    const start = page * pageSize;
    return { total: list.length, page, pageSize, items: list.slice(start, start + pageSize) };
  }

  /** GC-root path groups for every object of one class (MAT "Path to GC Roots" style). */
  classPaths(kind, id, limitObjects = 20000, maxGroups = 100, includeWeak = false) {
    if (!this.bfsParent) return null;
    const parents = includeWeak ? this.allBfsParent : this.bfsParent;
    const dist = includeWeak ? this.allBfsDist : this.bfsDist;
    const key = kind === 'primitive' ? `p:${id}` : `c:${id}`;
    const ids = this.members.get(key) ?? [];
    const className = kind === 'primitive' ? primName(id) : this.className(id);
    const groups = new Map();
    let scanned = 0;
    let unreachable = 0;
    const limit = Math.min(ids.length, limitObjects);
    for (let i = 0; i < limit; i++) {
      const objectId = ids[i];
      const v = this.nodeIndex.get(objectId);
      if (v == null || dist[v] < 0) {
        unreachable++;
        continue;
      }
      const chain = [];
      let cur = v;
      let guard = 0;
      while (cur !== 0 && guard++ < 128) {
        chain.push(cur);
        cur = parents[cur];
        if (cur < 0) break;
      }
      if (cur !== 0) {
        unreachable++;
        continue;
      }
      chain.push(0);
      chain.reverse();
      const steps = chain.map((node, index) => ({
        className: node === 0 ? '<root>' : this.objectClassName(this.nodeId[node]),
        via: index === 0 ? null : this.edgeLabel(chain[index - 1], this.nodeId[node]),
      }));
      const signature = steps.map((s) => `${s.className}\u0001${s.via ?? ''}`).join('\u0002');
      let group = groups.get(signature);
      if (!group) {
        group = { signature, steps, count: 0, shallow: 0, samples: [] };
        groups.set(signature, group);
      }
      group.count++;
      group.shallow += this.shallow[v];
      if (group.samples.length < 5) group.samples.push({ id: objectId });
      scanned++;
    }
    const list = [...groups.values()].sort((a, b) => b.count - a.count);
    return {
      kind,
      id,
      className,
      includeWeak,
      totalObjects: ids.length,
      scanned,
      reachable: scanned,
      unreachable,
      sampled: ids.length > limit,
      groupCount: list.length,
      groups: list.slice(0, maxGroups),
    };
  }

  /** BFS over reverse edges from the object to a GC root / class node. */
  pathToRoot(id, includeWeak = false) {
    if (!this.nodeIndex) return null;
    const start = this.nodeIndex.get(id);
    if (start == null) return null;
    const parents = includeWeak ? this.allBfsParent : this.bfsParent;
    const dist = includeWeak ? this.allBfsDist : this.bfsDist;
    if (!parents || dist[start] < 0) return { found: false, path: [], includeWeak };
    const chain = [];
    let cur = start;
    let guard = 0;
    while (cur !== 0 && guard++ < 128) {
      chain.push(cur);
      cur = parents[cur];
      if (cur < 0) break;
    }
    if (cur !== 0) return { found: false, path: [], includeWeak };
    chain.push(0);
    chain.reverse();
    const path = chain.map((v, i) => {
      const objectId = this.nodeId[v];
      const className = v === 0 ? '<root>' : this.objectClassName(objectId);
      const via = i === 0 ? null : this.edgeLabel(chain[i - 1], objectId);
      return { id: objectId, className, via };
    });
    return { found: true, path, distance: dist[start], includeWeak };
  }

  edgeLabel(v, targetId) {
    if (v === 0) {
      const types = this.rootMask.get(targetId);
      if (types && types.size) return `GC root: ${[...types].join('/')}`;
      return 'class root';
    }
    const id = this.nodeId[v];
    const off = this.objects.get(id);
    if (off == null) {
      const cls = this.classes.get(id);
      if (!cls) return '?';
      if (cls.superId === targetId) return 'superclass';
      if (cls.loaderId === targetId) return 'classLoader';
      for (const s of cls.statics) {
        if (s.type === 2 && s.value === targetId) return `static ${s.name}`;
      }
      return '?';
    }
    const tag = this.buf[off];
    if (tag === HEAP.INSTANCE_DUMP) {
      let p = off + 17;
      const end = p + this.buf.readUInt32BE(off + 13);
      let classId = this.buf.readUInt32BE(off + 9);
      let depth = 0;
      while (classId && depth++ < 64) {
        const cls = this.classes.get(classId);
        if (!cls) break;
        for (const f of cls.fields) {
          if (p >= end) break;
          const [value, next] = this.readValue(p, f.type);
          p = next;
          if (f.type === 2 && value === targetId) {
            return WEAK_REFERENCE_CLASSES.has(cls.name) && f.name === 'referent' ? 'referent (weak)' : f.name;
          }
        }
        classId = cls.superId;
      }
      return '?';
    }
    if (tag === HEAP.OBJECT_ARRAY_DUMP) {
      const len = this.buf.readUInt32BE(off + 9);
      for (let i = 0; i < len; i++) {
        if (this.buf.readUInt32BE(off + 17 + i * 4) === targetId) return `[${i}]`;
      }
    }
    return '?';
  }
}

export function loadHprof(file) {
  const buf = fs.readFileSync(file);
  const idx = new HprofIndex(buf, file);
  return idx.parse();
}
