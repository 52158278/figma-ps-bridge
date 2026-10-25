# t5 端到端验证 + 三端契约交叉核对报告

日期：2026-10-23 · 验证者：verifier · 契约：[docs/multi-doc-spec.md](../docs/multi-doc-spec.md)
验证对象快照（三端均已完成、成员 idle）：`bridge/server.py 22:49`、`figma-plugin/ui.html 22:51`、`ps-cep/js/main.js 22:51`、`code.js 22:53`、`index.jsx 22:49`、`deploy.ps1 22:45`。

## 1. 命令与结果

| 检查 | 命令 | 结果 |
|---|---|---|
| B1 | `py -m py_compile bridge/server.py` | 通过（exit 0） |
| B2 | `py tools/e2e_multi.py --port 18765` | **8/8 全部通过**（exit 0） |
| F1 | `node --check figma-plugin/code.js` | 通过（exit 0） |
| P1 | `node --check ps-cep/js/main.js` | 通过（exit 0） |
| 附加 | `node --check`（ui.html 内联脚本、index.jsx 副本） | 通过（exit 0） |
| 附加 | `node -e "JSON.parse(manifest.json)"` | 通过 |
| 附加 | PowerShell AST 解析 `deploy.ps1` | 通过 |
| 附加 | 补充契约探针（临时脚本，13 项） | **13/13 通过** |

B2 明细（`tools/e2e_multi.py`，隔离临时目录启动 v0.2.0 服务）：
1. 3 个 job、3 张不同尺寸 PNG 上传后全部 `pending`
2. 连续 claim 3 个 → 3 个同时 `editing`
3. 3 个 `editing` 时 `GET /api/ps/pending` 响应无 `busy` 字段
4. touch 续租有效；`EDIT_TIMEOUT_SEC=2` 停 touch 后约 15.0s 三个 job 均回 `pending`
5. 每个 job PUT result 后 `/api/jobs/watch?ids=…` 约 1.0s 唤醒并返回 `ready`（不等满 25s）
6. 正确 `updatedAt` 的 ack → `done`，`result.png` 删除（GET result=404）
7. 旧 `updatedAt` 的 stale ack → `{ok:false,stale:true}`、状态仍 `ready`、`result.png` 仍在
8. 心跳后 `psOnline=true`，停止心跳 8 秒后 `false`

补充探针（e2e 未覆盖的契约细节，全部通过）：
health 版本 0.2.0 / 初始 psOnline=false；`watch?ids=` 与不存在 id 立即返回空；public job 不含 `lastTouch`；`GET /api/ps/jobs`；`status?wait=` 长轮询；touch 不改 `updatedAt`；正确 ack 同时删 source/result；`done` 后 PUT result 可再回 `ready`；多 id watch 任一变化唤醒；ack 无 body → done；keep-alive 同连接 POST body 不污染后续请求；状态页 v0.2.0；重启后 `editing→pending` 且 `jobs.json version=2`、source.png 保留。

## 2. 三端契约交叉核对

### 2.1 后端路由 ↔ 前端调用方

