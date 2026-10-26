# DSH 插件（B 方案）

把 HPROF Explorer 做成 DeepSeek Harness 的原生能力：**引擎子进程 + `hprof_*` 工具 + 同源 HTTP 路由 + 原生 Web 面板**。解析器仍是 `src/hprof.mjs`，但不再需要启动 `server.mjs`。

设计与取舍见 [DESIGN.md](DESIGN.md)；通用 PTC seam 的延后方案见 [PTC_SEAM_PLAN.md](PTC_SEAM_PLAN.md)。

```
Harness Host
  └─ @local/dsh-hprof-explorer
       ├─ engine.mjs（每个 dump 一个子进程，stdin/stdout JSON 行协议）
       ├─ hprof_* 工具（模型）
       ├─ /hprof-api 路由（面板，走 connection 鉴权）
       └─ client.js（shell.overlay 里的原生 React 面板）
                                   │
                                   ▼
                         src/hprof.mjs（解析、支配树、路径）
```

每个 dump 一个引擎进程：129 MB 的 SystemUI dump 约占 0.9 GB，不会压在 Harness Host 上。

## 安装与生效

本机通过 DSH 的 `plugin_manager` 安装时：

```json
{ "action": "install_bundle", "target": "D:/Code/aosp/tools/hprof-explorer/dsh-plugin" }
```

### 另一台机器

插件不在 npm 上，必须连同 HPROF Explorer 仓库一起 clone；`src/hprof.mjs` 是解析器，不能只复制 `dsh-plugin/`。

```powershell
git clone https://github.com/BigSumBoy/hprof-explorer.git
cd hprof-explorer
dsh plugin --profile web add link:<clone-path>/dsh-plugin
```

例如 Windows：

```powershell
dsh plugin --profile web add link:D:/src/hprof-explorer/dsh-plugin
```

macOS / Linux：

```bash
dsh plugin --profile web add link:/Users/me/src/hprof-explorer/dsh-plugin
```

从 DSH 源码 checkout 运行时，把 `dsh` 换成 `pnpm dsh`：

```powershell
pnpm dsh plugin --profile web add link:D:/src/hprof-explorer/dsh-plugin
```

`link:` 很重要：插件默认把 `appDir` 设为自身包目录的上一级，也就是完整的 HPROF checkout。如果用了复制安装而不是 link，需要在 profile 的 `cordis.patch.yml` 里显式配置：

```yaml
- insert:
    - id: hprof-explorer
      name: '@local/dsh-hprof-explorer'
      config:
        appDir: 'D:/src/hprof-explorer'
```

安装后：

1. 重启 DSH Host；
2. 刷新 Web 页面；
3. 左侧边栏点 HPROF 图标打开主面板；
4. 选择或打开 hprof 文件。

插件依赖一个较新的 DSH；如果启动时报 `tools` / `webServer` / `conversation` 相关服务缺失，说明 DSH 版本太旧，需要升级到包含这些 slot 和服务接口的版本。HPROF 解析器本身没有 npm 依赖，不需要在仓库里 `npm install`。

已安装过的 `link:` 包更新代码后，需要：

1. **重启 DSH Host**（Node 模块已加载，配置热重载不会重新执行插件代码）；
2. **刷新 Web 页面**（Client 半需要重新拉取模块表）。

卸载：`plugin_manager` 的 `remove_bundle`，target `@local/dsh-hprof-explorer`；或 `dsh plugin --profile web remove @local/dsh-hprof-explorer`。

## 工具

