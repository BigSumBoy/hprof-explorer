# HPROF Explorer 设计与维护文档

> 面向后续开发者 / AI 维护者。本文记录当前实现、原理、验证结果、已知限制和扩展方式。
>
> 最后更新：2026-10-19
> 代码目录：`D:\Code\aosp\tools\hprof-explorer`
> 验证用 dump：`data\com.android.systemui_2026-10-14-14-55-04.hprof`（129,501,003 字节）

---

## 1. 目标与边界

HPROF Explorer 是一个**零第三方依赖**的 Android/ART hprof 解析器 + Web 可视化工具，主要用于：

- 查看类直方图、对象、字段、字符串、GC Roots；
- 计算支配树 / Retained Size；
- 查看单个对象或整类对象的 GC Root 最短路径；
- 在强引用和“包含弱引用”两种视图之间切换；
- 用表头过滤快速定位对象（ID、类、堆、大小等）。

**不做的事**（当前版本）：

- 不支持标准 JVM 的 8 字节 ID hprof（ART 固定 4 字节）；
- 不做对象分配栈、CPU 采样、对象图差分；
- 不实现可交互的浏览器历史（前进/后退），导航是应用内的；
- 不持久化解析结果，每次启动重新解析和计算。

---

## 2. 运行与目录

```bash
cd D:\Code\aosp\tools\hprof-explorer
node src/server.mjs                 # data/ 下只有一个 .hprof 时自动发现
node src/server.mjs --hprof xxx.hprof --port 8787
```

Windows 可运行 `start.cmd`。Node.js >= 20，无 `npm install`。

```
src/hprof.mjs    解析、索引、图、支配树、路径、过滤
src/server.mjs   HTTP 服务 + JSON API + 静态文件
src/stats.mjs    命令行解析统计
public/          原生 HTML/CSS/JS，无构建步骤
data/            本地 hprof（.gitignore）
docs/            本文档
```

当前服务地址：<http://127.0.0.1:8787>。

---

## 3. 总体架构

```
hprof 文件
   │
   ▼
hprof.mjs: HprofIndex.parse()
   ├─ 字符串表 / 类表 / 对象索引 / 根 / heap 区间
   └─ 按需字段解码（objectDetail / instanceFields）
   │
   ▼
hprof.mjs: analyze()
   ├─ 构图（强引用边、GC Root 边、类对象边）
   ├─ 强引用 BFS（最短路径树）
   ├─ 弱引用边收集 + 全边 BFS
   ├─ Lengauer-Tarjan 支配树 + Retained Size
   └─ 支配树 children 索引
   │
   ▼
server.mjs: JSON API（summary / classes / instances / object / retained /
             domtree / classpaths / path / referrers / strings / roots）
   │
   ▼
public/app.js + index.html + styles.css
   ├─ 表格 + 表头过滤
   ├─ 详情抽屉（历史栈、可拖拽宽度）
   ├─ 支配树懒加载
   └─ 类级 GC Root 路径弹窗（树形/文本、弱引用开关）
```

解析一次后常驻内存。129 MB 的 SystemUI dump 在本机：解析约 1.1 s，支配树约 4.2 s，Node RSS 约 0.9 GB。

---

## 4. 解析器（`src/hprof.mjs`）

### 4.1 文件头

- magic：`JAVA PROFILE 1.0.3\0`（19 字节）
- id size：u4，ART 固定 4
- timestamp：u4 high + u4 low（毫秒）

记录格式：`u1 tag + u4 time + u4 length + body`，所有数值大端。

### 4.2 顶层记录

实际处理：

| tag | 记录 | 用途 |
|---|---|---|
| 0x01 | STRING | id → 字符串（modified UTF-8） |
| 0x02 | LOAD_CLASS | class id → 类名字符串 id |
| 0x1C | HEAP_DUMP_SEGMENT | 根、类、实例、数组 |
| 0x2C | HEAP_DUMP_END | 忽略 |
| 0xA0 | ART_CLOCK_MONOTONIC | 忽略 |
| 其他 | STACK_FRAME/STACK_TRACE 等 | 跳过 body（当前 UI 不展示分配栈） |