| 路由 | 服务端 | 调用方 | 结论 |
|---|---|---|---|
| GET `/` | 状态页 | 浏览器手动 | 保留 |
| GET `/api/health` | ✓ | figma ui.html `findServer/checkHealth`；ps main.js `detectServer`；deploy.ps1 | ✓ |
| POST `/api/ps/heartbeat` | ✓ | ps main.js `sendHeartbeat` | ✓ |
| GET `/api/ps/pending` | ✓（保留） | 无新客户端（旧版兼容用） | 合规保留 |
| GET `/api/ps/jobs` | ✓ | ps main.js `fetchJobs` | ✓ |
| GET/POST `/api/jobs` | ✓ | ps main.js 旧桥回退 GET；figma ui.html `uploadOne` POST | ✓ |
| GET `/api/jobs/<id>` | ✓ | ps main.js `loadSessionMeta/ensureSession` | ✓ |
| GET `/api/jobs/<id>/status?wait=` | ✓（保留） | 无新客户端 | 合规保留 |
| PUT `/api/jobs/<id>/image` | ✓ | figma ui.html `uploadOne` | ✓ |
| GET `/api/jobs/<id>/image` | ✓ | ps main.js `openJob` | ✓ |
| PUT `/api/jobs/<id>/result` | ✓ | ps main.js `sendSession` | ✓ |
| GET `/api/jobs/<id>/result` | ✓ | figma ui.html `attemptApply` | ✓ |
| POST `/api/jobs/<id>/ack` | ✓ | figma ui.html `ackResult` | ✓ |
| POST `/api/jobs/<id>/fail` | ✓ | figma ui.html `stopEntry/uploadOne`；ps main.js `openJob` 失败/`cancelSession` | ✓ |
| POST `/api/jobs/<id>/claim` | ✓ | ps main.js `openJob`、`touchDueSessions` 夺回 | ✓ |
| POST `/api/jobs/<id>/touch` | ✓ | ps main.js `touchJob` | ✓ |
| GET `/api/jobs/watch?ids=&wait=` | ✓ | figma ui.html `coordinatorStep` | ✓ |

前端调用的每个路径后端均已实现；无改名残留（`/api/ps/busy`、`/api/jobs/pending` 等不存在）。

### 2.2 Figma 消息类型对齐（code.js ↔ ui.html）

| 方向 | 类型 | 两侧 |
|---|---|---|
| UI→主线程 | `send-request` `apply-result` `request-selection` `find-target` `load-jobs` `save-jobs` | 全部一致 |
| 主线程→UI | `boot` `selection` `send-payloads` `jobs` `target-found` `target-missing` `fallback-created` `apply-done` `diag` | 全部一致 |

- `apply-result` 必带 `jobId`（ui.html:661；code.js:376 校验，缺失/不在注册表 → `apply-done{ok:false,error:"任务已失效"}`）。
- `apply-done` 主线程在串行 Promise 队列后回发（code.js:366-390）。
- 旧死类型 `notify/error/send-payload/pending-job/load-pending/save-pending` 已无协议残留（`figma.notify` 是 Figma API，不是消息类型）。

### 2.3 PS 宿主函数对齐（main.js ↔ index.jsx）

| 函数 | 调用（main.js） | 定义（index.jsx） | 返回格式 |
|---|---|---|---|
| `figmaBridgeOpenImage(path, jobId)` | :381 | :68 | `OK:<docId>\|<docName>` ✓ |
| `figmaBridgeActiveDoc()` | :327 | :86 | `OK:<docId>\|<docName>` / `ERR:` ✓ |
| `figmaBridgeListDocs()` | :829 | :95 | `OK:<id>\|<name>\|<jobId>;…` ✓ |
| `figmaBridgeReadMarkerActive()` | :343 | :107 | `OK:<jobId>` / `OK:` / `ERR:` ✓ |
| `figmaBridgeSavePng(path, docId)` | :398 | :116 | `OK:<w>x<h>` / `ERR:NOT_FOUND` / `ERR:` ✓ |

所有入口 `displayDialogs=NO` + `finally` 恢复（index.jsx:14-35）；手写 `;`/`|` 序列化并清洗名字（:38-40）；`SavePng` 找不到 docId 时绝不回退 `activeDocument`（:116-136）。

### 2.4 契约第 6 章 10 条跨端不变量