| 工具 | 用途 |
|---|---|
| `hprof_api(op, params)` | **通用服务入口**：entity/query/paths/analyze/dump，先 `op: "capabilities"` 看完整操作清单 |
| `hprof_ptc(code)` | 在隔离子进程里执行 JS，注入 typed `hprof` namespace；plan-B 本地 runner |
| `hprof_annotate(action, ...)` | 创建/列出/更新/删除 finding；target 支持 object/class/path/field/dump |
| `hprof_ui(action, ...)` | 扁平、类型化的 UI 操作入口；`showClassPaths`/`showUnreachable` 等高层动作，`action="manifest"` 查看完整目录 |
| `hprof_open(path)` | 解析并打开 dump，返回 `dump_id`、计数、Top 类、Top Retained |
| `hprof_classes(query?, sort?, limit?)` | 类直方图，带 `id` / `kind` |
| `hprof_instances(class_id, kind?, ...)` | 某类对象分页；数组类型用 `kind: 'primitive'` |
| `hprof_object(id)` | 对象/类详情：字段、数组、String、retained、支配者 |
| `hprof_path(id, weak?)` | 最短 GC Root 路径 |
| `hprof_class_paths(class_id, kind?, weak?, page?, size?)` | 类级 GC Root 路径分组；分页返回全部链，带 holder id |
| `hprof_class_stats(class_id, kind?)` | 聚合实例数、可达/不可达、native 句柄、创建点、root/holder 分类 |
| `hprof_retained(class_filter?, min_retained?, ...)` | Retained Size 排行 |
| `hprof_strings(query?, min_length?, readable?, ...)` | 字符串搜索，可包含二进制内容 |
| `hprof_roots(type?, query?, ...)` | GC Roots 列表与类型过滤 |
| `hprof_referrers(id)` | 谁引用这个对象（全堆扫描，200 条/3 秒上限） |
| `hprof_diff(base, other)` | 两份 dump 的类级差分（增长/缩减/新增/消失） |
| `hprof_report(dump_id?, out_path?)` | 生成 Markdown 报告并写入文件 |
| `hprof_close(dump_id?)` | 结束引擎进程，释放内存 |

结果在渲染时截断到 7000 字符；`class_paths` 分页（默认 10 组/页，最多 10），每组返回紧凑的 `chain` 字符串和最多 5 个 `{id, holderId}` 样本；现在分页会覆盖全部组，不再在 100 组处截断；返回同时带 `totalObjects/reachable/unreachable/groupCount` 和最多 5 个不可达样本。`class_stats` 默认保留前 10 个创建点和前 10 个 holder 分类，完整引用链用 `class_paths` 翻页拿。UI 的类 GC 路径页会显示总数/可达/不可达，并单独列出不可达对象（分页，可点开对象详情）。

## 通用服务（hprof_api）

`service.mjs` 把 dump/entity/query/paths/analyze 做成一个领域服务（堆数据只读，findings 和 UI state 可变），`hprof_api` 是它在工具链上的投影：

```text
hprof_api(op="capabilities")
hprof_api(op="query.instances", params={class_id, fields:["mNativeObject","mCallsite"], page, size})
hprof_api(op="entity.fields", params={id})
hprof_api(op="entity.array", params={id, page, size})
hprof_api(op="entity.referrers", params={id})
hprof_api(op="paths.object", params={id})
hprof_api(op="paths.class", params={class_id, page, size})
hprof_api(op="analyze.classStats", params={class_id})
```

服务里的所有集合都支持分页；数组和字符串按页读取；对象/字段/数组元素都带 id，可以继续作为下一个调用的输入。新增能力先加 service 方法，再由 `hprof_api` 暴露，不再为每个分析写临时脚本或新工具。

## Findings

`findings.mjs` 按 **dump 文件 realPath 的 hash** 持久化 finding，不受 `dump-N` 变化影响；文件写在 `<appDir>/data/findings/<sha1>.json`。

```text
hprof_annotate(action="create", target={kind:"object", id:168770128}, title="...", note="...", severity="warn", tags=["surfacecontrol"])
hprof_annotate(action="create", target={kind:"path", ids:[168770128, 168770200]}, title="...")
hprof_annotate(action="create", target={kind:"field", id:168770128, field:"mSurfaceControl"}, title="...")
hprof_annotate(action="list")
hprof_annotate(action="update", id="f-...", severity="info")
hprof_annotate(action="delete", id="f-...")
```