`HEAP_DUMP`（0x0C）也按 segment 处理；ART 实际写 0x1C。

### 4.3 堆子记录

- 根：UNKNOWN、JNI_GLOBAL、JNI_LOCAL、JAVA_FRAME、NATIVE_STACK、STICKY_CLASS、THREAD_BLOCK、MONITOR_USED、THREAD_OBJECT、INTERNED_STRING、DEBUGGER、VM_INTERNAL、JNI_MONITOR
- `HEAP_DUMP_INFO`（0xFE）：记录逻辑堆（app/zygote/image）
- `CLASS_DUMP`（0x20）：父类、ClassLoader、实例大小、静态字段、实例字段
- `INSTANCE_DUMP`（0x21）：id + trace + class id + data length + data
- `OBJECT_ARRAY_DUMP`（0x22）：id + trace + length + class id + ids
- `PRIMITIVE_ARRAY_DUMP`（0x23）：id + trace + length + type + data

对象索引只保存 `id → 记录偏移`（`Map<number, number>`），字段值在查看时按需解码，避免把 130 万对象的字段全部展开。

### 4.4 字符串

- `STRING` 记录用 Java modified UTF-8（U+0000 = `C0 80`；surrogate 拆成两个 3 字节序列）。
- `java.lang.String` 的字符数据：
  - 合成字段 `value` 指向 char[] 或 byte[]；
  - char[]：UTF-16BE；
  - byte[]：按 Latin-1（每字节一个 char）解码。
- 空串、压缩字符串由 ART 写成假数组 id（对象地址 + 偏移），解析器把它当作普通 primitive array 索引。

**可读性检测** `isBinaryText()`：长度 ≥ 8 且替换字符/非字符/控制字符/孤立 surrogate 占比 > 2% 判定为 `binary`。这类 String 常见于 ICU/序列化数据，字符串页默认隐藏，但可通过关闭“只看可读文本”查看。

### 4.5 类与字段

`CLASS_DUMP` 解析出的 `CLASS_INFO`：

```js
{ id, name, superId, loaderId, instanceSize,
  fields: [{name,type,typeName}],
  statics: [{name,type,typeName,value}] }
```

- 实例字段只包含本类声明的字段；实例数据顺序是“本类 → 父类 → …”。
- `instanceFields(id)` 沿父类链解码，使用 `readValue()` 处理基本类型和 object id。
- 静态字段值直接存在类信息中；object 值在展示时解析。
- `shadow$_klass_`、`shadow$_monitor_`、`$classOverhead`、`$class$...` 等 ART 合成字段原样保留。

### 4.6 堆区间

`HEAP_DUMP_INFO` 会切换当前逻辑堆；解析时记录 `{start,end,heap}` 区间，`heapOf(offset)` 二分查找。对象详情用它显示 app/zygote/image。

### 4.7 对象类型

- `objectKind(id)`：`class` / `instance` / `objectArray` / `primitiveArray`
- `objectClassName(id)`：类 id、实例/对象数组的 class id、primitive 数组的类型名
- `objectSize(id)`：实例数据长度、对象数组 4×len、primitive 数组 len×typeSize
- `arrayInfo(id)`：对象数组元素读取器、primitive 数组类型/读取器、String 文本

---

## 5. 分析层

### 5.1 图构建（`analyze()`）

节点：

- 0 号是人工 super-root；
- 所有类对象；
- 所有实例、对象数组、primitive 数组（包括字符串的假数组）。

边：

- 实例的 object 字段；
- 对象数组元素；
- 类的 superclass、ClassLoader、静态 object 字段；
- super-root → 所有 GC Root 对象 + 所有类对象。

**弱引用处理**：

- `WeakReference/SoftReference/PhantomReference/Reference` 的 `referent` 字段不进入强引用图；
- 这些边单独收集到 `weakEdges`，用于可选的“包含弱引用”路径；
- `FinalizerReference` 不排除（仍按普通引用处理）。