| # | 不变量 | 判定 | 依据 |
|---|---|---|---|
| 1 | 一个 job 同一时刻只对应一份 PS 文档（marker） | 成立 | 打开时写 `doc.info.jobName=figma-bridge:<jobId>`（index.jsx:76），文档列表按 marker 登记（main.js:779-823）；同 marker 用户手动复制文档属外部操作 |
| 2 | 任意多个 job 可同时 editing | 成立 | e2e 第 2 条；server 无全局 busy |
| 3 | ack 带 updatedAt，且仅回写成功后调用 | 成立 | ui.html:720-727（先 apply-done ok 再 ack）、:738-742（body 带 updatedAt）；stale 分支服务端只读不删 |
| 4 | Figma appliedAt 只在 apply-done ok 后前移 | 成立 | ui.html:721；done 分支按 4.3 刷新（:607） |
| 5 | PS 保存只认活动文档且必须有 marker | 成立 | `saveActive` 先 `hostActiveDoc`+`hostReadMarkerActive`，无 marker 直接报错（main.js:994-1026）；5.4「全部回传」按契约用 docId |
| 6 | 定位一律 docId，禁止回退 activeDocument | 成立 | index.jsx:116-136；main.js 无 docId 直接报错 |
| 7 | 输入/导出临时文件必须删除 | 成立 | 输入 main.js:682-688/714-721；导出 :983-990；启动清理 :1204-1233 |
| 8 | 面板重开：带 marker 的文档都会重新登记 | 成立 | 启动 + 每 3s `restoreFromDocuments/applyDocList`（:825-849、:1311） |
| 9 | PSD 存盘重开 marker 随 XMP 保留 | 成立（沿用既有机制） | 写/读 `doc.info.jobName`（index.jsx:46、76） |
| 10 | 心跳用 POST `/api/ps/heartbeat`，不用 health | 成立 | main.js:412-426；health 只读 |

### 2.5 残留专项排查

| 项 | 结果 |
|---|---|
| `apply-result` 不带 jobId | 无（仅 ui.html:659-676，带 jobId） |
| `ack` 不带 updatedAt | 无（唯一 ack 调用 ui.html:738-742 带 body） |
| 回退 `activeDocument` 导出 | 无（index.jsx `figmaBridgeSavePng` 只按 docId 查找） |
| 临时文件不删 | 无（见不变量 7） |
| `busy` 字段 | 前后端均无（server 不返回，客户端不读；`hostBusy` 是面板内部串行标志） |
| 旧 `pendingJob`/死消息类型 | 仅剩 clientStorage 旧 key 迁移（契约要求） |

## 3. 范围检查（git status / diff --stat）

工作区改动均在预期归属内，未发现越界修改：

| 文件 | 归属 |
|---|---|
| `bridge/server.py`、`bridge/启动桥接.bat`、`deploy.ps1` | t1（仅 Python 检测 + 桥接实现） |
| `figma-plugin/code.js`、`figma-plugin/ui.html` | t2 |
| `ps-cep/js/main.js`、`ps-cep/host/index.jsx`、`ps-cep/index.html` | t3 |
| `docs/multi-doc-spec.md`（untracked） | 契约 |
| `tools/e2e_multi.py`（untracked） | t4 |

`README.md` 未修改 —— 属 t6 范围（当前仍是旧的单任务接口表/版本描述）。`bridge/.data/` 为空目录且被 gitignore。

## 4. 缺陷清单

> 结论：**无阻断性缺陷**，B1/B2/F1/P1/F2 全部通过。以下 6 条为低风险问题，建议在 t6 文档收尾前顺手修掉；不阻塞文档任务。

### D1（低，建议优先）GC 孤儿目录清理与「新建任务」竞态，可能删掉新任务的图片目录
- 文件：`bridge/server.py:405`（`known = set(JOBS)`）、`:412-422`（listdir + rmtree）
- 问题：`known` 快照在释放 `JOBS_LOCK` 后使用；而 `create_job` 在加锁前就 `os.makedirs(job_dir)`（:372）。GC 在 `known` 快照与 `os.listdir` 之间遇到新任务时，会把这个新目录当孤儿目录删除。随后 `PUT /api/jobs/<id>/image` 写 `source.png` 会抛 `FileNotFoundError` → 500，任务卡在 `awaiting-image`。
- 影响：概率极低（GC 每 10 分钟一次，窗口毫秒级；若有大量过期目录 rmtree 会更宽），但后果是丢源图/任务卡死，属数据面问题。
- 建议：删除孤儿目录前在锁内复查 `name not in JOBS`；或只删 `mtime` 超过一个 GC 周期（如 10 分钟）的目录；`create_job` 也可把 `makedirs` 移入锁内。