UI 的分析区新增 **「发现」** tab：打开对象抽屉后切过去，target id 会自动带入；target 支持对象/类/路径/字段/整个 dump；可以填标题、note、severity、tags，列表里点「查看对象/类」跳转，点「编辑」直接改 note/severity/tags，点「删除」移除，顶部可按 severity 和 title/tag/note 搜索过滤。

`hprof_report` 现在会把当前 dump 的 findings 作为 `## Findings` 章节写进 Markdown，报告里包含 target、severity、tags 和 note。

## UI state

`ui-state.mjs` 是 Host 和 Web 面板之间的轻量桥：

- 每个面板生成一个 `client_id`，通过 `POST /hprof-api/ui/state` 上报 `dump_id/panel/tab/class/object/path/referrers/row/filters/page/sort/tree/classPaths`；
- 面板处理完命令后通过 `POST /hprof-api/ui/ack` 回报 `command_id/status`；`ui.state.command_status` 返回最近 10 条；
- `panel` 是 `workspace` 或 `sidebar`，多面板时用于区分；
- 过滤、分页、排序按 dump 文件路径写入 localStorage，切 tab 或刷新后恢复；
- 面板每 1.2s 拉 `GET /hprof-api/ui/commands?dump_id=...&client_id=...` 并执行；
- 命令可以带 `client_id` 定向到一个面板；不带则交给第一个轮询的面板；
- 多面板状态按 `(dump_id, client_id)` 分开保存，`ui.state` 没带 `client_id` 时返回最新状态和 `panels` 列表，不再互相覆盖；
- `ui.events` 读取有界事件账本（状态上报、命令、投递），但它还不是 session log。

```text
hprof_api(op="ui.state", params={})
hprof_api(op="ui.state", params={client_id:"panel-..."})
hprof_api(op="ui.command", params={action:"selectObject", params:{id:168770128}})
hprof_api(op="ui.command", params={client_id:"panel-...", action:"selectTab", params:{tab:"findings"}})
hprof_api(op="ui.command", params={action:"selectRow", params:{table:"classes", id:49980688}})
hprof_api(op="ui.command", params={action:"setFilters", params:{tab:"classes", filters:{query:"Surface"}}})
hprof_api(op="ui.command", params={action:"setPage", params:{tab:"instances", page:1}})
hprof_api(op="ui.command", params={action:"setSort", params:{tab:"classes", sort:"count"}})
hprof_api(op="ui.command", params={action:"toggleNode", params:{id:168770128}})
hprof_api(op="ui.command", params={action:"toggleNode", params:{view:"classpaths", key:"..."}})
hprof_api(op="ui.command", params={action:"draftMessage", params:{text:"总结：..."}})
hprof_api(op="ui.events", params={limit:50})
```

命令：`selectTab`、`selectRow`、`setFilters`、`setPage`、`setSort`、`setWeak`、`toggleNode`、`selectObject`、`selectClass`、`openDump`、`closeDump`、`closeDrawer`、`refresh`、`runReport`、`draftMessage`、`notice`。

`selectRow` 参数 `{table, id}`；`setFilters` 参数 `{tab, filters}`，会 remount 当前过滤 tab 并应用新条件；`setPage` 参数 `{tab, page}`；`setSort` 参数 `{tab:"classes", sort:"bytes"|"count"|"name"}`；`setWeak` 参数 `{weak}`；`toggleNode` 参数 `{id}` 切换支配树节点，或 `{view:"classpaths", key|index}` 切换类 GC 路径树节点；`draftMessage` 只填底部 Chat 草稿、不发送；`openDump` 带 `path` 时走真正的打开流程，带 `dump_id` 时只切换选择；`refresh`/`runReport`/`closeDump` 调用对应的 UI 操作。

### 模型优先用 hprof_ui

`hprof_ui` 是同一批 `ui.command` 的扁平类型化投影，其他电脑上的模型不需要读源码：