结果结构：

- 前向 CSR：`start[] / edgeTarget[]`
- 强引用 BFS：`bfsDist / bfsParent`
- 全边（含弱引用）CSR：`allStart/allTarget`
- 全边 BFS：`allBfsDist / allBfsParent`
- 反向 CSR：`revStart/revSource`（当前路径查询主要用 BFS 树，反向边保留给已弃用的 reverse-BFS 逻辑/未来扩展）
- 支配树：`idom`、`domChildHead/domNext/domChildCount`
- `shallow`、`retained`、`topRetained`（前 500）
- `graphStats`：节点数、强引用边数、可达节点数、各阶段耗时

### 5.2 最短路径树

从 super-root 做 BFS，得到：

- `bfsParent[v]`：v 在强引用图上的下一跳（更靠近根）；
- `allBfsParent[v]`：包含弱引用边的版本。

`pathToRoot(id, includeWeak)` 直接沿父指针回溯，返回 `{found, path, distance, includeWeak}`。`path` 顺序是 **root → object**，每一行的 `via` 表示“上一个节点通过什么字段/根类型指向当前节点”。

### 5.3 支配树（Lengauer-Tarjan）

步骤：

1. 从 super-root DFS，得到 `dfn`、`vertex`、`parent`；
2. `semi/label/ancestor` + bucket 链表；
3. `evalNode()` 路径压缩；
4. 反向遍历求 semi，构建 bucket，`link`，处理父节点 bucket 求 idom；
5. 第二遍修正 idom；
6. 反向 dfn 累加 `retained[idom[v]] += retained[v]`；
7. 用 `domChildHead/domNext` 建支配树孩子索引，供树形浏览。

复杂度 O(E α)，本机 1.86M 节点 / 4.86M 强引用边约 4 s。

**已验证不变量**（强引用图）：

- `retained[0] == Σ shallow[reachable]`
- 所有可达节点 `retained[v] >= shallow[v]`
- 所有 `idom` 链最终到达 0，无环

### 5.4 Retained Size / 支配子树

- `retained[v]` = 支配子树内所有节点 shallow 之和；
- `retainedPage()` 取 `topRetained` 前 500，支持 ID/类名/最小 Retained 过滤；
- `domTree(parentId, offset, limit)` 遍历 `domChildHead`，按 retained 排序后分页，返回每个子节点的 `shallow/retained/children`；
- 注意：**支配树子节点不是“引用它的对象”**，而是被它支配/保活的对象。

### 5.5 类级 GC Root 路径

`classPaths(kind, id, limitObjects=20000, maxGroups=100, includeWeak=false)`：

1. 从 `members` 取该类全部对象 id；
2. 对每个对象沿 `bfsParent` 或 `allBfsParent` 回溯到 0；
3. 生成 `steps: [{className, via}]`（root → object）；
4. 按 `className + via` 序列拼 signature 分组；
5. 统计每组的 `count / shallow / samples`，按 count 降序；
6. 返回 `{totalObjects, scanned, reachable, unreachable, sampled, groupCount, groups}`。

UI 支持：

- **树形**：客户端按 steps 建前缀 trie，合并公共路径，缩进显示，节点后显示对象数；
- **文本**：逐组链条 + 示例对象。

### 5.6 引用查询

`referrers(target)` 全堆扫描实例字段、对象数组元素、类静态字段，最多 200 条 / 3 秒，返回 `{items, truncated, tookMs}`。这是“谁引用我”，与支配树/路径不同。

### 5.7 表头过滤

服务端过滤（先过滤再分页）：

- `instances(kind,id,page,size,{id,className,heap,minSize})`
- `stringsPage(page,size,{q,readable,id,minLength})`
- `rootsPage(page,size,{id,className,type,heap})`
- `retainedPage(page,size,{id,className,minRetained})`
- `/api/classes` 支持 `q/minCount/minBytes`

ID 过滤 `idMatches()` 支持十六进制（`0x` 可选）或十进制前缀匹配。

---

## 6. HTTP API