### D2（低）PS 面板端口探测不校验响应内容，可能连到非桥接服务
- 文件：`ps-cep/js/main.js:1187`（`await getJson('/api/health')`）
- 问题：任何 200 且 JSON 可解析的响应都会被当成桥接服务（未校验 `ok`/`version`）；Figma 侧同类逻辑有 `data.ok` 校验（ui.html:404）。
- 影响：8765-8774 若被别的本地服务占用且恰好回 200 JSON，面板显示「已连接」但所有业务接口失败、只会在日志里刷连接错误。
- 建议：探测时校验 `data && data.ok === true`（可再校验 `data.version`）。

### D3（低）旧桥兼容分支用 `/api/health` 当心跳，实际不会刷新 psOnline
- 文件：`ps-cep/js/main.js:414-425`（回退 `getJson('/api/health')`）
- 问题：新版 health 是只读的（契约要求）；旧版 0.1.0 的 health 同样不刷新 `LAST_PS_SEEN`（旧实现只在 `/api/ps/pending`、`PUT result` 里刷新）。因此该兼容分支不会让 `psOnline` 变 true，与日志「面板先按旧接口运行」的暗示不符。
- 影响：仅「新面板 + 旧桥接」混用场景，PS 在线指示灯在首次回传前误显示离线；提示升级的日志仍在。
- 建议：旧桥回退改用旧心跳端点 `GET /api/ps/pending`（注意它会领取任务，可接受再判断），或把日志改成明确「旧桥不支持心跳，请升级」。

### D4（低）Figma fallback 新建图层的容器类型超出契约，COMPONENT_SET 下可能一直回写失败
- 文件：`figma-plugin/code.js:20`（`CONTAINER_TYPES`）、`:498-507`（`containerFor`）、`:467`（`appendChild`）
- 问题：契约 4.5 只允许追加到 `PAGE/FRAME`，实现额外允许 `SECTION/COMPONENT/COMPONENT_SET`。`COMPONENT_SET` 的子级只允许 `COMPONENT`，向它 `appendChild(RECTANGLE)` 可能抛错 → `apply-done ok:false` → 按 2s→30s 无限退避重试；向 `COMPONENT` 追加则会改动主组件内容，与原逻辑（落当前页）不同。
- 影响：选中「无图片填充的 component variant」等边缘场景时，PS 回传无法落图且日志反复报错；正常 PAGE/FRAME 场景不受影响。
- 建议：与契约对齐（只 PAGE/FRAME/SECTION），或至少排除 `COMPONENT_SET`，并在 `appendChild` 失败时降级到当前页后重试一次。

### D5（低）CEP 扩展版本号仍 0.1.0，与项目 0.2.0 不一致
- 文件：`ps-cep/CSXS/manifest.xml:4`、`:8`（`ExtensionBundleVersion` / `Extension Version`）
- 问题：spec §7 版本为 0.2.0，bridge `VERSION=0.2.0`，但 CEP 清单仍 0.1.0。
- 影响：PS「扩展」信息/升级判断显示旧版本，发布一致性差；功能无影响。
- 建议：同步为 `0.2.0`（t3 或 t6 顺手改）。

### D6（低，健壮性）Figma UI 等待注册表无超时，极端情况下发送按钮永久「发送中」
- 文件：`figma-plugin/ui.html:164-165`（`registryReady`）、`:504`（`await registryReady`）
- 问题：`registryReady` 只在收到 `jobs` 消息时 resolve；若 `load-jobs` 回包丢失（主线程异常/消息通道异常），发送会永久挂起，只能重开插件。
- 影响：低概率（`loadJobs` 正常总会回包），但用户侧表现为卡死。
- 建议：给 `registryReady` 加 3–5s 超时，超时后按空注册表继续并可提示重试。