```text
hprof_ui(action="manifest")
hprof_ui(action="state")
hprof_ui(action="showClassPaths", class_id=1877222656, class_name="android.view.SurfaceControl", weak=true)
hprof_ui(action="showUnreachable", class_id=1877222656)
```

`showClassPaths` 会展开成 `selectClass → selectTab classpaths → setWeak?`，返回命令 id；它不复制 UI 逻辑。面板执行后会通过 `/ui/ack` 回报，`ui.state.command_status` 可确认 applied；`ui.state.classPaths` 返回 `weak/page/groupCount/reachable/unreachable/showUnreachable`。底层 `hprof_api(op="ui.command")` 和 PTC 的 `hprof.ui.command` 仍然保留，作为完整 escape hatch。`ui.state` 返回 `available_actions`，`ui.manifest` 返回每个 action 的参数、示例和展开步骤。

`row` 是当前表格选中的 `{table, id, className}`；`filters` 是当前 tab 的过滤条件；`page`/`sort` 是当前分页/排序；`classPaths` 是类路径页的 `weak/page/groupCount/reachable/unreachable/showUnreachable`；`tree.expanded`/`tree.collapsed` 是支配树/类路径树的展开与折叠状态。真正写入 `SessionEventMap` 还需要 Host 侧 session-event seam，当前先用 UI event ledger 代替。

### PTC（plan B，当前）

`hprof_ptc` 在 **独立子进程** 的 `vm` context 里执行一段 JS：

```js
const classes = await hprof.query.classes({ query: 'SurfaceControl' })
const stats = await hprof.analyze.classStats({ class_id: classes.items[2].id })
const paths = await hprof.paths.class({ class_id: classes.items[2].id, page: 0, size: 10 })
console.log('groups', paths.groups.length)
return { total: stats.totalObjects, groups: paths.groups.length }
```

程序只看到 `hprof` 和 `console`；每次 `hprof.*` 调用都通过 JSON-line RPC 回到 Host service，值在边界做 JSON 克隆；没有 `fs`、`process`、`require`、shell；Host 负责 20 秒超时（最多 60 秒）、结果/日志上限和进程清理。它是插件本地的 plan-B runner，不是 DSH 的 `run_code`。

通用 PTC binding-provider seam（plan A，改 DSH core）的设计记录在 [PTC_SEAM_PLAN.md](PTC_SEAM_PLAN.md)，当前未实现。

完整分析一个类不需要写脚本：

1. `hprof_classes(query)` 找到 class id；
2. `hprof_class_stats(class_id)` 得到实例数、可达性、native/released、创建点和 holder 分类；
3. `hprof_class_paths(class_id, page, size)` 翻页拿全部引用链和 holder id；
4. `hprof_object(holder_id)` 查 holder 的字段状态（如 `mIsActive`、`mTaskInfo`）。

## 主工作区（推荐）

左侧栏出现 **HPROF** 图标；点击进入主工作区，中央面板被替换为：

- **左侧**：完整分析 UI（和侧栏 tab 同一套组件，含 dump 选择、页签、抽屉）；
- **右侧**：**完整 Chat**，直接渲染 DSH 的 `conversation.content` factory（不是紧凑摘要），和当前会话共享消息、草稿、审批弹窗、工具卡片；左侧发出 `hprof_open` 后点左侧「刷新」就能看到这个 dump；
- **中间分隔条**：可拖拽，分析区/对话区比例存 `localStorage`（25%–70%）；
- **`← 对话`**：工作区左上角返回普通对话；从左侧栏选择会话也会回到对话。

入口：

- 左侧栏 **HPROF** 图标打开主工作区；
- 输入框下方的 **HPROF** 按钮现在也直接打开工作区。

**面板模型**：主面板是 `main` 的 keyed 条目 `hprof`，由 `ctx.layout.selectPanel('hprof')` 选中，`selectPanel(null)` 返回对话；它不属于右侧栏 tab 的地址模型，`activePanelId` 是布局状态。右侧栏 tab 仍然保留，作为快速并排视图（有自己的紧凑对话面板）。