| 路径 | 说明 |
|---|---|
| `/api/summary` | 计数、类直方图、根统计、Top 类/字符串、分析耗时 |
| `/api/classes?q=&sort=bytes\|count\|name&minCount=&minBytes=` | 类直方图 |
| `/api/instances?kind=&id=&page=&size=&fid=&className=&heap=&minSize=` | 某类对象分页 |
| `/api/object?id=` | 对象/类详情，含 `retained` |
| `/api/referrers?id=` | 引用目标的对象 |
| `/api/strings?page=&size=&q=&readable=&fid=&minLength=` | 字符串 |
| `/api/roots?page=&size=&fid=&className=&type=&heap=` | GC Roots |
| `/api/retained?page=&size=&fid=&className=&minRetained=` | Retained 排行 |
| `/api/domtree?parent=&offset=&limit=` | 支配树某层子节点 |
| `/api/classpaths?kind=&id=&limit=&weak=1` | 类级 GC Root 路径分组 |
| `/api/path?id=&weak=1` | 最短 GC 路径 |
| `/api/health` | 健康检查 |

`/api/summary` 返回的 `analysis` 是 `graphStats`，不含完整类列表（类列表走 `/api/classes`）。

---

## 7. 前端

### 7.1 状态

```
state.summary / tab / classSort
state.objectFilter / objectPage / retainedPage / stringPage / rootPage
state.stringReadable
state.filters = {
  classes, objects, strings, roots, retained, tree
}
detailStack = [{id, scrollTop}]   // 详情历史
treeState = { root, returnDetail, children, expanded, loading }
classPathState = { kind,id,className,weak,mode,data }
```

### 7.2 表格过滤

HTML 表头第二行 `tr.filters` 的输入带 `data-filter="table.field"`；`app.js` 统一绑定：

- 更新 `state.filters[table][field]`；
- 按 table debounce 180ms；
- 重置对应页码并重新请求；
- 服务端过滤后分页。

支配树用工具栏 `#treeFilter`，只过滤当前已加载层的节点（不重新请求服务端）。

### 7.3 对象详情抽屉

- 打开：`openDetail(id, options)`，自动维护 `detailStack`；
- 引用跳转：push 新条目，保存上一个条目的滚动位置；
- `← 返回`：pop 并恢复滚动；只有一条时变成 `← 关闭`；
- `Alt+←` 返回，`Esc` 关闭；
- 切换页签会自动关闭抽屉；
- 抽屉左边缘可拖动改变宽度（CSS 变量 `--drawer-w`），双击复位，宽度存 localStorage；
- 字段引用是蓝色胶囊；weak referent 字段显示 `weak` 徽标。

### 7.4 支配树

- 懒加载：每层默认 100 个，`显示更多` 追加；
- `▸/▾` 展开/收起；点击行或 `›` 打开详情；
- “查看支配子树”会以当前对象为根重新加载；从详情进入时工具栏显示“返回对象详情”；
- “回到支配树根”返回全局根；
- 根的直接子节点可能几十万（大量对象被多个根共同支配），实际排查建议从 Retained 或对象详情进入子树。

### 7.5 类级路径弹窗

- 树形/文本按钮切换，不重新请求；
- “包含弱引用”切换会以 `weak=1` 重新请求；
- 树形模式用客户端 trie 合并公共前缀；
- 文本模式显示每组的示例对象，点击打开详情（关闭弹窗后进入详情抽屉）。

---

## 8. 已实现功能清单

- HPROF 1.0.3 / 4 字节大端解析：字符串、类、实例、对象数组、基本类型数组、根、堆区间
- 类直方图、对象浏览、字段详情、数组元素、String 内容
- 字符串可读性检测 / 过滤 / 搜索
- GC Roots 列表与根类型统计
- 支配树 / Retained Size（强引用图）
- 支配树树形懒加载浏览、子树入口、返回根
- 单对象最短 GC 路径（强引用 / 包含弱引用）
- 类级 GC Root 路径分组（强引用 / 包含弱引用）
- 类级路径树形缩进 / 文本两种展示
- 引用查询（谁引用我）
- 表头过滤：类、对象、字符串、Roots、Retained
- 对象详情历史返回、Esc/Alt+←、可拖拽宽度
- 点击态视觉：实心页签、行 hover 高亮、行尾 `›`、引用胶囊、主/次按钮
- 零第三方依赖、无构建步骤、Node 原生 HTTP