### 观察项（非缺陷，供决策）
1. `main.js:1003-1004` 的「活动文档 docId」与「marker jobId」是两次 host 调用，理论上用户在这两次之间切换文档会把 A 文档的图回传给 B 任务。这是契约 5.3 规定的两步流程固有竞态；若想彻底消除，可让 ExtendScript 一次返回 `docId|docName|jobId`。
2. `code.js:155-160` 对 `fileKey` 不一致只做警告、不阻止：换 Figma 文件后旧任务若回传，可能在新文件里生成 fallback 图层。契约未规定不一致时的行为，建议 t6 在 README「已知限制」里说明。
3. Figma 侧 `done` 任务需点「继续等待」才会重新监听（契约 4.3/4.6 设计）；PSD 隔天重开再覆盖的链路需要一个手动动作，建议 README 明确写出。
4. `GET /api/ps/pending` 与 `PUT result` 仍会刷新心跳（旧面板兼容），契约未禁止；新面板走 heartbeat。

---

# t10 回归结论（D1–D6 关闭验证，2026-10-23）

> 本节追加在 t5 原始清单之后，原始内容未改动。验证快照：server.py 23:04:23（t1+t7）、code.js 23:04:10 / ui.html 23:04:33（t2+t9）、main.js 23:06:08 / CSXS manifest 23:04:31（t3+t8）；README 由 t6 同期更新，不参与 D1–D6 判定。

## 1. 命令与结果

| 检查 | 结果 |
|---|---|
| `py figma-ps-bridge/tools/e2e_multi.py --port 18765` | 首次因 18765 被其它进程瞬时占用，脚本按设计快速失败（exit 1，明确提示端口占用）；重试 **8/8 PASS，exit 0** |
| `py -m py_compile figma-ps-bridge/bridge/server.py` | exit 0 |
| `node --check figma-ps-bridge/figma-plugin/code.js` | exit 0 |
| `node --check figma-ps-bridge/ps-cep/js/main.js` | exit 0 |
| `node --check`（ui.html 内联脚本，抽出 26941 字符） | exit 0 |
| CEP 清单 XML 解析（ElementTree） | 可解析；`ExtensionBundleVersion=0.2.0`、`Extension Version=0.2.0` |
| `deploy.ps1` PowerShell AST 解析 | 无语法错误 |

## 2. D1–D6 逐条判定

| 编号 | 状态 | 验证方式与证据 |
|---|---|---|
| D1 | **已关闭** | **import 级独立测试 4/4**：临时导入 server.py，4 线程并发建 200 个 job + 写 source.png，同时 2 个线程每 1ms 调 `gc_once()` → 0 丢目录 / 0 丢图 / 0 异常；旧孤儿（11 分钟）删除、新孤儿（10 分钟内）保留、有 job 记录的旧目录保留；构造「目录先存在（已旧）→ 之后登记 job」的交错，目录与记录均保留，移除记录后才删除；GC TTL 删除过期 done 记录+目录、jobs.json version=2 仍可解析。**HTTP 级测试**：临时导入 server.py 起真实 Handler，4 线程 × 30 次 `POST /api/jobs` + `PUT image`，同时 2 线程每 1ms 调 `gc_once()` → created=120、errors=0、missing_dir=0、missing_src=0，压测后再 PUT 20 个仍全 200（无 PUT image 500）。代码：`server.py:375-385` 登记+建目录同锁；`:407-420` 过期目录在锁内删；`:427-445` 老目录 mtime>600s 先跳过、再锁内复查 `name in JOBS` 后才 rmtree。 |
| D2 | **已关闭** | 代码走查：`main.js:1205-1213` detectServer 必须 `health.ok === true` 且 `health.version` 为非空字符串才采纳（`{ok:false}`、缺 version、非 JSON 均跳过），:1217 采纳日志带版本；`:420-424` sendHeartbeat 也校验 `data.ok === true`。grep/阅读确认没有「任意 200 JSON 即采纳」的旧逻辑；文件 `node --check` 通过（t8 任务另有 13 项离线仿真记录）。 |
| D3 | **已关闭** | 代码走查：`main.js:432-443` 收到 404 时设置 `legacyBridge=true` + `statusPrefix`，日志只提示一次「桥接服务版本过旧，请重新运行部署器或用新版启动」，并明确注释**故意不调用 `/api/health` 兜底**；`:171-174` `setStatus` 给状态栏加固定前缀；`:425-431` 心跳恢复 0.2.0 后清除前缀并记恢复日志；`:1277-1283` 换服务地址时重置。grep 确认 `/api/health` 仅出现在 detectServer（:1205），sendHeartbeat 无 health 回退。 |
| D4 | **已关闭** | 代码走查：`code.js:20` 仅 `PAGE/FRAME/GROUP/SECTION`；`:509-520` 非法父级（COMPONENT_SET/COMPONENT/BOOLEAN_OPERATION/INSTANCE/已删除）降级 `(pageOf(target) || currentPage)`、原点 0,0；`:465/487-494` 仍用 `absoluteBoundingBox` 页面绝对坐标；`:467-478` appendChild 失败先 `rect.remove()` 再抛错；`:375-390` catch 统一回 `apply-done ok:false`。`ui.html:160/173` `MAX_APPLY_FAILURES=3`；`:743-756` 第 3 次失败置 `state=failed` + `cancelRetry` + 不 ack + 明确日志；`:764` 成功清零；`:844/:876/:902` stop/继续等待/清空同步清理。grep 全量确认无绕过：`attemptApply` 仅 `:627/:813` 且先校验 watching，`scheduleRetry` 仅 `:771`，`ackResult` 仅成功路径 `:769`。t11 独立 mock（Node vm + fake figma）5/5：非法父级 4/4 降级、COMPONENT_SET 实际 append 到 PAGE 且 rect.x=270/rect.y=40、appendChild 失败 remove、target null 兜底；两文件自 t11 评审后未再变化。 |
| D5 | **已关闭** | `ps-cep/CSXS/manifest.xml` XML 解析通过，`:4 ExtensionBundleVersion="0.2.0"`、`:8 Extension Version="0.2.0"`（与 bridge `VERSION=0.2.0` 一致）。 |
| D6 | **已关闭** | 代码走查：`ui.html:161` `REGISTRY_TIMEOUT_MS=4000`；`:537-553` `waitRegistry()` 4 秒超时 resolve(false)，正常 resolve(true) 并清定时器；`:501-535` 超时 log「读取任务列表超时，请重开面板」后 return（发生在 `ensureBase/uploadOne` 之前，不创建任务），`finally :530-534` 恢复 `sending=false` + 重绘按钮。t11 评审 pass，两文件自评审后未变化。 |