## 右侧栏 tab

Client 半注册一个**右侧栏页面类型**（`kind: 'hprof'`），并进入右侧栏的 guide。打开方式：展开右侧栏，在 guide 里点 **HPROF Explorer**。

**地址模型**：页面类型不声明 `patterns`，tab 的 `contentId` 是 `sidebar-right` 为页面分配的地址（`dsh-resource://…`），不是 dump 地址；每个 pane 只保留一个 HPROF tab，重复打开会聚焦已有 tab。当前选中的 dump 是 tab 内状态，通过 `openTab('hprof', { params: { dumpId } })` 可以在打开时指定，`tab.navigation.params` 变化会让 tab 切换到对应 dump。选中状态不写入布局；刷新后 tab 恢复，自动选第一个已打开的 dump。

tab 内布局：

- **头部**：dump 选择、hprof 路径输入、打开/关闭/报告；
- **tab 条**：概览 / 类 / Retained / 字符串 / Roots / 支配树 / 差分；
- **主区 + 右侧对象抽屉**：对象详情不占 tab，从列表打开一个可拖拽宽度的抽屉（320–900px，宽度存 `localStorage`），带对象历史返回；`Esc` 关闭、`Alt+←` 返回上一个对象；
- **表头过滤**：每张表在列标题下有一行输入框，服务端过滤后分页，支持多条件组合：
  - 类：类名 / class·primitive / 最小实例 / 最小字节；
  - 对象：id 前缀 / 类名 / 堆 / 最小字节；
  - 字符串：id 前缀 / 最小长度 / 内容；
  - Roots：id 前缀 / 根类型 / 类名 / 堆；
  - Retained：id 前缀 / 类名 / 最小 Retained；
- **详情缓存**：对象、路径、引用查询、类路径、支配树的结果按请求 URL 缓存在内存里，返回或重新打开同一个对象不再请求；打开/关闭 dump 时清空；
- **底部对话**：tab 底部是一个可折叠、可拖拽高度的会话面板（默认 200px，存 `localStorage`）。输入问题回车发送，消息走当前会话的主输入框（追加后提交），因此主对话和面板里都能看到回复；勾选「带上当前 dump」会在消息前附带 dump_id 和文件路径，方便我直接调用 hprof 工具。面板里的工具行只保留工具名和结果摘要，完整卡片在主对话里看。

表格不做固定行高虚拟滚动：每页 100–200 行，长类名和字符串正常换行，避免被省略号截断。

视觉上按区域分层：分析区用品牌色顶线和「分析」色标，对话区用绿色顶线/圆点，表头 13px 主文字色 + 2px 品牌分隔线，行线用 `border-l2`，配完整列线和隔行浅色；页面顶部有 16px 页标题和底线，Overview 的区块标题 14px，Tab 13px。对象抽屉左侧有品牌色边。按钮分主操作（品牌填充）、次操作（描边）、危险操作（红色文字，如关闭 dump）和幽灵操作（返回/收起）；可点击行有 hover 和手型，行点击是**选中**（品牌色底 + 左侧竖条，再次点击取消），打开走行尾「查看」按钮或双击；对象引用和「GC 路径」等链接用品牌色并在 hover 时下划线。表头文本过滤统一是放大镜图标 +「搜索类名」「搜索内容」等占位，数字过滤在输入框左侧显示「≥」，占位提示最小值。

具体功能：