---

## 9. 验证记录

### 真实 dump 规模

| 指标 | 值 |
|---|---|
| 文件 | 129,501,003 B |
| 类 | 46,860 |
| 实例 | 1,312,746 |
| 对象数组 | 130,448 |
| 基本类型数组 | 370,209 |
| String 实例 | 211,996 |
| GC Roots | 367,567 |
| 图节点 | 1,860,264 |
| 强引用边 | 4,856,616 |
| 强引用可达 | 1,184,556 |
| 解析 | ~1.1 s |
| 支配树 | ~4.2 s |
| Node RSS | ~0.9 GB |

### 行为验证

- 表头：SurfaceControl 类对象 66 个，ID 输入 `9b16` 后 1 个；类过滤 `minCount=10000 & minBytes=1000000` 返回 8 个类；字符串 `minLength=10000` 返回 6 条。
- 弱引用：SurfaceControl 强引用可达 46、包含弱引用 50；弱引用独有对象强路径 `found=false`，`weak=1` 时 found、distance=4，链上出现 `referent (weak)`。
- 类级路径：SurfaceControl 66 对象 / 46 可达 / 45 组；树形与文本切换正常；勾选弱引用后 50 可达 / 43 组。
- 详情返回：A→B→返回 A；`Alt+←`、`Esc`；切换页签自动关闭。
- 抽屉拖拽：620px → 820px，localStorage 持久化。
- 支配树展开：根层 101 行（100 节点 + 显示更多），展开后 105 行。
- 类路径树形：公共前缀合并，根节点只出现一次。

---

## 10. 已知限制与设计取舍

1. **只支持 ART 4 字节 ID**；加载标准 JVM dump 会直接报错。
2. **支配树/Retained 只基于强引用**；弱/软/虚 `referent` 被排除。若要做“包含弱引用的支配树”，需要再算一遍完整图，当前未做。
3. **类级路径是 BFS 最短路径**，不是所有路径；同一对象可能还有其他合法链。
4. **类级路径采样**：默认只分析前 20000 个对象、展示前 100 组；超大类的统计不是全量。
5. **根的直接子节点可能几十万**，树形浏览需要从对象子树进入；根层用“显示更多”翻页。
6. **引用查询**是全堆扫描，默认 3 秒超时 / 200 条；包含弱引用边（因为它回答“谁引用我”，不是强可达性）。
7. **详情返回不缓存子面板**：返回上一个对象时，之前的“引用查询/路径”结果会丢失，只恢复滚动位置。
8. **浏览器前进/后退未接入**；应用内用 `← 返回` / `Alt+←` / `Esc`。
9. **概览的 Top 类表**是摘要，没有表头过滤；完整过滤在“类直方图”页。
10. **无持久化缓存**；每次启动重新解析/构图，约 5 秒。
11. **无自动化测试套件**；验证依赖 `stats.mjs`、JSON API 和 Edge CDP 脚本（已清理）。
12. **Windows 测试**：文件路径、localStorage、Edge headless 均按 Windows 验证；代码本身无平台特定逻辑。

---

## 11. 后续工作建议

- 增量/缓存：把索引与分析结果序列化，避免每次启动重算。
- 对象间最短引用路径（A→B），以及可选择根类型的最短路径。
- 弱引用包含模式下的支配树/Retained（可作为独立开关）。
- 类级路径做真正的路径 trie 服务端聚合，支持按根类型筛选。
- 详情子面板缓存（返回时保留引用/路径结果）。
- 表格列宽拖拽与持久化、虚拟滚动（超大表）。
- 多份 dump 差分（类/对象增长、泄漏对比）。
- 自动化测试：解析 fixture、支配树不变量、API 过滤、UI 关键交互。