## 3. 补充契约探针回归（t5 的 13 项）

用临时脚本重新跑 13/13 **全部通过**（临时复制 server.py 起隔离服务，跑完删除）：
health 0.2.0 + 初始 psOnline=false；`watch?ids=` 与不存在 id 立即返回空；public job 不含 lastTouch；`/api/ps/jobs`；`status?wait` 长轮询；touch 不改 `updatedAt`；正确 updatedAt 的 ack 删 source/result；done 后 PUT result 可回 ready；多 id watch 任一变化唤醒；ack 无 body → done；keep-alive 同连接 POST body 不串包；状态页 v0.2.0；重启后 editing→pending 且 jobs.json version=2、图片保留。条件 ack / touch / watch 空 ids / keep-alive 四项均 PASS。

## 4. 范围与残留

- `git status --short` / `git diff --stat`：改动仅 `README.md`（t6）、`bridge/server.py`（t1+t7）、`bridge/启动桥接.bat` 与 `deploy.ps1`（t1）、`figma-plugin/code.js`/`ui.html`（t2+t9）、`ps-cep/js/main.js`/`host/index.jsx`/`index.html`（t3+t8）、`ps-cep/CSXS/manifest.xml`（t8），以及新增 `docs/`、`tools/`；无越界文件。
- 临时测试脚本均在 `%TEMP%`，已删除；`py_compile` 生成的 `bridge/__pycache__` 已清理；未写入仓库 `bridge/.data`，无残留服务进程。

## 5. 回归结论

**D1–D6 六条全部关闭**，e2e 8/8、三端语法/清单静态检查全过、13 项补充探针全过、D1 另有 import 级与 HTTP 级并发独立复测通过。未发现新缺陷或回归。首次 e2e 的端口占用为其它进程瞬时占用（非产品问题），重试即 8/8。t6 的 README 在本次验证时仍在更新，不影响 D1–D6 与三端代码结论。