- **概览**：计数卡片、Top 类、Top Retained、根类型分布、Top 字符串；
- **类**：排序、多条件过滤，点击进入对象列表；行内“GC 路径”；
- **对象抽屉**：String 内容、字段/数组、Shallow/Retained、支配者；引用可点击跳转；GC 路径/引用查询/支配子树/类路径入口；
- **GC 路径**：最短链，支持包含弱引用；
- **类路径**：树形/文本两种视图，弱引用开关，完整组翻页；顶部显示总数/可达/不可达，并可展开查看不可达对象明细（无 GC Root 路径，可点开对象详情）；
- **Retained**：排行、id/类名/最小 Retained 过滤、分页；
- **字符串**：id/内容搜索、最小长度、只看可读文本、分页；
- **Roots**：按 id/根类型/类名/堆过滤，点击进入对象；
- **支配树**：从根或任意对象出发的懒加载树，逐层展开、显示更多、按类名/ID 过滤当前层，可返回对象详情；
- **引用查询**：列出引用者与字段/下标；
- **差分**：选择两个 dump，显示计数变化、增长最多的类、新增类；
- **报告**：一键生成 Markdown 并显示落盘路径。

面板不用 iframe，直接 `fetch('/hprof-api/...')`，颜色来自 `--dsw-alias-*` 主题 token。文案目前是写死的中文；正式发布应接入 Client locale 字典。

## 路由

`/hprof-api` 前缀路由，由 Host 插件注册，先过 `ctx.connection.requestRejection()`（Host/Origin + 浏览器 cookie 鉴权）：

| 方法 | 路径 |
|---|---|
| GET | `/dumps`、`/summary`、`/classes`、`/instances`、`/object`、`/path`、`/classpaths`、`/retained`、`/domtree`、`/strings`、`/roots`、`/referrers`、`/diff` |
| POST | `/open`、`/close`、`/report` |

## 开发时重载

- **Host 半**：`index.js`、`service.mjs`、`engine.mjs`、`findings.mjs`、`ui-state.mjs`、`ui-manifest.mjs` 在 DSH 进程启动时加载一次。修改后必须重启 Host；`patchReload: live` 只重载配置，不重新执行 Node 模块。
- **Client 半**：`client.js` 可以在页面硬刷新后重新加载；如果启用了 client HMR/dev watcher，也可以不刷新。没有 watcher 时用 `Ctrl+Shift+R`。
- **Parser / engine**：新的 dump 会启动新的 engine 子进程，因此 `src/hprof.mjs` / `engine.mjs` 的修改可能在新 dump 上生效；但 Host 的 service/tool 代码仍是旧的，不要依赖这一点。
- **减少重启的边界**：把 Host 工具契约稳定在 `hprof_api` / `hprof_ui` / `/ui/*`，之后纯视觉、文案、布局的 UI 改动只动 `client.js`，刷新即可。只有新增 Host action、改 service 返回结构或改 routes 时才需要重启。
- **不要在生产 profile 做 Host 热重载**；没有可靠的模块级 reload，强行做会留下旧模块、旧子进程和旧 tool schema。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `appDir` | 本包上一级 | 含 `src/hprof.mjs` 的 HPROF Explorer 根目录 |
| `nodePath` | `process.execPath` | 引擎进程使用的 Node（Desktop 下需指向真正的 node） |
| `nodeArgs` | `[]` | 例如 `['--max-old-space-size=4096']` |
| `maxDumps` | `3` | 同时打开的 dump 数，超出按最久未用淘汰 |
| `startTimeoutMs` | `180000` | 解析 + 支配树的上限 |
| `requestTimeoutMs` | `60000` | 单个查询上限 |
| `profileTimeoutMs` | `180000` | 差分时取类 profile 的上限 |
| `idleTimeoutMs` | `0` | 闲置自动关闭；`0` 表示不自动关闭；正数毫秒 |
| `maxPageSize` | `200` | 列表上限 |
| `workspaceRoot` | 进程 cwd | 无会话 cwd 时相对路径的基准 |

默认不因空闲关闭 dump，适合长时间分析。需要自动回收时在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: hprof-explorer
  config:
    idleTimeoutMs: 3600000