---

## 12. 维护指南

### 新增一种 hprof 子记录

1. 在 `HEAP` 常量加 tag；
2. 在 `parseHeapSegment()` 中计算记录长度并推进 `p`（不要留下未消费字节）；
3. 需要展示时补 `objectKind/objectDetail` 分支；
4. 用真实 dump 跑 `stats.mjs` 确认没有 unknown subrecord；
5. 注意 4 字节 ID 与大端。

### 新增一个分析

1. 在 `analyze()` 内构建所需数组/图（尽量用 TypedArray + CSR，避免对象数组）；
2. 把结果挂到 `this`，并在 `graphStats` 里记录耗时；
3. 在 `server.mjs` 加只读路由；
4. 在 UI 用新面板/抽屉展示，避免阻塞主线程太久；
5. 在本文档第 8/9/10 节更新。

### 新增一个表头过滤

1. HTML 表头加 `tr.filters`，输入写 `data-filter="table.field"`；
2. 在 `state.filters[table]` 加字段；
3. 后端对应 API 接受参数并**先过滤再分页**；
4. 前端请求带上参数；页码重置已在通用绑定中处理。

### 性能与内存

- 解析 129 MB 约 1.1 s；分析约 4.2 s；RSS ~0.9 GB；
- 主要内存：文件 Buffer（~130 MB）、对象/类 Map、图 CSR（~40 MB）、支配数组；
- 更大的 dump 建议 `node --max-old-space-size=4096 src/server.mjs`；
- 不要在请求路径里做全图重算（一旦重算，整个服务会阻塞数秒）。

### 调试

```bash
node src/stats.mjs data\xxx.hprof
curl http://127.0.0.1:8787/api/summary
curl "http://127.0.0.1:8787/api/classpaths?kind=class&id=49980688&weak=1"
```

若 UI 行为异常，优先检查浏览器 Console；Node 端异常会直接返回 `{error}`。

---

## 13. 变更记录

- **2026-10-18**：实现 hprof 解析、类/对象/字符串/Roots API 与基础 Web UI；用 SystemUI dump 验证。
- **2026-10-18**：加入支配树（Lengauer-Tarjan）、Retained Size、单对象 GC Root 路径；修复对象数组 class id 偏移、BigInt 序列化、字符串解码等问题。
- **2026-10-19**：加入支配树树形懒加载、抽屉拖拽宽度、详情历史返回、点击态 UI 优化。
- **2026-10-19**：加入类级 GC Root 路径、弱引用默认排除与可选包含、表头过滤、类路径树形/文本切换、最短路径标签。

---

## 14. 关键参数

| 参数 | 值 | 位置 |
|---|---|---|
| 类级路径分析对象上限 | 20000 | `classPaths()` / `server.mjs` |
| 类级路径展示组上限 | 100 | `classPaths()` |
| 类级路径每组示例数 | 5 | `classPaths()` |
| Retained 排行 | 500 | `analyze()` |
| 支配树每层 | 100 | `app.js` `domtree` 请求 |
| 引用查询上限 | 200 条 / 3000 ms | `referrers()` |
| 表头过滤防抖 | 180 ms | `app.js` |
| 抽屉最小宽度 | 360 px | `app.js` / `styles.css` |
| 字符串 binary 阈值 | 异常字符 > 2%，长度 ≥ 8 | `isBinaryText()` |

---

## 15. 术语

- **Shallow Size**：对象自身占用（实例字段/数组元素），不含其引用对象。
- **Retained Size**：该对象被回收时能一并回收的支配子树大小。
- **Immediate Dominator**：从根到该对象的所有路径都必须经过的最近节点。
- **强引用视图**：排除 `Weak/Soft/PhantomReference.referent` 的可达性视图。
- **最短 GC 路径**：从 super-root 到对象的 BFS 最少边数路径。
- **类级路径**：对某类所有对象求最短 GC 路径后，按“类名 + 字段”链合并的视图。