```

`maxDumps` 仍默认 3；超过时按最久未用淘汰。

## 已验证

```text
node dsh-plugin/smoke.mjs
open: 129501003 bytes, 46860 classes, 1312746 instances, parse 1290 ms
classes: top byte[] (20583579 bytes)
instances: 211996 total for java.lang.String
class_paths: 591 groups
primitive instances: 287484 for byte[]
retained: miui.systemui.controlcenter.panel.PreloadManager 543203 bytes
object: instance miui.systemui.controlcenter.panel.PreloadManager
path: 8 hops
strings: 14 matches
roots: 1124 JNI_GLOBAL
referrers: 2
report: 3041 bytes
routes: ok
diff: ok
close: ok
SMOKE OK
```

```text
node dsh-plugin/client-smoke.mjs
CLIENT SMOKE OK
```

Smoke 覆盖：引擎协议、18 个工具（diff 用合成 profile 验证聚合）、`class_stats` 的 native/released 聚合、`class_paths` 分页与 holder id、`hprof_api` 的 query/entity/paths/analyze 投影、`hprof_ui` 的 manifest/高层动作展开、`hprof_ptc` 的绑定调用/日志/错误隔离、`hprof_annotate` 的持久化 CRUD、`/hprof-api` 的 dumps/summary/classes/object/path/domtree/strings/roots/referrers/findings/ui-state/ui-events/report、Client 的 tab 类型、guide、body、composer、`main` 工作区、`hprof.conversation` 与 `sidebar.panellist` 注册。工作区的 Chat 渲染、拖拽分隔、表格选中/过滤上报需要在浏览器里人工验证。

## 限制

- **重启才生效**：已加载的 Host 不会重新执行 `index.js`；Client 改动通常硬刷新即可。
- **差分内存**：两份 129 MB dump 约 2 GB；`maxDumps` 默认 3。差分按类聚合，不比较单个对象 id。
- **阻塞式 open**：解析和支配树同步跑在引擎里，`hprof_open` 会等到 ready；取消 turn 会中止等待并杀掉引擎。
- **直接 spawn**：没走 `ctx.subprocess` seam，不继承沙箱/SSH；这是本地工具的取舍。
- **tab 选中状态不持久化**：dump 选择在 tab 内，刷新后回到第一个已打开的 dump；`params.dumpId` 只在打开时生效。工作区的 dump 选择是面板内状态。
- **dump_id 是运行时实例编号**：`dump-N` 不是文件版本；每次重新拉起引擎都会分配新编号，所以同一文件重开后会递增。Host 重启、显式配置的引擎闲置超时（默认关闭，按最后一次查询续期）或被 `maxDumps` 淘汰后，旧编号就无效了。面板监听 `connection/reset` 和 `unknown dump_id` 错误，自动刷新 `/dumps`、切换或清空选择；最近一次成功打开的路径存在 `localStorage`，列表为空时会自动重新解析（大 dump 约几秒），但**每个页面会话/每次重连后最多自动恢复一次**，之后显示「重新打开」横幅，避免每次进入面板都静默新建一个 dump。手动关闭 dump 会清掉这个路径。
- **工作区的 Chat 依赖当前选中会话**：没有选中会话时右列显示占位；权限审批、图片、完整工具卡片在右列（完整 Chat）里直接出现，不再是摘要。
- **侧栏 tab 的紧凑对话**：仍走 `insertText` + `submit`，主输入框已有草稿时会追加；完整对话请用主工作区。
- **扩展工具需要重载**：在对话里让我改插件代码可以，但 Host 侧的 `index.js`/`engine.mjs` 改动要重启 DSH 才生效；临时查询可以用现有工具或 PTC，持久的新工具建议在创造模式里做成 bundle 安装。
- **`appDir` 依赖**：插件运行时从 `appDir` 动态 import 解析器，移动仓库要同步改配置。

## 下一步

1. 差分增加 retained 维度与 CSV 导出；
2. 工具接入 PTC，让模型用 `run_code` 批量查询多个类；
3. 面板文案接入 Client locale 字典；
4. 把 dump 选择写进 tab 地址（resource 类型），让不同 dump 可以并排开多个 tab。
